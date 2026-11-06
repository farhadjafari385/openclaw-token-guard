// Regression tests for the bugs found in the 2026-11-05 audit of a week of team work.
import test from "node:test";
import assert from "node:assert/strict";
import { resultVerdict, nextAfterJob } from "../board.js";
import { emptyState, recordSpawn, recordActivity, recordProgress, recordEnd, scanJobs, mergeJobsConfig } from "../jobs.js";
import { policyDecide } from "../policy.js";
import { resultText } from "../voice.js";

const MIN = 60000;
const CFG = mergeJobsConfig({});
const ORC = "agent:coordinator:telegram:group:-100:topic:151";
const KEY = "agent:devops:subagent:7";
const env = (extra = {}) => ({ bootId: "b", bootStartedAt: 0, orchestratorAgent: "coordinator", inboxItems: [], ...extra });
const spawn = (d, at, extra = {}) => recordSpawn(d, { childSessionKey: KEY, agentId: "devops", label: "demo: fix CI", topic: 151, requesterSessionKey: ORC, ...extra }, "b", at, CFG);

test("a finished task whose session was cleaned up ('deleted') is not a failure", () => {
  assert.equal(resultVerdict("RESULT: done\nChecks: ok", "deleted"), "done");
  assert.equal(resultVerdict("RESULT: done", "reset"), "done");
  assert.equal(resultVerdict("", "deleted"), "unknown"); // no report: the orchestrator checks it in Review
  assert.equal(resultVerdict("RESULT: done", "error"), "failed");
  assert.equal(resultVerdict("RESULT: done", "lost"), "failed");
  assert.equal(nextAfterJob("in_progress", "writer", resultVerdict("RESULT: done", "deleted")), "review");
  const d = emptyState();
  spawn(d, 0);
  assert.equal(recordEnd(d, KEY, "deleted", "", 5 * MIN).outcome, "ok");
  const e = emptyState();
  spawn(e, 0);
  recordProgress(e, KEY, "ended", "timeout", 4 * MIN);
  assert.equal(recordEnd(e, KEY, "deleted", "", 5 * MIN).outcome, "timeout"); // the run's own outcome wins
  const text = resultText({ agentHandles: { coordinator: "orc_bot" } }, Object.assign({}, d.jobs[KEY], { resultText: "Fixed it.\n\nRESULT: done" }), "done", []);
  assert.match(text, /^@orc_bot ✅ Done/);
});

test("no stall alarm for a task the guard cannot see working; a silent task it did see is flagged", () => {
  const d = emptyState();
  spawn(d, 0);
  assert.deepEqual(scanJobs(d, CFG, 45 * MIN, env()), []); // its own CLI tools are invisible: no false alarm
  recordActivity(d, KEY, "devops", "coordinator", 5 * MIN);
  const a = scanJobs(d, CFG, 46 * MIN, env());
  assert.deepEqual(a.map((x) => x.kind), ["post", "wake"]);
});

test("a 'running' task far past its timeout lost its end event: closed quietly, items freed", () => {
  const d = emptyState();
  spawn(d, 0, { runTimeoutSeconds: 3600 });
  assert.deepEqual(scanJobs(d, CFG, 70 * MIN, env()), []);
  assert.equal(d.jobs[KEY].status, "running");
  assert.deepEqual(scanJobs(d, CFG, 80 * MIN, env()), []); // no post, no wake
  assert.equal(d.jobs[KEY].status, "ended");
  assert.equal(d.jobs[KEY].outcome, "lost");
  assert.deepEqual(scanJobs(d, CFG, 200 * MIN, env()), []); // and never a reminder storm later
  const long = emptyState();
  spawn(long, 0, { runTimeoutSeconds: 7200 });
  scanJobs(long, CFG, 100 * MIN, env());
  assert.equal(long.jobs[KEY].status, "running"); // a longer timeout is respected
});

test("usage limits: route around the limited provider, never into it; both limited blocks the spawn", () => {
  const now = Date.now();
  const COORD = { agentId: "coordinator", sessionKey: ORC };
  const task = (model) => ({ toolName: "sessions_spawn", params: { agentId: "devops", task: "Project: demo\nFix CI", model, label: "demo: x" } });
  const codexOff = { codexLimitedUntil: now + 3600000 };
  const claudeOff = { claudeLimitedUntil: now + 3600000 };
  assert.equal(policyDecide(task("openai/gpt-6-astra"), COORD, codexOff, {}, null, now).params.model, "anthropic/claude-sonnet-5");
  assert.equal(policyDecide(task("anthropic/claude-sonnet-5-5"), COORD, codexOff, {}, null, now).params.model, "anthropic/claude-sonnet-5-5");
  assert.equal(policyDecide(task("anthropic/claude-opus-5-5"), COORD, claudeOff, {}, null, now).params.model, "openai/gpt-6-astra");
  assert.equal(policyDecide(task("openai/gpt-6-astra"), COORD, claudeOff, {}, null, now).params.model, "openai/gpt-6-astra");
  const both = policyDecide(task("anthropic/claude-sonnet-5"), COORD, Object.assign({}, codexOff, claudeOff), {}, null, now);
  assert.equal(both.block, true);
  assert.match(both.blockReason, /both at their usage limits/);
  // and the tracker spends no wakes while both are limited
  const d = emptyState();
  Object.assign(d, { claudeLimitedUntil: now + 3600000, codexLimitedUntil: now + 3600000 });
  recordSpawn(d, { childSessionKey: KEY, agentId: "devops", label: "x", requesterSessionKey: ORC }, "b", now - 20 * MIN, CFG);
  recordEnd(d, KEY, "ok", "", now - 10 * MIN);
  assert.deepEqual(scanJobs(d, CFG, now, env()).filter((x) => x.kind === "wake"), []);
});

test("Blocked only by a usage limit resumes by itself; Blocked on the owner never does", async () => {
  const { isLimitBlock } = await import("../board.js");
  assert.equal(isLimitBlock("Run died after 16s at start: Claude limited, Codex fallback limited until 3:55 PM EST. Re-dispatch same brief at 3:55."), true);
  assert.equal(isLimitBlock("No live task. Writer retry died on the Codex usage limit. Re-dispatch after reset"), true);
  assert.equal(isLimitBlock("Remaining: two real $0.99 payments = spending money, so it needs the owner's OK"), false);
  assert.equal(isLimitBlock("Cloudflare unverifiable: needs owner decision; Codex limit too"), false);
  assert.equal(isLimitBlock("Waiting on DNS propagation"), false);
});

test("one request = one item: no new items for retries or gates, no near-duplicates", async () => {
  const { similarOpenItem } = await import("../policy.js");
  const board = new Map([
    ["2fda6c5a", { id: "2fda6c5a", project: "demo", status: "blocked", title: "Modal buttons (e.g. visitor gift Collect) do nothing on mobile" }],
    ["aaaa1111", { id: "aaaa1111", project: "demo", status: "done", title: "World map panning stops at the map edges on phone" }],
  ]);
  assert.equal(similarOpenItem(board, "demo", "Visitor gift modal: Collect buttons do nothing on mobile").id, "2fda6c5a");
  assert.equal(similarOpenItem(board, "demo", "World map panning stops at map edges on phone"), null); // that one is done
  assert.equal(similarOpenItem(board, "demo", "Fix login page"), null); // too short to judge
  assert.equal(similarOpenItem(board, "other-project", "Modal buttons do nothing on mobile visitor gift"), null); // other project
  const COORD = { agentId: "coordinator", sessionKey: "agent:coordinator:telegram:group:-100:topic:151" };
  const pstate = { boardItems: () => board };
  const add = (title) => policyDecide({ toolName: "task_inbox", params: { action: "add", project: "demo", title } }, COORD, pstate, {});
  assert.equal(add("Retry: finish modal button fix MR after Codex limit").rule, "itemPerStep");
  assert.equal(add("QA gate: live proof of PR #47").rule, "itemPerStep");
  assert.equal(add("Visitor gift modal: Collect buttons do nothing on mobile").rule, "duplicateItem");
  assert.equal(add("Add a settings page with sound volume"), undefined);
});

test("triage: no call when nothing needs a decision; a snapshot and a parsed decision otherwise", async () => {
  const { triageSnapshot, parseTriage, triageWakeMessage } = await import("../triage.js");
  const now = Date.now();
  const quiet = emptyState();
  assert.equal(triageSnapshot(quiet, [{ id: "a", status: "done" }, { id: "b", status: "blocked" }], now), null);
  const busy = emptyState();
  const snap = triageSnapshot(busy, [{ id: "2fda6c5a", project: "demo", status: "todo", title: "Modal buttons", owner: "writer" }], now);
  assert.match(snap, /Open items with no task running \(1\):\n- 2fda6c5a \[todo\] demo: Modal buttons/);
  assert.deepEqual(parseTriage('Sure.\n{"wake": true, "effort": "high", "why": "asked twice", "instruction": "dispatch 2fda6c5a"}'),
    { wake: true, effort: "high", why: "asked twice", instruction: "dispatch 2fda6c5a" });
  assert.equal(parseTriage("no json here"), null);
  assert.equal(parseTriage('{"wake": true, "effort": "max"}').effort, "medium");
  assert.match(triageWakeMessage({ effort: "high", why: "x", instruction: "y" }, snap), /^\[triage, effort high\] First set your effort/);
});

test("Codex limit messages: the reset time is read correctly", async () => {
  const { isLimitError, limitResetAt } = await import("../limits.js");
  const now = Date.UTC(2026, 10, 5, 22, 57);
  const msg = "You've reached your Codex subscription usage limit. Next reset in 46 minutes, Nov 5 at 6:43 PM EST. Wait until the reset time, use another Codex account if available.";
  assert.equal(isLimitError(msg), true);
  assert.equal(new Date(limitResetAt(msg, now)).toISOString(), "2026-11-05T23:44:00.000Z"); // 46 min + 1 min margin
  const noRel = "Codex usage limit reached. Try again Nov 5 at 6:43 PM EST.";
  assert.equal(new Date(limitResetAt(noRel, now)).toISOString(), "2026-11-05T23:43:00.000Z");
  assert.equal(new Date(limitResetAt("usage limit. Next reset in 4 hours", now)).toISOString(), "2026-11-06T02:58:00.000Z");
});

test("the worker's final report is kept, not the narration before it", async () => {
  const { finalAnswer, recordResultText } = await import("../jobs.js");
  const narration = ["I'll start by exploring the project.", "Found the live host. Let me check it.", "Now building the composites."];
  const report = "The village home differs from the approved mockup in 6 places.\n\nRESULT: partly done\nChecks: ...";
  assert.equal(finalAnswer([...narration, report]), report);
  assert.equal(finalAnswer([...narration, report, "  "]), report);
  assert.equal(finalAnswer(narration), "Now building the composites.");
  const d = emptyState();
  spawn(d, 0);
  recordResultText(d, KEY, report, CFG);
  assert.equal(recordResultText(d, KEY, "Let me check one more thing.", CFG), false); // a report is not overwritten by narration
  assert.equal(d.jobs[KEY].resultText, report);
});

test("the orchestrator's board move becomes its answer under the worker's result", async () => {
  const { boardReplyText } = await import("../voice.js");
  const cfg = { agentHandles: { devops: "devops_bot" } };
  const job = { agentId: "devops", label: "demo: fix CI" };
  assert.equal(boardReplyText(cfg, job, "ab12cd34", "qa", "Checked pipeline **1234** myself: green."),
    "@devops_bot Checked pipeline <b>1234</b> myself: green.\n<i>Board: ab12cd34 → QA</i>");
  assert.equal(boardReplyText(cfg, job, "ab12cd34", "todo", ""), "@devops_bot thanks, I've taken it from here.\n<i>Board: ab12cd34 → To do</i>");
});

test("a brief missing required lines is completed from its board items instead of rejected", async () => {
  const { completeBrief } = await import("../policy.js");
  const board = new Map([["ab12cd34", { id: "ab12cd34", project: "demo", done_when: "pipeline green and the fix live" }]]);
  const brief = "Fix the modal buttons on phone (item ab12cd34). The fix sits in the worktree.";
  const out = completeBrief(brief, board);
  for (const line of ["Project: demo", "Items: ab12cd34", "Done when: pipeline green and the fix live", "Stop if: anything that needs the owner's OK"]) assert.ok(out.includes(line), line);
  assert.match(out, /\nScope: in: exactly these items/);
  const full = "Project: demo\nScope: x\nItems: ab12cd34\nDone when: y\nStop if: z";
  assert.equal(completeBrief(full, board), full); // nothing to add
  assert.equal(completeBrief("No item ids here", board), "No item ids here");
  // and the completed brief passes the old brief-field check
  const { decide, createState } = await import("../guard.js");
  const r = decide({ toolName: "sessions_spawn", params: { agentId: "writer", task: out + " ".repeat(700), context: "isolated", label: "demo: x" } },
    { agentId: "coordinator", sessionKey: "agent:coordinator:main" }, createState(), {}, null, Date.now());
  assert.notEqual(r && r.rule, "briefFields");
});

test("no dispatch while a deploy restarts the gateway", () => {
  const now = Date.now();
  const COORD = { agentId: "coordinator", sessionKey: ORC };
  const task = { toolName: "sessions_spawn", params: { agentId: "devops", task: "Project: demo\nFix CI", label: "demo: x" } };
  const r = policyDecide(task, COORD, { maintenanceSince: () => now - 60000 }, {}, null, now);
  assert.equal(r.rule, "maintenance");
  assert.notEqual((policyDecide(task, COORD, { maintenanceSince: () => now - 40 * 60000 }, {}, null, now) || {}).rule, "maintenance"); // stale flag ignored
  assert.notEqual((policyDecide(task, COORD, { maintenanceSince: () => 0 }, {}, null, now) || {}).rule, "maintenance");
});

test("a strict project's distinctive aliases match normally; its common-word name stays strict", async () => {
  const { projectsMentioned } = await import("../topics.js");
  const projects = { ai: { topic: 153, strict: true, aliases: ["acmeplat", "acmeplat.cloud"] }, "acmeplat-hub": { topic: 154 } };
  assert.deepEqual(projectsMentioned("The Acmeplat checkout copy is fixed", projects), ["ai"]);
  assert.deepEqual(projectsMentioned("panel.acmeplat.cloud allowlist updated", projects), ["ai"]);
  assert.deepEqual(projectsMentioned("acmeplat-hub caddy bound to loopback", projects), ["acmeplat-hub"]);
  assert.deepEqual(projectsMentioned("we use ai for this", projects), []); // the common word alone is not the project
  assert.deepEqual(projectsMentioned("Project: ai\nFix X", projects), ["ai"]);
});

test("each brief names the skills that fit its task", async () => {
  const { selectSkills, skillsLine } = await import("../skills.js");
  const designer = [
    { name: "product-design-playbook", about: "How a senior product designer works here", always: true },
    { name: "verification-before-completion", about: "Use when about to claim work is complete; evidence before claims", always: true },
    { name: "design-taste-frontend", about: "Builds professional company websites, landing page, product, shop, SaaS or game site; when a page looks generic or AI-made" },
    { name: "ui-ux-pro-max", about: "UI/UX design intelligence: accessibility, responsive layout, typography, color, touch targets, mobile" },
    { name: "emil-design-eng", about: "UI polish, component design, animation decisions and the invisible details" },
    { name: "break-ui", about: "Try to break a UI with worst-case data: long names, huge counts, empty states, non-Latin text" },
    { name: "canvas-design", about: "Create visual art, posters and images as PNG or PDF" },
  ];
  const a = selectSkills("Project: demo\nRedesign the landing page so it stops looking generic; responsive on mobile with real typography", designer);
  assert.deepEqual(a.slice(0, 2), ["product-design-playbook", "verification-before-completion"]);
  assert.ok(a.includes("design-taste-frontend") && a.includes("ui-ux-pro-max"), a.join());
  assert.ok(!a.includes("canvas-design"), a.join());
  const b = selectSkills("The task board breaks with long agent names and when there are zero items", designer);
  assert.ok(b.includes("break-ui"), b.join());
  assert.match(skillsLine(a), /^Skills for this task \(open each one's SKILL.md before you start and follow it\): product-design-playbook/);
  assert.deepEqual(selectSkills("anything", []), []);
});
