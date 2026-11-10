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
      graphs: { enabled: true, root: path.join(root, "graphs"), bin: "graphify", budget: 1500, projects: ["shop"] },
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
  fs.mkdirSync(path.join(root, "graphs", "shop", "graphify-out"), { recursive: true });
  fs.writeFileSync(path.join(root, "graphs", "shop", "graphify-out", "graph.json"), "{}");
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
    assert.match(r.params.task, /Code map \(required before you search or read code\): graphify query .* --graph .*\/graphs\/shop\/graphify-out\/graph.json/);
    const child = "agent:writer:subagent:t1";
    call("after_tool_call", { toolName: "sessions_spawn", params: r.params, result: { childSessionKey: child } }, ORC);
    await settle();
    assert.equal(status(root, A), "in_progress");
    // 4. the worker may push only after running the project's checks
    const W = { agentId: "writer", sessionKey: child, runId: "w1" };
    const exec = (command) => call("before_tool_call", { toolName: "exec", params: { command } }, W);
    // 4a. code map first: a search is refused until the task has queried the project's map once
    r = exec("rg -n price src/");
    assert.equal(r && r.block, true, "a search before the map query is refused");
    assert.match(r.blockReason, /query the code map first: graphify query .* --graph .*\/graphs\/shop\/graphify-out\/graph.json/);
    assert.ok(!(exec(`graphify query "checkout price" --graph ${root}/graphs/shop/graphify-out/graph.json --budget 1500`) || {}).block);
    assert.ok(logs.some((l) => /queried its code map/.test(l)), "the map query is recorded");
    assert.ok(!(exec("rg -n price src/") || {}).block, "searching is open after the map query");
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

test("a dispatch the runtime refuses is logged and named in the team topic once, without a limit guess", async () => {
  const root = harness();
  process.env.OC_INBOX_FILE = path.join(root, "inbox.jsonl");
  process.env.OC_INBOX_BIN = path.join(REPO, "bin", "oc-inbox");
  const telegram = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).startsWith("https://api.telegram.org/")) {
      telegram.push(JSON.parse(opts.body || "{}"));
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 4000 + telegram.length } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const handlers = {};
  const logs = [];
  const api = {
    pluginConfig: {
      orchestratorAgent: "coordinator",
      board: { enabled: true, requireItems: true, agent: "product", wip: 1, view: false },
      topics: { enabled: false },
      mirror: { enabled: true, chatId: "-100", systemTopic: 160, defaultTopic: 160, minIntervalMs: 0,
        botTokenFiles: { coordinator: path.join(root, "bot.token") } },
      jobs: { stateFile: path.join(root, "state", "jobs.json"), idleWakeSession: "agent:coordinator:explicit:team-ops", refusal: { enabled: false } },
      triage: { enabled: false },
    },
    logger: { info: (m, x) => logs.push([m, x]), warn: (m, x) => logs.push([m, x]), error: (m, x) => logs.push([m, x]), debug: () => {} },
    on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
    registerService: () => {},
    registerTool: () => {},
    runtime: { subagent: { run: async () => ({ runId: "r" }) } },
  };
  const entry = (await import(pathToFileURL(path.join(root, "plugin", "index.js")).href)).default;
  entry.register(api);
  const call = (event) => { for (const h of handlers.after_tool_call || []) h(event, { agentId: "coordinator", sessionKey: "agent:coordinator:main" }); };
  const refused = (agentId) => ({
    toolName: "mcp__openclaw__sessions_spawn",
    params: { agentId, task: "Project: shop\nItems: aa11bb22" },
    result: { content: [{ type: "text", text: JSON.stringify({ status: "error", role: agentId,
      error: `sessions_spawn model "anthropic/claude-sonnet-5-5" is not usable: The selected account or native runtime is unavailable for anthropic/claude-sonnet-5-5. Restore that account before spawning this model.` }) }] },
  });
  call(refused("qa"));
  assert.ok(await until(() => telegram.some((m) => /Dispatch to qa failed/.test(m.text || ""))), "the refused dispatch was not named in the team topic");
  const note = telegram.find((m) => /Dispatch to .* failed/.test(m.text || ""));
  assert.equal(note.message_thread_id, 160);
  assert.match(note.text, /native runtime is unavailable/);
  assert.match(note.text, /no usage limit recorded/);
  assert.ok(logs.some(([m]) => /dispatch failed/.test(m) && /"agentId":"qa"/.test(m)), "the health check reads this log line");
  // the same failure again, for another agent: no second post within 30 minutes (the log still records it)
  call(refused("reviewer"));
  await settle();
  assert.equal(telegram.filter((m) => /Dispatch to .* failed/.test(m.text || "")).length, 1);
  assert.equal(logs.filter(([m]) => /dispatch failed/.test(m)).length, 2);
  // the guard's own refusals are plain text: not reported as a runtime failure
  call({ toolName: "sessions_spawn", params: { agentId: "qa" }, result: "token-guard: aa11bb22 is not next in the queue." });
  await settle();
  assert.equal(logs.filter(([m]) => /dispatch failed/.test(m)).length, 2);
});

test("a dispatch refused by OpenClaw's login check: the login is checked again and the orchestrator sends it again", async () => {
  const root = harness();
  process.env.OC_INBOX_FILE = path.join(root, "inbox.jsonl");
  process.env.OC_INBOX_BIN = path.join(REPO, "bin", "oc-inbox");
  // a fake `openclaw` that records how it was called
  const calls = path.join(root, "openclaw-calls.txt");
  const fake = path.join(root, "fake-openclaw");
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire("fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stdout.write("{}");\n`);
  fs.chmodSync(fake, 0o755);
  const recheckCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const telegram = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).startsWith("https://api.telegram.org/")) {
      telegram.push(JSON.parse(opts.body || "{}"));
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 5000 + telegram.length } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const handlers = {};
  const logs = [];
  const services = [];
  const runs = [];
  const api = {
    pluginConfig: {
      orchestratorAgent: "coordinator",
      board: { enabled: false },
      topics: { enabled: false },
      mirror: { enabled: true, chatId: "-100", systemTopic: 160, defaultTopic: 160, minIntervalMs: 0,
        botTokenFiles: { coordinator: path.join(root, "bot.token") }, agentNames: { writer: "Writer" } },
      jobs: { stateFile: path.join(root, "state", "jobs.json"), idleWakeSession: "agent:coordinator:explicit:team-ops",
        refusal: { command: fake, retryAfterSeconds: 120, maxPerHour: 2 } },
      triage: { enabled: false },
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug: () => {} },
    on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
    registerService: (s) => services.push(s),
    registerTool: () => {},
    runtime: { subagent: { run: async (p) => { runs.push(p); return { runId: `r${runs.length}` }; } } },
  };
  const entry = (await import(pathToFileURL(path.join(root, "plugin", "index.js")).href)).default;
  entry.register(api);
  let tick;
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn) => { tick = fn; return { unref() {} }; };
  for (const s of services) if (s.start) s.start();
  globalThis.setInterval = realSetInterval;
  const realNow = Date.now;
  let skew = 11 * 60000; // past the boot grace
  Date.now = () => realNow() + skew;
  const call = (event) => { for (const h of handlers.after_tool_call || []) h(event, { agentId: "coordinator", sessionKey: "agent:coordinator:explicit:team-ops" }); };
  const refused = () => ({
    toolName: "mcp__openclaw__sessions_spawn",
    params: { agentId: "writer", task: "Project: shop" },
    result: { content: [{ type: "text", text: JSON.stringify({ status: "error", error: `sessions_spawn model "anthropic/claude-sonnet-5-5" is not usable: The selected account or native runtime is unavailable for anthropic/claude-sonnet-5-5. Restore that account before spawning this model.` }) }] },
  });
  const retryWakes = () => runs.filter((r) => /\[dispatch\]/.test(r.message || ""));
  const ORC = { agentId: "coordinator", sessionKey: "agent:coordinator:explicit:team-ops", runId: "run-9" };
  const spawn = () => { let out; for (const h of handlers.before_tool_call || []) out = h({ toolName: "sessions_spawn", params: { agentId: "writer", task: brief("cc33dd44"), label: "shop: retry" } }, ORC) ?? out; return out; };
  try {
    // 0. the brief goes out (the guard records it) and the runtime refuses it
    let r = spawn();
    assert.ok(!(r && r.block), `first dispatch refused by the guard: ${r && r.blockReason}`);
    // 1. refused: OpenClaw is asked at once to check the writer's login again, and the topic says what happens next
    call(refused());
    call(refused()); // the CLI reports the same spawn twice
    assert.ok(await until(() => recheckCalls().length === 1), "OpenClaw was not asked to check the login again");
    assert.deepEqual(recheckCalls()[0], ["gateway", "call", "models.list", "--params", JSON.stringify({ agentId: "writer" }), "--json"]);
    assert.ok(await until(() => telegram.some((m) => /Dispatch to Writer failed/.test(m.text || ""))), `no note; posts: ${JSON.stringify(telegram.map((m) => m.text))}; logs: ${logs.slice(-5).join(" | ")}`);
    const note = telegram.find((m) => /Dispatch to Writer failed/.test(m.text || ""));
    assert.equal(note.message_thread_id, 160);
    assert.match(note.text, /not a usage limit/);
    assert.match(note.text, /send it again in 2 min/);
    // 2. not before the wait
    tick();
    await settle();
    assert.equal(retryWakes().length, 0);
    // 3. after the wait: the login is checked again and the orchestrator is woken once to send it again
    skew += 121000;
    tick();
    assert.ok(await until(() => retryWakes().length === 1), "the orchestrator was not woken to retry");
    const wake = retryWakes()[0];
    assert.equal(wake.sessionKey, "agent:coordinator:explicit:team-ops");
    assert.equal(wake.deliver, false);
    assert.match(wake.message, /dispatch to Writer at \d\d:\d\d UTC was refused by OpenClaw's own Claude login check/);
    assert.match(wake.message, /not a usage limit/);
    assert.match(wake.message, /retry 1 of 2/);
    // the same brief again is allowed: the refused one was never sent
    r = spawn();
    assert.ok(!(r && r.block), `the resend was blocked: ${r && r.blockReason}`);
    // a brief that did go out is still not sent twice
    r = spawn();
    assert.equal(r && r.block, true);
    assert.match(r.blockReason, /already sent/);
    assert.ok(await until(() => recheckCalls().length === 2), "the login was not checked again before the wake");
    tick();
    await settle();
    assert.equal(retryWakes().length, 1, "one wake per refusal");
    // 4. the retry is refused too: one more try
    call(refused());
    skew += 121000;
    tick();
    assert.ok(await until(() => retryWakes().length === 2));
    assert.match(retryWakes()[1].message, /retry 2 of 2/);
    // 5. refused a third time within the hour: no more wakes, the operator is told once
    call(refused());
    skew += 121000;
    tick();
    assert.ok(await until(() => telegram.some((m) => /refused 3 times in an hour/.test(m.text || ""))), "the operator was not told");
    await settle();
    assert.equal(retryWakes().length, 2);
    assert.ok(logs.some((m) => /still refused by the Claude login check/.test(m)));
    tick();
    await settle();
    assert.equal(telegram.filter((m) => /refused 3 times in an hour/.test(m.text || "")).length, 1);
    // 6. refused, then the orchestrator sends it again at once and it goes through: no retry wake follows
    const qaRefused = refused();
    qaRefused.params = { agentId: "qa", task: "Project: shop" };
    call(qaRefused);
    assert.ok(await until(() => recheckCalls().some((c) => c[4] === JSON.stringify({ agentId: "qa" }))), "the qa login was not checked again");
    call({ toolName: "mcp__openclaw__sessions_spawn", params: { agentId: "qa", task: "Project: shop", label: "shop: qa" },
      result: { content: [{ type: "text", text: JSON.stringify({ status: "accepted", childSessionKey: "agent:qa:subagent:went-through" }) }] } });
    assert.ok(logs.some((m) => /went through when sent again/.test(m) && /"agentId":"qa"/.test(m)), "the resend that went through was not seen");
    skew += 121000;
    tick();
    await settle();
    assert.equal(retryWakes().length, 2, "a retry wake for a dispatch that already went through");
    assert.ok(!retryWakes().some((w) => /dispatch to qa/i.test(w.message)));
  } finally {
    Date.now = realNow;
  }
});

test("a task whose run ended, then got a follow-up turn, is closed when quiet even without an end event", async () => {
  const root = harness();
  process.env.OC_INBOX_FILE = path.join(root, "inbox.jsonl");
  process.env.OC_INBOX_BIN = path.join(REPO, "bin", "oc-inbox");
  const telegram = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).startsWith("https://api.telegram.org/")) {
      telegram.push(JSON.parse(opts.body || "{}"));
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 6000 + telegram.length } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const handlers = {};
  const logs = [];
  const services = [];
  const api = {
    pluginConfig: {
      orchestratorAgent: "coordinator",
      board: { enabled: false },
      topics: { enabled: false },
      mirror: { enabled: true, chatId: "-100", systemTopic: 160, defaultTopic: 160, minIntervalMs: 0,
        botTokenFiles: { coordinator: path.join(root, "bot.token"), writer: path.join(root, "bot.token") } },
      jobs: { stateFile: path.join(root, "state", "jobs.json"), idleWakeSession: "agent:coordinator:explicit:team-ops", refusal: { enabled: false } },
      triage: { enabled: false },
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug: () => {} },
    on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
    registerService: (s) => services.push(s),
    registerTool: () => {},
    runtime: { subagent: { run: async () => ({ runId: "r" }), getSessionMessages: async () => ({ messages: [] }) } },
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
  const call = (name, event, ctx) => { for (const h of handlers[name] || []) h(event, ctx); };
  const child = "agent:writer:subagent:f1";
  const job = () => JSON.parse(fs.readFileSync(path.join(root, "state", "jobs.json"), "utf8")).jobs[child];
  try {
    call("before_tool_call", { toolName: "sessions_spawn", params: { agentId: "writer", task: brief("ee55ff66"), label: "shop: follow-up" } },
      { agentId: "coordinator", sessionKey: "agent:coordinator:explicit:team-ops", runId: "run-f" });
    call("subagent_spawned", { childSessionKey: child, agentId: "writer", label: "shop: follow-up" }, { requesterSessionKey: "agent:coordinator:explicit:team-ops" });
    assert.ok(await until(() => job() && job().status === "running"));
    // the spawned run ends; the orchestrator then sends it a follow-up, which answers; no subagent_ended comes
    call("subagent_progress", { childSessionKey: child, phase: "ended", outcome: "ok" }, {});
    call("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "Follow-up done.\n\nRESULT: done\n- the price renders" }] }] }, { sessionKey: child, agentId: "writer" });
    // still in its quiet margin: not closed
    skew += 9 * 60000;
    tick();
    await settle();
    assert.equal(job().status, "running");
    // quiet for longer than the margin: closed like a normal end, and its result is posted
    skew += 2 * 60000;
    tick();
    assert.ok(await until(() => job().status === "ended"), "the quiet task was not closed");
    assert.equal(job().outcome, "ok");
    assert.ok(logs.some((m) => /run ended without an end event/.test(m)));
    assert.ok(await until(() => telegram.some((m) => /price renders/.test(m.text || ""))), "its result was not posted");
    const posts = telegram.length;
    // a late subagent_ended changes nothing and posts nothing twice
    call("subagent_ended", { targetSessionKey: child, outcome: "ok", endedAt: Date.now() }, {});
    await settle();
    assert.equal(telegram.length, posts);
  } finally {
    Date.now = realNow;
  }
});

test("a CI wait on an MR with no pipeline lets go of the item after a short wait; a spent triage budget hands over to the idle wake", async () => {
  const root = harness();
  process.env.OC_INBOX_FILE = path.join(root, "inbox.jsonl");
  process.env.OC_INBOX_BIN = path.join(REPO, "bin", "oc-inbox");
  const A = board(root, "add", "--project", "shop", "--title", "Revenue numbers", "--owner", "devops", "--done-when", "table posted", "--by", "system");
  board(root, "add", "--project", "shop", "--title", "Next thing", "--owner", "writer", "--done-when", "done", "--by", "system");
  board(root, "set", A, "--status", "in_progress", "--by", "system");
  // the triage's budget for today is spent; its last run was just now and it is healthy. The test's clock runs
  // 62 minutes ahead by its end, so the budget is spent on that day too (run near midnight UTC it crossed into a
  // fresh day and failed)
  const dayAt = (min) => new Date(Date.now() + min * 60000).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(root, "state", "jobs.json"), JSON.stringify({ version: 1, jobs: {}, triageHealthy: true,
    triage: { lastAt: Date.now() + 11 * 60000 }, triageWakesByDay: { [dayAt(11)]: 24, [dayAt(62)]: 24 } }));
  const telegram = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith("https://api.telegram.org/")) {
      telegram.push(JSON.parse(opts.body || "{}"));
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 7000 + telegram.length } }) };
    }
    if (u.startsWith("https://gitlab.com/api/v4/projects/g%2Finfra/merge_requests/10")) return { ok: true, json: async () => ({ iid: 10, state: "opened", head_pipeline: null }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const handlers = {};
  const logs = [];
  const services = [];
  const runs = [];
  const api = {
    pluginConfig: {
      orchestratorAgent: "coordinator",
      board: { enabled: true, requireItems: true, agent: "product", wip: 1, view: false },
      topics: { enabled: false },
      mirror: { enabled: true, chatId: "-100", systemTopic: 160, defaultTopic: 160, minIntervalMs: 0,
        botTokenFiles: { coordinator: path.join(root, "bot.token"), devops: path.join(root, "bot.token"), product: path.join(root, "bot.token") } },
      jobs: { stateFile: path.join(root, "state", "jobs.json"), idleWakeSession: "agent:coordinator:explicit:team-ops", refusal: { enabled: false },
        ci: { pollSeconds: 0, noPipelineMinutes: 10 }, gitlabTokenFile: path.join(root, "bot.token") },
      triage: { enabled: true, maxWakesPerDay: 24 },
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug: () => {} },
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
  const call = (name, event, ctx) => { let out; for (const h of handlers[name] || []) out = h(event, ctx) ?? out; return out; };
  const ORC = { agentId: "coordinator", sessionKey: "agent:coordinator:explicit:team-ops", runId: "run-n" };
  const child = "agent:devops:subagent:n1";
  const job = () => JSON.parse(fs.readFileSync(path.join(root, "state", "jobs.json"), "utf8")).jobs[child];
  try {
    // the worker opened an MR that needs review and reported "waiting" with the MR link
    let r = call("before_tool_call", { toolName: "sessions_spawn", params: { agentId: "devops", task: brief(A), label: "shop: revenue numbers" } }, ORC);
    assert.ok(!(r && r.block), `dispatch refused: ${r && r.blockReason}`);
    call("subagent_spawned", { childSessionKey: child, agentId: "devops", label: "shop: revenue numbers" }, { requesterSessionKey: ORC.sessionKey });
    call("agent_end", { messages: [{ role: "assistant", content: "RESULT: waiting\nThe MR needs review: https://gitlab.com/g/infra/-/merge_requests/10" }] }, { sessionKey: child, agentId: "devops" });
    call("subagent_ended", { targetSessionKey: child, outcome: "ok", endedAt: Date.now() }, {});
    assert.ok(await until(() => job() && job().waitFor), "no CI watch was registered");
    // within the short wait the item is held: the next gate is refused as busy
    skew += 3 * 60000;
    tick();
    await settle();
    assert.equal(job().waitFor.done, undefined);
    r = call("before_tool_call", { toolName: "sessions_spawn", params: { agentId: "reviewer", task: brief(A, "Model: sonnet-5\nEffort: low\nReview and merge."), label: "shop: review" } }, ORC);
    assert.equal(r && r.block, true);
    assert.match(r.blockReason, /already being worked on/);
    // past it: the watch lets go and the orchestrator is told to dispatch the next gate
    skew += 8 * 60000;
    tick();
    assert.ok(await until(() => job().waitFor.done), "the watch never let go of an MR with no pipeline");
    assert.equal(job().waitFor.done.state, "no pipeline");
    assert.ok(await until(() => runs.some((p) => /^\[ci\]/.test(p.message || "") && /no pipeline/.test(p.message) && /dispatch the next gate/.test(p.message))), "the orchestrator was not told");
    r = call("before_tool_call", { toolName: "sessions_spawn", params: { agentId: "reviewer", task: brief(A, "Model: sonnet-5\nEffort: low\nReview and merge, take two."), label: "shop: review" } }, ORC);
    assert.ok(!(r && r.block), `the next gate is still refused: ${r && r.blockReason}`);
    // the triage's budget is spent: the plain idle wake now covers open work with nothing running
    const idleWakes = () => runs.filter((p) => /^\[job-tracker\] There is open work/.test(p.message || ""));
    call("subagent_spawned", { childSessionKey: "agent:reviewer:subagent:n2", agentId: "reviewer", label: "shop: review" }, { requesterSessionKey: ORC.sessionKey });
    call("subagent_ended", { targetSessionKey: "agent:reviewer:subagent:n2", outcome: "ok", endedAt: Date.now() }, {});
    skew += 40 * 60000;
    tick();
    assert.ok(await until(() => idleWakes().length === 1), "nothing woke the orchestrator once the triage budget was spent");
  } finally {
    Date.now = realNow;
  }
});

test("the orchestrator's answer to a result goes to the task's topic, not the owner's private chat", async () => {
  const root = harness();
  process.env.OC_INBOX_FILE = path.join(root, "inbox.jsonl");
  process.env.OC_INBOX_BIN = path.join(REPO, "bin", "oc-inbox");
  const MAIN = "agent:coordinator:main"; // the owner's private chat with the orchestrator
  const now = Date.now();
  // a task dispatched from the owner's chat ended 1 minute ago; its result is post 900 in topic 151;
  // the owner last wrote 10 minutes ago
  const job = { key: "agent:social:subagent:s1", agentId: "social", label: "shop: 5 posts", status: "ended", topic: 151,
    requesterSessionKey: MAIN, resultMsgId: 900, endedAt: now - 60000, spawnedAt: now - 3600000 };
  fs.writeFileSync(path.join(root, "state", "jobs.json"), JSON.stringify({ version: 1, jobs: { [job.key]: job },
    ownerMsgs: { 1: { id: 77, at: now - 600000, text: "finish them" } } }));
  const telegram = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).startsWith("https://api.telegram.org/")) {
      telegram.push(JSON.parse(opts.body || "{}"));
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 8000 + telegram.length } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const handlers = {};
  const api = {
    pluginConfig: {
      orchestratorAgent: "coordinator",
      ownerId: "42",
      board: { enabled: true, requireItems: false, agent: "product", view: false },
      topics: { enabled: true, chatId: "-100", teamTopic: 160 },
      mirror: { enabled: true, chatId: "-100", systemTopic: 160, defaultTopic: 160, projectTopics: { shop: 151 }, minIntervalMs: 0,
        botTokenFiles: { coordinator: path.join(root, "bot.token"), social: path.join(root, "bot.token") } },
      jobs: { stateFile: path.join(root, "state", "jobs.json"), idleWakeSession: "agent:coordinator:explicit:team-ops" },
      triage: { enabled: false },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
    registerService: () => {},
    registerTool: () => {},
    runtime: { subagent: { run: async () => ({ runId: "r" }), waitForRun: async () => ({ status: "ok" }), getSessionMessages: async () => ({ messages: [] }), deleteSession: async () => ({}) } },
  };
  const entry = (await import(pathToFileURL(path.join(root, "plugin", "index.js")).href)).default;
  entry.register(api);
  const send = (event, ctx) => { let out; for (const h of handlers.message_sending || []) out = h(event, ctx) ?? out; return out; };
  const ORC = { channelId: "telegram", accountId: "orchestrator", sessionKey: MAIN };
  const saved = () => JSON.parse(fs.readFileSync(path.join(root, "state", "jobs.json"), "utf8")).jobs[job.key];

  // a reply to the owner's message stays in the owner's chat
  assert.equal(send({ to: "42", content: "On it.", replyToId: "77" }, ORC), undefined);
  // a send that does not name its session (OpenClaw's reply to an inbound message) stays
  assert.equal(send({ to: "telegram:42", content: "Here is where things are." }, { channelId: "telegram", accountId: "orchestrator" }), undefined);
  // another agent's message to the owner stays
  assert.equal(send({ to: "42", content: "hi" }, { channelId: "telegram", accountId: "social", sessionKey: "agent:social:main" }), undefined);
  assert.equal(saved().answeredAt, undefined);

  // the orchestrator answering the newer result moves to topic 151, under the result
  const r = send({ to: "telegram:42", content: "Thanks, one post is live; next: the other four." }, ORC);
  assert.equal(r && r.cancel, true);
  assert.match(r.cancelReason, /topic 151/);
  assert.ok(await until(() => telegram.some((m) => m.message_thread_id === 151 && /one post is live/.test(m.text || ""))), "the answer was not reposted in topic 151");
  const moved = telegram.find((m) => m.message_thread_id === 151);
  assert.equal(String(moved.chat_id), "-100");
  assert.equal(Number((moved.reply_parameters && moved.reply_parameters.message_id) || moved.reply_to_message_id), 900);
  assert.ok(saved().answeredAt, "the result was not marked answered");

  // once it is answered, the orchestrator's next message to the owner stays in the owner's chat
  assert.equal(send({ to: "42", content: "Anything else?" }, ORC), undefined);
});

test("a result older than the owner's last message: the orchestrator's message is for the owner", async () => {
  const root = harness();
  process.env.OC_INBOX_FILE = path.join(root, "inbox.jsonl");
  const MAIN = "agent:coordinator:main";
  const now = Date.now();
  const job = { key: "agent:social:subagent:s2", agentId: "social", label: "shop: 5 posts", status: "ended", topic: 151,
    requesterSessionKey: MAIN, resultMsgId: 901, endedAt: now - 600000, spawnedAt: now - 3600000 };
  fs.writeFileSync(path.join(root, "state", "jobs.json"), JSON.stringify({ version: 1, jobs: { [job.key]: job },
    ownerMsgs: { 1: { id: 78, at: now - 60000, text: "status?" } } }));
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) });
  const handlers = {};
  const api = {
    pluginConfig: { orchestratorAgent: "coordinator", ownerId: "42", board: { enabled: false }, topics: { enabled: true, chatId: "-100", teamTopic: 160 },
      mirror: { enabled: true, chatId: "-100", systemTopic: 160, defaultTopic: 160, minIntervalMs: 0, botTokenFiles: { coordinator: path.join(root, "bot.token") } },
      jobs: { stateFile: path.join(root, "state", "jobs.json") }, triage: { enabled: false } },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
    registerService: () => {},
    registerTool: () => {},
    runtime: { subagent: { run: async () => ({ runId: "r" }), waitForRun: async () => ({ status: "ok" }), getSessionMessages: async () => ({ messages: [] }), deleteSession: async () => ({}) } },
  };
  const entry = (await import(pathToFileURL(path.join(root, "plugin", "index.js")).href)).default;
  entry.register(api);
  let out;
  for (const h of handlers.message_sending || []) out = h({ to: "42", content: "Social has one post live; four to go." }, { channelId: "telegram", accountId: "orchestrator", sessionKey: MAIN }) ?? out;
  assert.equal(out, undefined);
});

test("a task five minutes from its time limit may only write its final answer, instead of being stopped with no report", async () => {
  const root = harness();
  process.env.OC_INBOX_FILE = path.join(root, "inbox.jsonl");
  process.env.OC_INBOX_BIN = path.join(REPO, "bin", "oc-inbox");
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("https://api.telegram.org/")) return { ok: true, json: async () => ({ ok: true, result: { message_id: 7000 } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const handlers = {};
  const logs = [];
  const services = [];
  const api = {
    pluginConfig: {
      orchestratorAgent: "coordinator",
      board: { enabled: false },
      topics: { enabled: false },
      mirror: { enabled: true, chatId: "-100", systemTopic: 160, defaultTopic: 160, minIntervalMs: 0,
        botTokenFiles: { coordinator: path.join(root, "bot.token"), growth: path.join(root, "bot.token") } },
      jobs: { stateFile: path.join(root, "state", "jobs.json"), idleWakeSession: "agent:coordinator:explicit:team-ops", refusal: { enabled: false } },
      triage: { enabled: false },
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug: () => {} },
    on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
    registerService: (s) => services.push(s),
    registerTool: () => {},
    runtime: { subagent: { run: async () => ({ runId: "r" }), getSessionMessages: async () => ({ messages: [] }) } },
  };
  const entry = (await import(pathToFileURL(path.join(root, "plugin", "index.js")).href)).default;
  entry.register(api);
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => ({ unref() {} });
  for (const s of services) if (s.start) s.start();
  globalThis.setInterval = realSetInterval;
  const realNow = Date.now;
  let skew = 11 * 60000;
  Date.now = () => realNow() + skew;
  let out;
  const call = (name, event, ctx) => { out = undefined; for (const h of handlers[name] || []) out = h(event, ctx) ?? out; return out; };
  const child = "agent:growth:subagent:t9";
  const G = { agentId: "growth", sessionKey: child, runId: "g9" };
  const job = () => JSON.parse(fs.readFileSync(path.join(root, "state", "jobs.json"), "utf8")).jobs[child];
  const step = () => call("before_tool_call", { toolName: "browser", params: { action: "snapshot", profile: "laptop" } }, G);
  try {
    call("before_tool_call", { toolName: "sessions_spawn", params: { agentId: "growth", task: brief("aa11bb22"), label: "shop: list the bot" } },
      { agentId: "coordinator", sessionKey: "agent:coordinator:explicit:team-ops", runId: "run-t" });
    call("subagent_spawned", { childSessionKey: child, agentId: "growth", label: "shop: list the bot" }, { requesterSessionKey: "agent:coordinator:explicit:team-ops" });
    assert.ok(await until(() => job() && job().status === "running"));
    assert.equal(job().runTimeoutSeconds, 3600);
    skew += 30 * 60000;
    assert.ok(!(step() || {}).block, "a step half way through the hour is allowed");
    skew += 26 * 60000; // 4 minutes left
    const r = step();
    assert.equal(r && r.block, true, "a step 4 minutes before the limit must be refused");
    assert.match(r.blockReason, /time limit/);
    assert.match(r.blockReason, /RESULT \(done \/ partly done \/ blocked\)/);
    assert.equal(job().timeUp, true);
    assert.equal(step().block, true);
    assert.equal(logs.filter((m) => /near its time limit/.test(m)).length, 1, "logged once");
  } finally {
    await settle(); // let queued Telegram posts finish on the test's clock: the rate limit remembers that clock
    Date.now = realNow;
  }
});

test("tasks per agent: a second task for an agent at its limit is refused, another agent's item starts, and it starts once the first ends", async () => {
  const root = harness();
  process.env.OC_INBOX_FILE = path.join(root, "inbox.jsonl");
  process.env.OC_INBOX_BIN = path.join(REPO, "bin", "oc-inbox");
  const add = (title, owner, rank) => {
    const id = board(root, "add", "--project", "shop", "--title", title, "--owner", owner, "--done-when", "done", "--by", "system");
    board(root, "set", id, "--status", "todo", "--by", "system");
    board(root, "set", id, "--rank", String(rank), "--by", "system");
    return id;
  };
  const A = add("Checkout shows the price", "writer", 1);
  const B = add("Cart shows the total", "writer", 2);
  const C = add("Checkout page layout", "designer", 3);
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("https://api.telegram.org/")) return { ok: true, json: async () => ({ ok: true, result: { message_id: 7100 } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const handlers = {};
  const services = [];
  const tools = [];
  const api = {
    pluginConfig: {
      orchestratorAgent: "coordinator",
      board: { enabled: true, requireItems: true, agent: "product", wip: 10, projectOrder: ["shop"], view: false, maxTasksByAgent: { writer: 1, designer: 1 } },
      topics: { enabled: false },
      projects: { shop: { topic: 151, path: "/srv/shop" } },
      mirror: { enabled: true, chatId: "-100", systemTopic: 160, defaultTopic: 160, projectTopics: { shop: 151 }, minIntervalMs: 0,
        botTokenFiles: Object.fromEntries(["coordinator", "writer", "designer"].map((a) => [a, path.join(root, "bot.token")])) },
      jobs: { stateFile: path.join(root, "state", "jobs.json"), idleWakeSession: "agent:coordinator:explicit:team-ops", refusal: { enabled: false } },
      triage: { enabled: false },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
    registerService: (s) => services.push(s),
    registerTool: (t, o) => tools.push({ t, o }),
    runtime: { subagent: { run: async () => ({ runId: "r" }), getSessionMessages: async () => ({ messages: [] }) } },
  };
  const entry = (await import(pathToFileURL(path.join(root, "plugin", "index.js")).href)).default;
  entry.register(api);
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => ({ unref() {} });
  for (const s of services) if (s.start) s.start();
  globalThis.setInterval = realSetInterval;
  const realNow = Date.now;
  const skew = 11 * 60000; // past the boot grace
  Date.now = () => realNow() + skew;
  const call = (name, event, ctx) => { let out; for (const h of handlers[name] || []) out = h(event, ctx) ?? out; return out; };
  const ORC = { agentId: "coordinator", sessionKey: "agent:coordinator:explicit:team-ops", runId: "run-c" };
  const spawn = (id, agentId, label) => call("before_tool_call", { toolName: "sessions_spawn", params: { agentId, task: brief(id), label } }, ORC);
  const started = (r, child, agentId, label) => call("after_tool_call", { toolName: "sessions_spawn", params: Object.assign({ agentId, label }, r.params), result: { childSessionKey: child } }, ORC);
  try {
    let r = spawn(A, "writer", "shop: price");
    assert.ok(r && !r.block, `the head of the queue was refused: ${r && r.blockReason}`);
    started(r, "agent:writer:subagent:c1", "writer", "shop: price");
    await settle();
    r = spawn(B, "writer", "shop: total");
    assert.equal(r && r.block, true, "a second writer task must wait");
    assert.match(r.blockReason, /writer already runs 1 task, its limit/);
    r = spawn(C, "designer", "shop: layout");
    assert.ok(r && !r.block, `another agent's item was refused: ${r && r.blockReason}`);
    call("subagent_ended", { targetSessionKey: "agent:writer:subagent:c1", outcome: "ok", endedAt: Date.now() }, {});
    await settle();
    r = spawn(B, "writer", "shop: total");
    assert.ok(r && !r.block, `the writer's next item was refused after its task ended: ${r && r.blockReason}`);
  } finally {
    await settle();
    Date.now = realNow;
  }
});
