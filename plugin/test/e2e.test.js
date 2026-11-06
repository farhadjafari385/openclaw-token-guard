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
      mirror: { enabled: true, chatId: "-100", systemTopic: 160, defaultTopic: 160, projectTopics: { shop: 151 },
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
    assert.ok(telegram.some((m) => /CI passed/.test(m.text || "")), "no CI post in the thread");
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
