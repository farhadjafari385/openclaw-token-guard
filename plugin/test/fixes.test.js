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
