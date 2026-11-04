import test from "node:test";
import assert from "node:assert/strict";
import { normStatus, canMove, resultVerdict, nextAfterJob, renderBoard, renderOverview, auditBoard, parseApproval, looksLikeRequest } from "../board.js";
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
  assert.equal(nextAfterJob("in_progress", "writer", "done"), "review");
  assert.equal(nextAfterJob("review", "reviewer", "done"), "qa");
  assert.equal(nextAfterJob("qa", "qa", "done"), "done");
  assert.equal(nextAfterJob("qa", "devops", "done"), "done");
  assert.equal(nextAfterJob("in_progress", "devops", "done"), "review");
  assert.equal(nextAfterJob("in_progress", "writer", "failed"), "todo");
  assert.equal(nextAfterJob("review", "reviewer", "blocked"), "blocked");
  assert.equal(nextAfterJob("in_progress", "writer", "unknown"), "review");
});

test("board view and overview", () => {
  const items = [
    { id: "a1b2c3d4", title: "Fix CI", status: "in_progress", owner: "devops" },
    { id: "e5f6a7b8", title: "Banner", status: "done", owner: "writer", orc_approved_ts: "x" },
    { id: "0f0f0f0f", title: "Old", status: "archived" },
    { id: "1a1a1a1a", title: "DNS", status: "blocked", note: "needs Cloudflare scope" },
  ];
  const text = renderBoard("demo", items, Date.UTC(2026, 10, 4, 12, 0));
  assert.match(text, /📋 demo board · 12:00 UTC/);
  assert.match(text, /🔄 In progress \(1\)\n  • a1b2c3d4 Fix CI \(devops\)/);
  assert.match(text, /✅ Done, awaiting approval \(1\)\n  • e5f6a7b8 Banner \(writer\) \[orchestrator ✓ · you …\]/);
  assert.match(text, /⛔ Blocked \(1\)\n  • 1a1a1a1a DNS — needs Cloudflare scope/);
  assert.match(text, /reply here: approve e5f6a7b8/);
  assert.doesNotMatch(text, /0f0f0f0f/);
  assert.match(renderOverview({ demo: items }), /demo: 🔄1 ⛔1 ✅1/);
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
