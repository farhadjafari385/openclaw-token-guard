// End to end: the real plugin (index.js) loaded with a stub SDK and a fake OpenClaw runtime, the real
// board CLI (bin/oc-inbox) on a temporary board, and fake GitLab and Telegram APIs. It walks one item
// through the team's flow: queue order, brief lines, local checks before a push, "RESULT: waiting",
// the CI watch moving the item on, the next gate, agents waking the orchestrator, the run budget.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.join(PLUGIN, "..");

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tg-e2e-"));
  const dir = path.join(root, "plugin");
  fs.mkdirSync(dir);
  for (const f of fs.readdirSync(PLUGIN)) if (f.endsWith(".js") || f.endsWith(".json")) fs.copyFileSync(path.join(PLUGIN, f), path.join(dir, f));
  const sdk = path.join(root, "node_modules", "openclaw");
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sdk, "package.json"), JSON.stringify({ name: "openclaw", type: "module", exports: { "./plugin-sdk/plugin-entry": "./entry.js" } }));
  fs.writeFileSync(path.join(sdk, "entry.js"), "export const definePluginEntry = (entry) => entry;\n");
  const tb = path.join(root, "node_modules", "typebox");
  fs.mkdirSync(tb, { recursive: true });
  fs.writeFileSync(path.join(tb, "package.json"), JSON.stringify({ name: "typebox", type: "module", main: "index.js" }));
  fs.writeFileSync(path.join(tb, "index.js"), "export const Type = { Object: (p) => ({ type: 'object', properties: p }), String: (o) => ({ type: 'string', ...o }), Boolean: (o) => ({ type: 'boolean', ...o }), Optional: (x) => x };\n");
  fs.mkdirSync(path.join(root, "state"));
  fs.writeFileSync(path.join(root, "bot.token"), "123:test");
  return root;
}

const board = (root, ...args) => execFileSync("python3", [path.join(REPO, "bin", "oc-inbox"), ...args], { env: Object.assign({}, process.env, { OC_INBOX_FILE: path.join(root, "inbox.jsonl") }) }).toString().trim();
const status = (root, id) => JSON.parse(board(root, "list", "--json")).find((i) => i.id === id).status;
const settle = () => new Promise((r) => setTimeout(r, 600)); // board moves run the CLI asynchronously
// Wait (up to 10 s) for something asynchronous: a board move through the CLI, a post through the queue.
const until = async (check, ms = 10000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); return check(); };

const brief = (id, extra = "Model: sonnet-5\nEffort: low") =>
  `Project: shop (/srv/shop)\nScope: in: the checkout page only; out: everything else. ${"Context for the worker. ".repeat(20)}\n` +
  `Items:\n- ${id}\nDone when: the page renders the price and the tests pass\nStop if: it needs a production change\n${extra}`;

test("one item flows through the team: queue, brief, checks, CI watch, next gate, wakes, budgets", async () => {
  const root = harness();
  process.env.OC_INBOX_FILE = path.join(root, "inbox.jsonl");
  process.env.OC_INBOX_BIN = path.join(REPO, "bin", "oc-inbox");
  const A = board(root, "add", "--project", "shop", "--title", "Checkout shows the price", "--owner", "writer", "--done-when", "price visible", "--by", "system");
  const B = board(root, "add", "--project", "shop", "--title", "Pricing page copy", "--owner", "writer", "--done-when", "copy live", "--by", "system");
  board(root, "set", A, "--status", "todo", "--by", "system");
  board(root, "set", B, "--status", "todo", "--by", "system");
  board(root, "set", B, "--rank", "2", "--by", "system");
  board(root, "set", A, "--rank", "1", "--by", "system");

  // fake GitLab and Telegram
  let pipeline = "running";
  const telegram = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith("https://api.telegram.org/")) {
      telegram.push(JSON.parse(opts.body || "{}"));
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1000 + telegram.length } }) };
    }
    if (u.startsWith("https://gitlab.com/api/v4/projects/g%2Fshop/merge_requests/5")) return { ok: true, json: async () => ({ head_pipeline: { status: pipeline } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };

  // fake OpenClaw runtime
  const handlers = {};
  const services = [];
  const tools = [];
  const runs = [];
  const logs = [];
  const api = {
    pluginConfig: {
      orchestratorAgent: "coordinator",
      requireBriefFields: ["Project:", "Scope:", "Items:", "Done when:", "Stop if:", "Model:", "Effort:"],
      briefCheckAgents: ["coordinator"],
      board: { enabled: true, requireItems: true, agent: "product", wip: 1, projectOrder: ["shop"], view: false },
      topics: { enabled: false },
      projects: { shop: { topic: 151, path: "/srv/shop" } },
      mirror: { enabled: true, chatId: "-100", systemTopic: 160, defaultTopic: 160, projectTopics: { shop: 151 }, minIntervalMs: 0,
        botTokenFiles: Object.fromEntries(["coordinator", "writer", "reviewer", "product", "qa"].map((a) => [a, path.join(root, "bot.token")])) },
      jobs: { stateFile: path.join(root, "state", "jobs.json"), scanEverySeconds: 15, idleWakeSession: "agent:coordinator:explicit:team-ops",
        ci: { pollSeconds: 1, maxWaitMinutes: 150 } },
      triage: { enabled: false },
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug: () => {} },
    on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
    registerService: (s) => services.push(s),
    registerTool: (t, o) => tools.push({ t, o }),
    runtime: { subagent: {
      run: async (p) => { runs.push(p); return { runId: `r${runs.length}` }; },
      waitForRun: async () => ({ status: "ok" }),
      getSessionMessages: async () => ({ messages: [] }),
      deleteSession: async () => ({}),
    } },
  };
  const entry = (await import(pathToFileURL(path.join(root, "plugin", "index.js")).href)).default;
  entry.register(api);
  let tick;
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn) => { tick = fn; return { unref() {} }; };
  for (const s of services) if (s.start) s.start();
  globalThis.setInterval = realSetInterval;
  const realNow = Date.now;
  let skew = 11 * 60000; // past the 10-minute boot grace
  Date.now = () => realNow() + skew;
  const call = (name, event, ctx) => { let out; for (const h of handlers[name] || []) out = h(event, ctx) ?? out; return out; };
  const ORC = { agentId: "coordinator", sessionKey: "agent:coordinator:telegram:group:-100:topic:151", runId: "run-1" };
  const spawn = (task, agentId = "writer") => call("before_tool_call", { toolName: "sessions_spawn", params: { agentId, task, label: "shop: checkout price" } }, ORC);

  try {
    // 1. the queue: B is not next
    let r = spawn(brief(B));
    assert.equal(r && r.block, true);
    assert.match(r.blockReason, /not next in the queue. Next: .*Checkout shows the price/);
    // 2. a brief without Model: and Effort: lines is refused
    r = spawn(brief(A, ""));
    assert.equal(r && r.block, true, "brief without Model/Effort must be refused");
    assert.match(r.blockReason, /Model:|Effort:/);
    // 3. the head of the queue starts, on the brief's model and effort
    r = spawn(brief(A));
    assert.ok(r && !r.block, `dispatch of the head refused: ${r && r.blockReason}`);
    assert.equal(r.params.model, "anthropic/claude-sonnet-5");
    assert.equal(r.params.thinking, "low");
    const child = "agent:writer:subagent:t1";
    call("after_tool_call", { toolName: "sessions_spawn", params: r.params, result: { childSessionKey: child } }, ORC);
    await settle();
    assert.equal(status(root, A), "in_progress");
    // 4. the worker may push only after running the project's checks
    const W = { agentId: "writer", sessionKey: child, runId: "w1" };
    const exec = (command) => call("before_tool_call", { toolName: "exec", params: { command } }, W);
    r = exec("git -C /srv/shop push -u origin agent/a");
    assert.equal(r && r.block, true);
    assert.match(r.blockReason, /pipeline steps locally/);
    assert.ok(!(exec("npm run lint") || {}).block);
    assert.ok(!(exec("npm test") || {}).block);
    assert.ok(!(exec("git -C /srv/shop push -u origin agent/a") || {}).block, "push after checks must pass");
    // 5. the worker ends with RESULT: waiting and the MR link: the item stays in hand
    call("llm_output", { assistantTexts: ["I pushed and opened the MR.\n\nRESULT: waiting\nMR: https://gitlab.com/g/shop/-/merge_requests/5"] }, W);
    call("subagent_ended", { targetSessionKey: child, outcome: "ok", endedAt: Date.now() }, {});
    await settle();
    assert.equal(status(root, A), "in_progress");
    const job = JSON.parse(fs.readFileSync(path.join(root, "state", "jobs.json"), "utf8")).jobs[child];
    assert.equal(job.waitFor.kind, "gitlab-mr");
    // 6. nothing new starts while A is in hand
    r = spawn(brief(B));
    assert.equal(r && r.block, true);
    assert.match(r.blockReason, /one item at a time/);
    // 7. CI still running: nothing moves; CI green: A goes to Review and the orchestrator is woken
    await tick();
    await settle();
    assert.equal(status(root, A), "in_progress");
    pipeline = "success";
    skew += 5000;
    await tick();
    await settle();
    assert.equal(status(root, A), "review");
    const ciWake = runs.find((p) => /^\[ci\]/.test(p.message));
    assert.ok(ciWake, "the orchestrator was not woken after CI");
    assert.match(ciWake.message, /success/);
    assert.equal(ciWake.sessionKey, "agent:coordinator:explicit:team-ops");
    assert.ok(await until(() => telegram.some((m) => /CI passed/.test(m.text || ""))), "no CI post in the thread");
    // 8. the next gate on the item in hand is allowed
    r = spawn(brief(A), "reviewer");
    assert.ok(r && !r.block, `next gate refused: ${r && r.blockReason}`);
    // 9. an agent wakes the orchestrator, once per 10 minutes
    const factory = tools.find((x) => typeof x.t === "function" && x.o && x.o.name === "wake_orchestrator").t;
    assert.equal(factory({ agentId: "coordinator", sessionKey: "agent:coordinator:main" }), null);
    const wake = factory({ agentId: "writer", sessionKey: child });
    let w = await wake.execute("1", { reason: "blocked", message: "The MR needs a staging token." });
    assert.equal(w.details.ok, true);
    assert.ok(runs.some((p) => /^\[agent wake\] writer/.test(p.message)));
    w = await wake.execute("2", { reason: "blocked", message: "again" });
    assert.equal(w.details.ok, false);
    // 10. one orchestrator run is capped at 60 tool calls; telling the owner stays allowed
    const R2 = Object.assign({}, ORC, { runId: "run-cap" });
    let last;
    for (let i = 0; i < 61; i++) last = call("before_tool_call", { toolName: "task_inbox", params: { action: "list" } }, R2);
    assert.equal(last && last.block, true);
    assert.match(last.blockReason, /limit for one orchestrator run/);
    const msg = call("before_tool_call", { toolName: "message", params: { action: "send", message: "status" } }, R2);
    assert.ok(!(msg && msg.block));
    // 11. the queue file shows the item in hand
    const q = JSON.parse(fs.readFileSync(path.join(root, "state", "queue.json"), "utf8"));
    assert.deepEqual(q.inHand.map((i) => i.id), [A]);
    assert.equal(q.queue[0].id, B);
  } finally {
    Date.now = realNow;
    for (const s of services) if (s.stop) s.stop();
  }
});

test("the PM board audit waits out a Claude limit and never reports a failed run as 'nothing to fix'", async () => {
  const root = harness();
  const inbox = path.join(root, "inbox.jsonl");
  process.env.OC_INBOX_FILE = inbox;
  process.env.OC_INBOX_BIN = path.join(REPO, "bin", "oc-inbox");
  // a To do item without a Done when: a serious board problem, so the audit is due
  fs.writeFileSync(inbox, JSON.stringify({ kind: "add", id: "aa11bb22", project: "shop", title: "Checkout copy", owner: "writer", status: "todo", ts: new Date().toISOString() }) + "\n");

  const telegram = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).startsWith("https://api.telegram.org/")) {
      telegram.push(JSON.parse(opts.body || "{}"));
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 2000 + telegram.length } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const LIMIT = "⚠️ You've hit your weekly limit. Try again later: reset in 5 hours.";
  let auditResult = { status: "error", error: LIMIT };
  let auditText = "";
  const runs = [];
  const handlers = {};
  const services = [];
  const api = {
    pluginConfig: {
      orchestratorAgent: "coordinator",
      board: { enabled: true, requireItems: true, agent: "product", wip: 1, projectOrder: ["shop"], view: false },
      topics: { enabled: false },
      projects: { shop: { topic: 151, path: "/srv/shop" } },
      mirror: { enabled: true, chatId: "-100", systemTopic: 160, defaultTopic: 160, projectTopics: { shop: 151 }, minIntervalMs: 0,
        botTokenFiles: Object.fromEntries(["coordinator", "product"].map((a) => [a, path.join(root, "bot.token")])) },
      jobs: { stateFile: path.join(root, "state", "jobs.json"), scanEverySeconds: 15, idleWakeSession: "agent:coordinator:explicit:team-ops" },
      triage: { enabled: false },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
    registerService: (s) => services.push(s),
    registerTool: () => {},
    runtime: { subagent: {
      run: async (p) => { runs.push(p); return { runId: `r${runs.length}` }; },
      waitForRun: async () => auditResult,
      getSessionMessages: async ({ sessionKey }) => ({ messages: /board-audit/.test(sessionKey) && auditText ? [{ role: "assistant", content: auditText }] : [] }),
      deleteSession: async () => ({}),
    } },
  };
  const entry = (await import(pathToFileURL(path.join(root, "plugin", "index.js")).href)).default;
  entry.register(api);
  let tick;
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn) => { tick = fn; return { unref() {} }; };
  for (const s of services) if (s.start) s.start();
  globalThis.setInterval = realSetInterval;
  const realNow = Date.now;
  let skew = 11 * 60000;
  Date.now = () => realNow() + skew;
  const audits = () => runs.filter((p) => /:board-audit-/.test(p.sessionKey));
  const headsUps = () => runs.filter((p) => /^\[PM heads-up\]/.test(p.message || ""));
  const boardPosts = () => telegram.filter((m) => /Board check/.test(m.text || ""));
  const state = () => JSON.parse(fs.readFileSync(path.join(root, "state", "jobs.json"), "utf8"));
  try {
    // 1. the audit runs and the provider refuses it on the limit
    await tick();
    await settle();
    assert.equal(audits().length, 1);
    assert.equal(boardPosts().length, 0, "a failed audit must not post 'Board check ... nothing to fix'");
    assert.equal(headsUps().length, 0, "a failed audit must not wake the orchestrator");
    const limitUntil = state().claudeLimitedUntil;
    assert.ok(limitUntil > Date.now(), "the limit in the failed audit must be recorded");
    // 2. during the limit: no new audit, even once the 30-minute retry is due
    skew += 31 * 60000;
    assert.ok(Date.now() < limitUntil);
    await tick();
    await settle();
    assert.equal(audits().length, 1, "no audit while Claude is limited");
    // 3. after the reset the audit runs again (it is not pushed back 3 hours) and reports
    skew += Math.max(0, limitUntil - Date.now()) + 60000;
    auditResult = { status: "ok" };
    auditText = "Added a Done when to aa11bb22.";
    await tick();
    await settle();
    assert.equal(audits().length, 2, "the audit must run again after the reset");
    assert.ok(await until(() => boardPosts().length === 1), "the audit's report was not posted");
    assert.match(boardPosts()[0].text, /Added a Done when/);
    assert.equal(headsUps().length, 1);
  } finally {
    Date.now = realNow;
    for (const s of services) if (s.stop) s.stop();
  }
});

test("two plugin copies: a CI wait ended by one copy does not leave the item locked in the other", async () => {
  const root = harness();
  process.env.OC_INBOX_FILE = path.join(root, "inbox.jsonl");
  process.env.OC_INBOX_BIN = path.join(REPO, "bin", "oc-inbox");
  const A = board(root, "add", "--project", "shop", "--title", "Checkout shows the price", "--owner", "writer", "--done-when", "price visible", "--by", "system");
  board(root, "set", A, "--status", "todo", "--by", "system");
  const C = board(root, "add", "--project", "shop", "--title", "Footer links", "--owner", "writer", "--done-when", "links work", "--by", "system");
  board(root, "set", C, "--status", "todo", "--by", "system");
  board(root, "set", A, "--rank", "1", "--by", "system");
  board(root, "set", C, "--rank", "2", "--by", "system");

  const pipelines = { 5: "running", 6: "running" };
  const telegram = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith("https://api.telegram.org/")) {
      telegram.push(JSON.parse(opts.body || "{}"));
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 3000 + telegram.length } }) };
    }
    const mr = /merge_requests\/(\d+)$/.exec(u);
    if (u.startsWith("https://gitlab.com/api/v4/projects/g%2Fshop/") && mr) return { ok: true, json: async () => ({ head_pipeline: { status: pipelines[mr[1]] } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const runs = [];
  const copy = () => {
    const handlers = {};
    const services = [];
    const api = {
      pluginConfig: {
        orchestratorAgent: "coordinator",
        requireBriefFields: ["Project:", "Scope:", "Items:", "Done when:", "Stop if:", "Model:", "Effort:"],
        briefCheckAgents: ["coordinator"],
        board: { enabled: true, requireItems: true, agent: "product", wip: 1, projectOrder: ["shop"], view: false },
        topics: { enabled: false },
        projects: { shop: { topic: 151, path: "/srv/shop" } },
        mirror: { enabled: true, chatId: "-100", systemTopic: 160, defaultTopic: 160, projectTopics: { shop: 151 }, minIntervalMs: 0,
          botTokenFiles: Object.fromEntries(["coordinator", "writer", "product"].map((a) => [a, path.join(root, "bot.token")])) },
        jobs: { stateFile: path.join(root, "state", "jobs.json"), scanEverySeconds: 15, idleWakeSession: "agent:coordinator:explicit:team-ops",
          ci: { pollSeconds: 1, maxWaitMinutes: 150 } },
        triage: { enabled: false },
      },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
      registerService: (s) => services.push(s),
      registerTool: () => {},
      runtime: { subagent: {
        run: async (p) => { runs.push(p); return { runId: `r${runs.length}` }; },
        waitForRun: async () => ({ status: "ok" }),
        getSessionMessages: async () => ({ messages: [] }),
        deleteSession: async () => ({}),
      } },
    };
    return { api, handlers, services, call: (name, event, ctx) => { let out; for (const h of handlers[name] || []) out = h(event, ctx) ?? out; return out; } };
  };
  const entry = (await import(pathToFileURL(path.join(root, "plugin", "index.js")).href)).default;
  const old = copy(); // the copy that serves the agents' tool calls
  entry.register(old.api);
  const cur = copy(); // the newest copy: it runs the ticks (CI watch)
  entry.register(cur.api);
  let tick;
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn) => { tick = fn; return { unref() {} }; };
  for (const s of cur.services) if (s.start) s.start();
  globalThis.setInterval = realSetInterval;
  const realNow = Date.now;
  let skew = 11 * 60000;
  Date.now = () => realNow() + skew;
  const ORC = { agentId: "coordinator", sessionKey: "agent:coordinator:telegram:group:-100:topic:151", runId: "run-1" };
  const spawn = (id, n) => old.call("before_tool_call", { toolName: "sessions_spawn", params: { agentId: "writer", task: brief(id, `Model: sonnet-5\nEffort: low\nRun ${n}.`), label: `shop: ${n}` } }, ORC);
  const pushAndWait = async (id, n, mr) => {
    const r = spawn(id, n);
    assert.ok(r && !r.block, `dispatch of ${id} refused: ${r && r.blockReason}`);
    const child = `agent:writer:subagent:${n}`;
    old.call("after_tool_call", { toolName: "sessions_spawn", params: r.params, result: { childSessionKey: child } }, ORC);
    await until(() => status(root, id) === "in_progress");
    old.call("llm_output", { assistantTexts: [`Pushed.\n\nRESULT: waiting\nMR: https://gitlab.com/g/shop/-/merge_requests/${mr}`] }, { agentId: "writer", sessionKey: child, runId: `w${n}` });
    old.call("subagent_ended", { targetSessionKey: child, outcome: "ok", endedAt: Date.now() }, {});
    await settle();
    return child;
  };
  const jobs = () => JSON.parse(fs.readFileSync(path.join(root, "state", "jobs.json"), "utf8")).jobs;
  try {
    // 1. A is pushed and waits for CI; the CI watch (newest copy) sees the pipeline fail and moves A to To do
    const childA = await pushAndWait(A, "t1", 5);
    assert.ok(jobs()[childA].waitFor && !jobs()[childA].waitFor.done);
    pipelines[5] = "failed";
    skew += 5000;
    await tick();
    assert.ok(await until(() => status(root, A) === "todo"), "a failed pipeline moves the item back to To do");
    assert.ok(await until(() => jobs()[childA].waitFor.done), "the CI wait is marked done");
    // 2. the old copy still holds the wait as open in memory: re-dispatching A to fix CI must be allowed
    const r = spawn(A, "t2");
    assert.ok(r && !r.block, `fixing a failed pipeline was refused: ${r && r.blockReason}`);
    // 3. a stale save that drops "done" (what happened live) does not lock the item, and is not re-posted
    const d = JSON.parse(fs.readFileSync(path.join(root, "state", "jobs.json"), "utf8"));
    delete d.jobs[childA].waitFor.done;
    delete d.jobs[childA].waitFor.checkedAt;
    fs.writeFileSync(path.join(root, "state", "jobs.json"), JSON.stringify(d));
    const posts = telegram.filter((m) => /CI failed/.test(m.text || "")).length;
    skew += 5000;
    await tick();
    await settle();
    assert.ok(await until(() => jobs()[childA].waitFor.done), "the merge restores the finished wait");
    assert.equal(telegram.filter((m) => /CI failed/.test(m.text || "")).length, posts, "the finished pipeline was reported again");
    // 4. a wait whose item was moved on by hand (here: Blocked) ends quietly and frees the item
    board(root, "set", A, "--status", "blocked", "--note", "parked", "--by", "system");
    board(root, "set", C, "--rank", "1", "--by", "system");
    board(root, "set", A, "--rank", "5", "--by", "system");
    const childC = await pushAndWait(C, "t3", 6);
    board(root, "set", C, "--status", "blocked", "--note", "owner decision needed", "--by", "system");
    skew += 5000;
    await tick();
    await until(() => (jobs()[childC].waitFor || {}).done);
    assert.equal(jobs()[childC].waitFor.done.state, "left hand");
    assert.equal(status(root, C), "blocked", "the item stays where it was put");
    const r2 = spawn(C, "t4");
    assert.ok(!(r2 && r2.blockReason && /already being worked on/.test(r2.blockReason)), `C is still locked: ${r2 && r2.blockReason}`);
  } finally {
    Date.now = realNow;
    for (const s of cur.services) if (s.stop) s.stop();
  }
});
