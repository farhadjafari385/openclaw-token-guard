// Mode "safety" (owner 2026-11-22: no babysitter): the process rules are off, the safety rules still stop a call,
// and a rule that is off never hides a safety rule that comes after it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { policyDecide } from "../policy.js";
import { decide, createState } from "../guard.js";
import { SAFETY_RULES, enforces, ruleOn } from "../safety.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COORD = { agentId: "coordinator", sessionKey: "agent:coordinator:telegram:group:-100:topic:151", runId: "r1" };
const WRITER = { agentId: "writer", sessionKey: "agent:writer:subagent:abc", runId: "r2" };
const rule = (r) => (r && r.rule) || null;
const blocked = (r) => Boolean(r && r.block);

const BRIEF = "Project: shop (/srv/shop)\nScope: the checkout page\nItems:\n- aaaaaaaa\nModel: fable-9\nEffort: max";
const item = (over = {}) => Object.assign({ id: "aaaaaaaa", status: "todo", project: "shop", title: "Checkout", note: "", done_when: "" }, over);
const pstate = (over = {}) => Object.assign({
  boardItems: () => new Map([["aaaaaaaa", item()], ["bbbbbbbb", item({ id: "bbbbbbbb" })]]),
  runningItemIds: () => new Set(["aaaaaaaa"]),
  noProgressStreak: () => 0,
  itemTasks: () => 99,
  runningTasks: () => 5,
  queue: () => ({ active: [item({ id: "bbbbbbbb" })], next: [], wip: 1 }),
  loopHold: () => ({ until: Date.now() + 60000, text: "token-guard: the gateway's event loop was blocked" }),
  maintenanceSince: () => 0,
}, over);
const cfg = (mode) => ({
  mode,
  orchestratorAgent: "coordinator",
  projects: { shop: { topic: 151, path: "/srv/shop" } },
  board: { enabled: true, requireItems: true, agent: "product", wip: 1, maxTasksByAgent: { writer: 1 }, maxTasksPerItem: 2, maxNoProgress: 1, requireDoneWhen: true },
  spawn: { allowedModels: ["anthropic/claude-sonnet-5-5"], allowedThinking: ["low", "medium"] },
  orchestratorMaxCallsPerRun: 3,
});
const spawn = (task = BRIEF) => ({ toolName: "sessions_spawn", params: { agentId: "writer", task } });

test("enforce mode refuses this dispatch; safety mode lets it start", () => {
  assert.equal(blocked(policyDecide(spawn(), COORD, pstate(), cfg("enforce"), null, Date.now())), true);
  const r = policyDecide(spawn(), COORD, pstate(), cfg("safety"), null, Date.now());
  assert.equal(blocked(r), false, `refused by ${rule(r)}`);
  // a model and an effort outside the list are not refused and not passed on: the agent's own setting runs
  assert.equal(r.params.model, undefined);
  assert.equal(r.params.thinking, undefined);
  assert.match(r.params.task, /Items:\n- aaaaaaaa/);
});

test("safety mode: a restart in progress still holds a dispatch, though the queue rules before it are off", () => {
  const r = policyDecide(spawn(), COORD, pstate({ maintenanceSince: () => Date.now() - 1000 }), cfg("safety"), null, Date.now());
  assert.equal(rule(r), "maintenance");
});

test("safety mode: a usage limit and the weekly reserve still hold a dispatch", () => {
  const now = Date.now();
  assert.equal(rule(policyDecide(spawn(), COORD, pstate({ claudeLimitedUntil: now + 3600000 }), cfg("safety"), null, now)), "claudeLimited");
  const hold = { until: now + 3600000, reason: "reserve", used: 96 };
  assert.equal(rule(policyDecide(spawn(), COORD, pstate({ paceHold: hold }), cfg("safety"), null, now)), "weeklyPace");
});

test("safety mode: a task still starts from a board item, in a real project", () => {
  assert.equal(rule(policyDecide(spawn("Project: shop (/srv/shop)\nScope: x\nItems: none"), COORD, pstate(), cfg("safety"), null, Date.now())), "boardItems");
  assert.equal(rule(policyDecide(spawn(BRIEF.replace("shop (/srv/shop)", "nowhere")), COORD, pstate(), cfg("safety"), null, Date.now())), "unknownProject");
});

test("safety mode: rules, config, git history and the orchestrator's role stay protected", () => {
  const c = cfg("safety");
  const exec = (command) => ({ toolName: "exec", params: { command } });
  assert.equal(rule(policyDecide(exec("openclaw config set agents.defaults.model x"), WRITER, pstate(), c, null, Date.now())), "protectedConfig");
  assert.equal(rule(policyDecide(exec("git push --force origin main"), WRITER, pstate(), c, null, Date.now())), "gitSafety");
  assert.equal(rule(policyDecide(exec("git commit -am fix && git push origin HEAD:fix/x"), COORD, pstate(), c, null, Date.now())), "orchestratorOnly");
  assert.equal(rule(policyDecide({ toolName: "sessions_spawn", params: { agentId: "qa", task: "x" } }, WRITER, pstate(), c, null, Date.now())), "spawnByWorker");
  // a worker pushes its branch without the guard asking for the whole pipeline to run locally first
  const job = { brief: BRIEF, project: "shop", checksRun: 0 };
  assert.equal(policyDecide(exec("git push origin HEAD:fix/x"), WRITER, pstate({ jobFor: () => job }), c, null, Date.now()), undefined);
  assert.equal(rule(policyDecide(exec("git push origin HEAD:fix/x"), WRITER, pstate({ jobFor: () => job }), cfg("enforce"), null, Date.now())), "pushWithoutChecks");
});

test("safety mode: the runaway fuses stay (task and run call budgets, no third try that moves nothing, the time limit)", () => {
  const c = cfg("safety");
  const exec = { toolName: "exec", params: { command: "ls" } };
  assert.equal(rule(policyDecide(exec, WRITER, pstate({ jobFor: () => ({ brief: BRIEF, timeUp: true }) }), c, null, Date.now())), "taskTime");
  // the fuses: a task past its call budget writes its report; an orchestrator run past its own stops (cfg: 3 calls)
  assert.equal(rule(policyDecide(exec, WRITER, pstate({ jobFor: () => ({ brief: BRIEF, overBudget: true, toolCalls: 700 }) }), c, null, Date.now())), "taskBudget");
  const check = { toolName: "exec", params: { command: "curl -sI https://example.com" } };
  assert.equal(policyDecide(check, COORD, pstate({ runCalls: () => 3 }), c, null, Date.now()), undefined);
  assert.equal(rule(policyDecide(check, COORD, pstate({ runCalls: () => 50 }), c, null, Date.now())), "runBudget");
  // a third try on an item whose last tries moved nothing is held until something changes (cfg: after 1)
  assert.equal(rule(policyDecide(spawn(), COORD, pstate({ noProgressStreak: () => 2 }), c, null, Date.now())), "loopBreak");
  // inside its task an agent uses the subagents it needs; outside a task there are none
  const agent = { toolName: "Agent", params: { prompt: "review this diff" } };
  assert.equal(policyDecide(agent, WRITER, pstate({ jobFor: () => ({ brief: "Subagents: max 0", subagentCalls: 7 }) }), c, null, Date.now()), undefined);
  assert.equal(rule(policyDecide(agent, COORD, pstate(), c, null, Date.now())), "subagentsOff");
});

test("safety mode: waiting, polling and long runs are the agent's call; the gateway stays untouchable even after 500 calls", () => {
  const state = createState();
  const c = { mode: "safety", maxToolCallsPerRun: 5, checkpointEvery: 2, maxRepeatCommand: 2 };
  const exec = (command, extra = {}) => ({ toolName: "exec", params: { command, ...extra } });
  for (let i = 0; i < 20; i += 1) assert.equal(decide(exec(`echo step ${i}`), WRITER, state, c), undefined);
  assert.equal(decide(exec("sleep 300"), WRITER, state, c), undefined);
  assert.equal(decide(exec("while true; do sleep 60; done"), WRITER, state, c), undefined);
  for (let i = 0; i < 6; i += 1) assert.equal(decide({ toolName: "process", params: { action: "poll", sessionId: "j1" } }, WRITER, state, c), undefined);
  for (let i = 0; i < 4; i += 1) assert.equal(decide(exec("oc-wait-pipeline --project 1 --sha abc --timeout 100s"), WRITER, state, c), undefined);
  // far past the old budget, a command that stops the gateway is still refused, twice
  const kill = decide(exec("systemctl --user restart openclaw-gateway"), WRITER, state, c);
  assert.equal(blocked(kill), true);
  assert.match(kill.blockReason, /gateway/);
  assert.equal(blocked(decide(exec("systemctl --user restart openclaw-gateway"), WRITER, state, c)), true);
  // and a Gradle build still gets its memory cap
  const g = decide(exec("./gradlew assembleRelease"), WRITER, state, Object.assign({ capGradleBuilds: true }, c));
  assert.match(g.params.command, /--max-workers/);
  // the same message three times is still stopped
  const say = { toolName: "message", params: { message: "Deploy finished, the site answers 200 and the job id is 42." } };
  const got = [1, 2, 3, 4].map(() => decide(say, COORD, state, c));
  assert.equal(got.some(blocked), true);
});

test("every rule the guard can raise is either a safety rule or switched off in safety mode", () => {
  // A process rule that is not gated with on("<rule>") would still return early and hide the safety rules after it.
  const mustGate = { "policy.js": [], "guard.js": [] };
  for (const file of Object.keys(mustGate)) {
    const src = fs.readFileSync(path.join(HERE, "..", file), "utf8");
    const raised = new Set([...src.matchAll(/(?:block|refuse)\("([A-Za-z]+)"/g)].map((m) => m[1]));
    const gated = new Set([...src.matchAll(/on\("([A-Za-z]+)"\)/g)].map((m) => m[1]));
    for (const r of raised) if (!SAFETY_RULES.has(r) && !gated.has(r)) mustGate[file].push(r);
  }
  // Left ungated on purpose: the last checks of their tool call (nothing follows them), so "would block" just allows.
  const terminal = new Set(["forbiddenModel", "forbiddenThinking", "forkSpawn", "duplicateBrief", "briefToExistingChat", "briefFields", "tooManyItems", "mixedBatch",
    "queueBusy", "subagentLimit", "subagentModel", "spawnThinking", "spawnModel"]);
  assert.deepEqual(mustGate["policy.js"].filter((r) => !terminal.has(r)), []);
  assert.deepEqual(mustGate["guard.js"].filter((r) => !terminal.has(r)), []);
  assert.equal(enforces("warn", "gitSafety"), false);
  assert.equal(enforces("enforce", "queueOrder"), true);
  assert.equal(enforces("safety", "queueOrder"), false);
  assert.equal(ruleOn("warn", "queueOrder"), true);
  assert.equal(ruleOn("safety", "gitSafety"), true);
});
