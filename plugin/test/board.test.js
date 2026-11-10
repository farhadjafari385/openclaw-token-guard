import test from "node:test";
import assert from "node:assert/strict";
import { normStatus, canMove, resultVerdict, nextAfterJob, renderBoard, renderOverview, auditBoard, parseApproval, looksLikeRequest, queueState } from "../board.js";
import { projectsMentioned, correctTopic } from "../topics.js";
import { policyDecide, itemsFromBrief } from "../policy.js";

const H = 3600000;

test("columns and allowed moves", () => {
  assert.equal(normStatus("dispatched"), "in_progress");
  assert.equal(normStatus("In Progress"), "in_progress");
  assert.equal(normStatus("open"), "backlog");
  assert.equal(canMove("todo", "in_progress"), true);
  assert.equal(canMove("backlog", "done"), false);
  assert.equal(canMove("done", "archived"), false); // only through both approvals
  assert.equal(canMove("qa", "done"), true);
});

test("the worker's RESULT line decides where its items go", () => {
  assert.equal(resultVerdict("RESULT: done\nChecks: ...", "ok"), "done");
  assert.equal(resultVerdict("**RESULT:** blocked — needs DNS access", "ok"), "blocked");
  assert.equal(resultVerdict("RESULT: changes requested", "ok"), "failed");
  assert.equal(resultVerdict("RESULT: done", "timeout"), "failed");
  assert.equal(resultVerdict("all good", "ok"), "unknown");
  assert.equal(resultVerdict("", "ok"), "unknown"); // nothing captured: Review, never back to To do
  assert.equal(nextAfterJob("in_progress", "devops", resultVerdict("", "ok")), "review");
  assert.equal(nextAfterJob("in_progress", "writer", "done"), "review");
  assert.equal(nextAfterJob("review", "reviewer", "done"), "qa");
  assert.equal(nextAfterJob("qa", "qa", "done"), "done");
  assert.equal(nextAfterJob("qa", "devops", "done"), "done");
  assert.equal(nextAfterJob("in_progress", "devops", "done"), "review");
  assert.equal(nextAfterJob("in_progress", "writer", "failed"), "todo");
  assert.equal(nextAfterJob("review", "reviewer", "blocked"), "blocked");
  assert.equal(nextAfterJob("in_progress", "writer", "unknown"), "review");
  // A late or duplicate result never undoes a later decision.
  for (const st of ["done", "dropped", "archived", "blocked", "todo", "backlog"]) {
    for (const v of ["failed", "done", "blocked", "unknown"]) assert.equal(nextAfterJob(st, "devops", v), st, `${st}/${v}`);
  }
});

test("board view and overview", () => {
  const items = [
    { id: "a1b2c3d4", title: "Fix CI", status: "in_progress", owner: "devops" },
    { id: "e5f6a7b8", title: "Banner", status: "done", owner: "writer", orc_approved_ts: "x" },
    { id: "0f0f0f0f", title: "Old", status: "archived" },
    { id: "1a1a1a1a", title: "DNS", status: "blocked", note: "needs Cloudflare scope" },
  ];
  const text = renderBoard("demo", items, Date.UTC(2026, 10, 4, 12, 0));
  assert.match(text, /📋 demo board · updated 12:00 UTC/);
  assert.match(text, /🔄 In progress \(1\)\n  • Fix CI — devops · a1b2c3d4/);
  assert.match(text, /✅ Done, awaiting approval \(1\)\n  • Banner — writer · e5f6a7b8 \(orchestrator ✓, you …\)/);
  assert.match(text, /⛔ Blocked \(1\)\n  • DNS · 1a1a1a1a\n     ↳ needs Cloudflare scope/);
  assert.match(text, /reply here: approve e5f6a7b8/);
  assert.doesNotMatch(text, /0f0f0f0f/);
  assert.match(renderOverview({ demo: items }), /• demo: 🔄 1 in progress, ⛔ 1 blocked, ✅ 1 done/);
});

test("board audit finds lost, waiting, incomplete and missed work", () => {
  const now = Date.UTC(2026, 10, 4, 12);
  const iso = (ms) => new Date(ms).toISOString();
  const items = [
    { id: "aaaaaaa1", status: "in_progress", updated_ts: iso(now - H) },
    { id: "aaaaaaa2", status: "in_progress", updated_ts: iso(now - H) },
    { id: "aaaaaaa3", status: "qa", updated_ts: iso(now - 3 * H) },
    { id: "aaaaaaa4", status: "todo", owner: "qa", updated_ts: iso(now) },
    { id: "aaaaaaa5", status: "backlog", updated_ts: iso(now - 30 * H) },
  ];
  const asks = [{ at: now - H, topic: 151, text: "please fix the login page, it is broken", captured: false }, { at: now - H, topic: 151, text: "x", captured: true }];
  const kinds = auditBoard(items, new Set(["aaaaaaa2"]), asks, now).map((i) => `${i.kind}:${i.id || ""}`);
  assert.deepEqual(kinds, ["lost:aaaaaaa1", "waiting:aaaaaaa3", "incomplete:aaaaaaa4", "stale:aaaaaaa5", "missed:"]);
});

test("owner approvals and requests", () => {
  assert.deepEqual(parseApproval("approve a1b2c3d4 e5f6a7b8"), { ids: ["a1b2c3d4", "e5f6a7b8"], all: false });
  assert.deepEqual(parseApproval("approved all"), { ids: [], all: true });
  assert.equal(parseApproval("I approve of the plan"), null);
  assert.equal(looksLikeRequest("please fix the login page, it is broken on phones"), true);
  assert.equal(looksLikeRequest("ok thanks"), false);
  // short orders to go ahead were not seen as requests, so one sent during a usage limit was lost
  assert.equal(looksLikeRequest("Do it, and gime and them a report of 3 before they sent"), true);
  assert.equal(looksLikeRequest("go ahead and connect the new bot to the team"), true);
  assert.equal(looksLikeRequest("I tested it myself, looks nice now"), false);
});

const PROJECTS = {
  demo: { topic: 151, aliases: ["demosite"] },
  "openclaw-ui": { topic: 2715 },
  ai: { topic: 153, strict: true },
  team: { topic: 160, aliases: ["general"], strict: true },
};

test("topics: a message goes to the topic of the one project it is about", () => {
  assert.deepEqual(projectsMentioned("Pipeline for demo is green", PROJECTS), ["demo"]);
  assert.deepEqual(projectsMentioned("The AI said hello", PROJECTS), []); // strict name, not written as a project
  assert.deepEqual(projectsMentioned("the ai project needs a fix", PROJECTS), ["ai"]);
  assert.deepEqual(projectsMentioned("Project: ai (/srv/ai)\nAlso demo docs", PROJECTS), ["ai"]); // the Project: line decides
  assert.deepEqual(correctTopic({ threadId: 160, text: "demo deploy done", projects: PROJECTS, teamTopic: 160 }), { topic: 151, project: "demo" });
  assert.deepEqual(correctTopic({ threadId: undefined, text: "hello team", projects: PROJECTS, teamTopic: 160 }), { topic: 160, project: null });
  assert.deepEqual(correctTopic({ threadId: 1, text: "openclaw-ui build is red", projects: PROJECTS, teamTopic: 160 }), { topic: 2715, project: "openclaw-ui" });
  assert.equal(correctTopic({ threadId: 151, text: "demo and openclaw-ui both", projects: PROJECTS, teamTopic: 160 }).topic, 151);
});

const COORD = { agentId: "coordinator", sessionKey: "agent:coordinator:telegram:group:-100:topic:151" };
const CFG = { topics: { chatId: "-100" }, projects: PROJECTS };

test("policy: message posts are rewritten to the right topic", () => {
  const r = policyDecide({ toolName: "message", params: { action: "send", target: "-100", threadId: "160", message: "demo is live", replyTo: "55" } }, COORD, {}, CFG);
  assert.equal(r.params.threadId, "151");
  assert.equal(r.params.replyTo, undefined);
  assert.equal(policyDecide({ toolName: "message", params: { target: "-100", threadId: "151", message: "demo is live" } }, COORD, {}, CFG), undefined);
  assert.equal(policyDecide({ toolName: "message", params: { target: "109023", message: "demo is live" } }, COORD, {}, CFG), undefined); // DMs untouched
});

test("policy: every dispatch starts from board items of one project, one task per item", () => {
  const board = new Map([
    ["a1b2c3d4", { id: "a1b2c3d4", project: "demo", status: "todo" }],
    ["b1b2c3d4", { id: "b1b2c3d4", project: "demo", status: "done" }],
    ["c1b2c3d4", { id: "c1b2c3d4", project: "openclaw-ui", status: "todo" }],
  ]);
  const ps = (running = []) => ({ boardItems: () => board, runningItemIds: () => new Set(running) });
  const spawn = (task) => ({ toolName: "sessions_spawn", params: { agentId: "writer", task } });
  const brief = (items, project = "demo") => `Project: ${project} (/srv/demo)\nScope: x\nItems:\n${items}\nDone when: tests pass\nStop if: y`;
  assert.equal(policyDecide(spawn(brief("a1b2c3d4")), COORD, ps(), CFG).params.cleanup, "delete");
  assert.equal(policyDecide(spawn(brief("deadbeef")), COORD, ps(), CFG).rule, "boardItems");
  assert.equal(policyDecide(spawn(brief("b1b2c3d4")), COORD, ps(), CFG).rule, "boardItems"); // done: reopen first
  assert.equal(policyDecide(spawn(brief("a1b2c3d4")), COORD, ps(["a1b2c3d4"]), CFG).rule, "boardBusy");
  assert.equal(policyDecide(spawn(brief("a1b2c3d4 c1b2c3d4")), COORD, ps(), CFG).rule, "mixedProjects");
  assert.equal(policyDecide(spawn(brief("c1b2c3d4", "demo")), COORD, ps(), CFG).rule, "projectMismatch");
  assert.deepEqual(itemsFromBrief("Project: x\nItems:\n- a1b2c3d4 fix\n- c1b2c3d4\nDone when: commit 26a045e0 deployed"), ["a1b2c3d4", "c1b2c3d4"]);
});

test("policy: only the orchestrator and the PM change the board; only the orchestrator approves", () => {
  const tb = (action, agentId) => policyDecide({ toolName: "task_inbox", params: { action, id: "a1b2c3d4" } }, { agentId, sessionKey: `agent:${agentId}:main` }, {}, CFG);
  assert.equal(tb("set", "writer").rule, "boardWrite");
  assert.equal(tb("list", "writer"), undefined);
  assert.equal(tb("set", "product"), undefined);
  assert.equal(tb("approve", "product").rule, "boardApproval");
  assert.equal(tb("approve", "coordinator"), undefined);
});

test("policy: a code task writes only inside its project", () => {
  const cfg = Object.assign({}, CFG, { projects: { demo: { topic: 151, path: "/srv/projects/demo" } } });
  const ctx = { agentId: "writer", sessionKey: "agent:writer:subagent:1" };
  const ps = { jobFor: () => ({ project: "demo (/srv/projects/demo)" }) };
  const w = (file_path) => policyDecide({ toolName: "Write", params: { file_path, content: "x" } }, ctx, ps, cfg);
  assert.equal(w("/srv/projects/demo/src/a.ts"), undefined);
  assert.equal(w("/tmp/x.txt"), undefined);
  assert.equal(w("/srv/projects/other/a.ts").rule, "outOfTask");
});

test("the queue: one item at a time, in the PM's order (rank, then the owner's project order, priority, age)", async () => {
  const { queueState, queueOrder } = await import("../board.js");
  const order = ["shop", "hub", "game", "demo-ui"];
  const items = [
    { id: "aaaaaaa1", project: "demo-ui", status: "todo", created_ts: "2026-11-01" },
    { id: "aaaaaaa2", project: "game", status: "todo", created_ts: "2026-11-02" },
    { id: "aaaaaaa3", project: "shop", status: "todo", priority: "low", created_ts: "2026-11-03" },
    { id: "aaaaaaa4", project: "shop", status: "todo", priority: "urgent", created_ts: "2026-11-04" },
    { id: "aaaaaaa5", project: "demo-ui", status: "todo", rank: 1, created_ts: "2026-11-05" }, // the PM put it first
    { id: "aaaaaaa6", project: "shop", status: "backlog" }, // not in the queue until the PM moves it to To do
  ];
  assert.deepEqual(queueOrder(items, order).map((i) => i.id), ["aaaaaaa5", "aaaaaaa4", "aaaaaaa3", "aaaaaaa2", "aaaaaaa1"]);
  let q = queueState(items, { wip: 1, projectOrder: order });
  assert.deepEqual(q.next.map((i) => i.id), ["aaaaaaa5"]);
  q = queueState([...items, { id: "aaaaaaa7", project: "shop", status: "review" }], { wip: 1, projectOrder: order });
  assert.deepEqual(q.active.map((i) => i.id), ["aaaaaaa7"]);
  assert.deepEqual(q.next, []); // one in hand: nothing new starts
});

test("policy: a dispatch is the next gate of the item in hand, or the head of the queue", () => {
  const items = new Map([
    ["a1b2c3d4", { id: "a1b2c3d4", project: "demo", status: "todo", rank: 2, title: "second" }],
    ["b1b2c3d4", { id: "b1b2c3d4", project: "demo", status: "todo", rank: 1, title: "first" }],
    ["c1b2c3d4", { id: "c1b2c3d4", project: "demo", status: "review", title: "in hand" }],
  ]);
  const ps = (board) => ({ boardItems: () => board, runningItemIds: () => new Set(), queue: () => queueState(board, { wip: 1 }) });
  const spawn = (id, agentId = "writer") => ({ toolName: "sessions_spawn", params: { agentId, task: `Project: demo (/srv/demo)\nScope: x\nItems:\n${id}\nDone when: tests pass\nStop if: y` } });
  // something is in hand: only its next gate may start
  assert.equal(policyDecide(spawn("b1b2c3d4"), COORD, ps(items), CFG).rule, "queueBusy");
  assert.equal(policyDecide(spawn("c1b2c3d4", "reviewer"), COORD, ps(items), CFG).params.cleanup, "delete");
  // nothing in hand: only the head of the queue may start
  const free = new Map([...items].filter(([id]) => id !== "c1b2c3d4"));
  const early = policyDecide(spawn("a1b2c3d4"), COORD, ps(free), CFG);
  assert.equal(early.rule, "queueOrder");
  assert.match(early.blockReason, /Next: b1b2c3d4 "first"/);
  assert.equal(policyDecide(spawn("b1b2c3d4"), COORD, ps(free), CFG).params.cleanup, "delete");
  // the queue can be turned off (wip 0)
  assert.equal(policyDecide(spawn("a1b2c3d4"), COORD, ps(free), Object.assign({}, CFG, { board: { wip: 0 } })).params.cleanup, "delete");
});

test("tasks per agent: an agent at its limit is passed over in the queue and refused at dispatch; others start", () => {
  const items = new Map([
    ["a1000001", { id: "a1000001", project: "demo", status: "todo", rank: 1, owner: "growth", title: "list on site 1" }],
    ["a1000002", { id: "a1000002", project: "demo", status: "todo", rank: 2, owner: "growth", title: "list on site 2" }],
    ["a1000003", { id: "a1000003", project: "demo", status: "todo", rank: 3, owner: "product", title: "spec A" }],
    ["a1000004", { id: "a1000004", project: "demo", status: "todo", rank: 4, owner: "product", title: "spec B" }],
    ["a1000005", { id: "a1000005", project: "demo", status: "todo", rank: 5, owner: "writer", title: "fix C" }],
    ["a1000006", { id: "a1000006", project: "demo", status: "in_progress", owner: "growth", title: "list on site 0" }],
  ]);
  const caps = { growth: 1, product: 1, writer: 2 };
  // growth runs its one task: its items are passed over; product gets one, not two; the writer's item comes next
  let q = queueState(items, { wip: 10, maxTasksByAgent: caps, running: { growth: 1 } });
  assert.deepEqual(q.next.map((i) => i.id), ["a1000003", "a1000005"]);
  // the team-wide limit still counts: two in hand of 3 leaves one slot
  q = queueState(items, { wip: 2, maxTasksByAgent: caps, running: { growth: 1 } });
  assert.deepEqual(q.next.map((i) => i.id), ["a1000003"]);
  // no per-agent limits: the old order
  q = queueState(items, { wip: 3, running: { growth: 1 } });
  assert.deepEqual(q.next.map((i) => i.id), ["a1000001", "a1000002"]);
  const running = { growth: 1 };
  const ps = { boardItems: () => items, runningItemIds: () => new Set(["a1000006"]), runningTasks: (a) => running[a] || 0,
    queue: () => queueState(items, { wip: 10, maxTasksByAgent: caps, running }) };
  const cfg = Object.assign({}, CFG, { board: { wip: 10, maxTasksByAgent: caps } });
  const spawn = (id, agentId) => ({ toolName: "sessions_spawn", params: { agentId, task: `Project: demo (/srv/demo)\nScope: x\nItems:\n${id}\nDone when: tests pass\nStop if: y` } });
  const busy = policyDecide(spawn("a1000001", "growth"), COORD, ps, cfg);
  assert.equal(busy.rule, "agentBusy");
  assert.match(busy.blockReason, /growth already runs 1 task, its limit/);
  assert.equal(policyDecide(spawn("a1000003", "product"), COORD, ps, cfg).params.cleanup, "delete"); // another agent starts
  assert.equal(policyDecide(spawn("a1000004", "product"), COORD, ps, cfg).rule, "queueOrder"); // product's second waits behind its first
  running.product = 1;
  assert.equal(policyDecide(spawn("a1000004", "product"), COORD, ps, cfg).rule, "agentBusy");
  running.writer = 1;
  assert.equal(policyDecide(spawn("a1000005", "writer"), COORD, ps, cfg).params.cleanup, "delete"); // writer may run 2
  // the team-wide limit says how many are in hand, not "one at a time"
  const busyTeam = (wip) => Object.assign({}, ps, { queue: () => ({ wip, active: Array.from({ length: wip }, (_, n) => ({ id: `b000000${n}`, status: "review" })), queue: [], next: [] }) });
  assert.match(policyDecide(spawn("a1000003", "product"), COORD, busyTeam(3), Object.assign({}, CFG, { board: { wip: 3 } })).blockReason, /3 items in hand, its limit of 3/);
  assert.match(policyDecide(spawn("a1000003", "product"), COORD, busyTeam(1), Object.assign({}, CFG, { board: { wip: 1 } })).blockReason, /one item at a time/);
});

test("a worker that pushed reports waiting: the item stays where it is until its pipeline ends", () => {
  assert.equal(resultVerdict("Pushed and opened the MR.\nRESULT: waiting for CI https://gitlab.com/g/p/-/pipelines/12"), "waiting");
  assert.equal(nextAfterJob("in_progress", "writer", "waiting"), "in_progress");
  assert.equal(nextAfterJob("review", "reviewer", "waiting"), "review");
  assert.equal(nextAfterJob("in_progress", "writer", "done"), "review"); // what the CI watch applies on green
  assert.equal(nextAfterJob("review", "reviewer", "done"), "qa");
  assert.equal(nextAfterJob("in_progress", "writer", "failed"), "todo"); // on red: back to the head of the queue
});

test("the project-name contract: only canonical names and their aliases; aliases are stored as the name", async () => {
  const { canonicalProject } = await import("../policy.js");
  const P = { projects: { shop: { topic: 153, aliases: ["shopsite", "shop.example"] }, team: { topic: 160, aliases: ["general"] } } };
  assert.equal(canonicalProject(P, "shop"), "shop");
  assert.equal(canonicalProject(P, "Shop.Example"), "shop");
  assert.equal(canonicalProject(P, "shopsite (/srv/shop)"), "shop");
  assert.equal(canonicalProject(P, "Shop SEO"), ""); // not a name: never guessed from free text
  assert.equal(canonicalProject(P, "team-wide"), "");
  const ORCH = { agentId: "coordinator", sessionKey: "agent:coordinator:main" };
  const add = (project) => policyDecide({ toolName: "task_inbox", params: { action: "add", project, title: "Fix the cart total" } }, ORCH, {}, P);
  assert.equal(add("shopsite").params.project, "shop");
  assert.equal(add("shop"), undefined); // already canonical: unchanged
  const move = (project) => policyDecide({ toolName: "task_inbox", params: { action: "set", id: "a1b2c3d4", project } }, ORCH, {}, P);
  assert.equal(move("shop.example").params.project, "shop"); // moving an item to a project: same contract
  assert.equal(move("Shop SEO").rule, "unknownProject");
  const bad = add("Shop SEO");
  assert.equal(bad.rule, "unknownProject");
  assert.match(bad.blockReason, /Use exactly one of: shop, team/);
  // a brief's Project line follows the same contract
  const spawn = (project) => policyDecide({ toolName: "sessions_spawn", params: { agentId: "writer",
    task: `Project: ${project} (/srv/shop)\nScope: x\nItems:\na1b2c3d4\nDone when: y\nStop if: z\nModel: sonnet-5\nEffort: low` } },
    ORCH, {}, Object.assign({ board: { requireItems: false } }, P));
  assert.match(spawn("shopsite").params.task, /^Project: shop \(\/srv\/shop\)/);
  assert.equal(spawn("Shop SEO").rule, "unknownProject");
  // without a projects list (a plain install) nothing is enforced
  assert.equal(policyDecide({ toolName: "task_inbox", params: { action: "add", project: "anything", title: "x y z" } }, ORCH, {}, {}), undefined);
});
