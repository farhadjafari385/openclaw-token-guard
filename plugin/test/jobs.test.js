import test from "node:test";
import assert from "node:assert/strict";
import { isLimitError, limitResetAt } from "../limits.js";
import {
  emptyState, recordSpawn, recordActivity, recordUsage, recordEnd, recordResultText, setClaudeLimited, scanJobs, lastAssistantText, mergeJobsConfig,
} from "../jobs.js";
import { topicFor, formatDispatch, formatResult, createMirror, projectKey } from "../mirror.js";

const MIN = 60000;
const CFG = mergeJobsConfig({});
const ORC = "agent:coordinator:telegram:group:-100:topic:151";
const CHILD = "agent:devops:subagent:1";

function spawned(data, now, extra = {}) {
  return recordSpawn(data, {
    childSessionKey: CHILD, agentId: "devops", label: "demo: fix CI", project: "demo", topic: 151,
    requesterSessionKey: ORC, brief: "Project: demo\nItems:\nab12cd34\nDone when: pipeline green", doneWhen: "pipeline green", ...extra,
  }, "boot1", now, CFG);
}
const env = (extra = {}) => ({ bootId: "boot1", bootStartedAt: 0, orchestratorAgent: "coordinator", inboxItems: [], ...extra });
const kinds = (actions) => actions.map((a) => `${a.kind}:${a.reason || a.topic}`);

test("limits: recognise Claude limit errors and parse the reset time", () => {
  assert.equal(isLimitError("You've hit your session limit · resets 10:30am (America/New_York)"), true);
  assert.equal(isLimitError("You've hit your weekly limit · resets 10pm (America/New_York)"), true);
  assert.equal(isLimitError("CLI backend returned an empty response."), false);
  const now = Date.UTC(2026, 10, 3, 14, 41); // 09:41 in New York (EST)
  assert.equal(new Date(limitResetAt("You've hit your session limit · resets 10:30am (America/New_York)", now)).toISOString(), "2026-11-03T15:30:00.000Z");
  assert.equal(new Date(limitResetAt("hit your weekly limit · resets 10pm (America/New_York)", now)).toISOString(), "2026-11-04T03:00:00.000Z");
  assert.equal(new Date(limitResetAt("hit your weekly limit · resets Nov 6, 2pm (America/New_York)", now)).toISOString(), "2026-11-06T19:00:00.000Z");
  assert.equal(limitResetAt("usage limit reached", now), now + 60 * MIN);
});

test("a finished task the orchestrator has not acted on is followed up, twice, then escalated", () => {
  const d = emptyState();
  spawned(d, 0);
  recordResultText(d, CHILD, "RESULT: done. Pipeline 42 green.", CFG);
  recordEnd(d, CHILD, "ok", "", 10 * MIN);
  assert.deepEqual(scanJobs(d, CFG, 12 * MIN, env()), []); // not yet
  let a = scanJobs(d, CFG, 15 * MIN, env());
  assert.deepEqual(kinds(a), ["wake:ended"]);
  assert.equal(a[0].sessionKey, ORC);
  assert.match(a[0].message, /Pipeline 42 green/);
  assert.deepEqual(scanJobs(d, CFG, 20 * MIN, env()), []); // waits before re-waking
  assert.deepEqual(kinds(scanJobs(d, CFG, 36 * MIN, env())), ["wake:ended"]);
  a = scanJobs(d, CFG, 60 * MIN, env());
  assert.deepEqual(kinds(a), ["post:151"]);
  assert.match(a[0].text, /has not acted/);
  assert.deepEqual(scanJobs(d, CFG, 90 * MIN, env()), []);
});

test("no follow-up when the orchestrator acted after the task ended", () => {
  const d = emptyState();
  spawned(d, 0);
  recordEnd(d, CHILD, "ok", "", 10 * MIN);
  recordActivity(d, ORC, "coordinator", "coordinator", 11 * MIN);
  assert.deepEqual(scanJobs(d, CFG, 20 * MIN, env()), []);
});

test("a silent running task is flagged once per stall; activity resets it", () => {
  const d = emptyState();
  spawned(d, 0);
  recordActivity(d, CHILD, "devops", "coordinator", 5 * MIN);
  assert.deepEqual(scanJobs(d, CFG, 20 * MIN, env()), []);
  const a = scanJobs(d, CFG, 36 * MIN, env());
  assert.deepEqual(kinds(a), ["post:151", "wake:stall"]);
  assert.deepEqual(scanJobs(d, CFG, 40 * MIN, env()), []);
  recordActivity(d, CHILD, "devops", "coordinator", 41 * MIN);
  assert.deepEqual(kinds(scanJobs(d, CFG, 72 * MIN, env())), ["post:151", "wake:stall"]);
});

test("a task cut off by a restart is re-dispatched with its brief after the grace period", () => {
  const d = emptyState();
  spawned(d, 0);
  const later = env({ bootId: "boot2", bootStartedAt: 100 * MIN });
  assert.deepEqual(scanJobs(d, CFG, 103 * MIN, later), []);
  const a = scanJobs(d, CFG, 109 * MIN, later);
  assert.deepEqual(kinds(a), ["post:151", "wake:interrupted"]);
  assert.match(a[1].message, /Done when: pipeline green/);
  assert.equal(d.jobs[CHILD].status, "interrupted");
});

test("open inbox work with nothing running wakes the orchestrator; no change after 3 wakes escalates", () => {
  const d = emptyState();
  const inbox = [{ id: "ab12cd34", project: "demo", title: "deploy", status: "open", owner: "devops" }, { id: "ffff0000", status: "done" }];
  const e = env({ inboxItems: inbox, idleWakeSession: "agent:coordinator:main" });
  let t = 100 * MIN;
  for (let i = 0; i < 3; i++, t += 31 * MIN) {
    const a = scanJobs(d, CFG, t, e);
    assert.deepEqual(kinds(a), ["wake:idle"]);
    assert.match(a[0].message, /ab12cd34 demo: deploy/);
    assert.doesNotMatch(a[0].message, /ffff0000/);
  }
  const a = scanJobs(d, CFG, t, e);
  assert.deepEqual(kinds(a), ["post:system"]);
  assert.match(a[0].text, /stalled/);
  assert.deepEqual(scanJobs(d, CFG, t + 31 * MIN, e), []);
});

test("idle check skips items covered by a running task and quiet periods without open work", () => {
  const d = emptyState();
  spawned(d, 90 * MIN);
  const inbox = [{ id: "ab12cd34", project: "demo", title: "deploy", status: "dispatched", owner: "devops" }];
  assert.deepEqual(scanJobs(d, CFG, 100 * MIN, env({ inboxItems: inbox })).filter((a) => a.reason === "idle"), []);
  const d2 = emptyState();
  assert.deepEqual(scanJobs(d2, CFG, 100 * MIN, env({ inboxItems: [] })), []);
});

test("daily wake cap", () => {
  const d = emptyState();
  const cfg = mergeJobsConfig({ maxWakesPerDay: 1 });
  spawned(d, 0);
  recordEnd(d, CHILD, "ok", "", 0);
  recordSpawn(d, { childSessionKey: "agent:qa:subagent:2", agentId: "qa", label: "x", requesterSessionKey: ORC }, "boot1", 0, cfg);
  recordEnd(d, "agent:qa:subagent:2", "ok", "", 0);
  const a = scanJobs(d, cfg, 10 * MIN, env());
  assert.equal(a.filter((x) => x.kind === "wake").length, 1);
  assert.equal(a.filter((x) => x.kind === "post" && /daily limit/.test(x.text)).length, 1);
});

test("task budget and Claude limit state", () => {
  const d = emptyState();
  spawned(d, 0);
  const cfg = mergeJobsConfig({ budgetTokens: 1000 });
  assert.equal(recordUsage(d, CHILD, { input: 100, cacheRead: 500, output: 50 }, cfg), null);
  assert.equal(recordUsage(d, CHILD, { cacheRead: 600 }, cfg).overBudget, true);
  assert.equal(recordUsage(d, CHILD, { cacheRead: 600 }, cfg), null); // reported once
  assert.equal(setClaudeLimited(d, 5000, "limit"), true);
  assert.equal(setClaudeLimited(d, 4000, "limit"), false);
});

test("final answer extraction", () => {
  assert.equal(lastAssistantText([{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "text", text: "RESULT: done" }] }]), "RESULT: done");
  assert.equal(lastAssistantText([{ message: { role: "assistant", content: "ok" } }]), "ok");
  assert.equal(lastAssistantText(null), "");
});

test("mirror: topics, formatting, and posting through the right bot", async () => {
  const cfg = { chatId: "-100", systemTopic: 160, defaultTopic: 160, projectTopics: { demo: 151, "openclaw-ui": 2715 }, botTokenFiles: { coordinator: "/t/orc", devops: "/t/dev" }, minIntervalMs: 0 };
  assert.equal(projectKey("demo (/srv/projects/demo)"), "demo");
  assert.equal(topicFor(cfg, "demo (/srv/o)", 999), 151);
  assert.equal(topicFor(cfg, "the openclaw-ui repo", null), 2715);
  assert.equal(topicFor(cfg, "unknown", 777), 777);
  assert.equal(topicFor(cfg, "unknown", null), 160);
  const job = { agentId: "devops", label: "demo: fix CI", short: "abc123", model: "anthropic/claude-sonnet-5", thinking: "low", doneWhen: "pipeline green", outcome: "ok", spawnedAt: 0, endedAt: 5 * MIN, resultText: "RESULT: done" };
  assert.match(formatDispatch(cfg, job), /▶️ devops ← demo: fix CI\nclaude-sonnet-5 · effort low\nDone when: pipeline green/);
  assert.match(formatResult(cfg, job), /✅ demo: fix CI — ok · 5 min\nRESULT: done/);
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; };
  const m = createMirror({ cfg, fetchImpl, readFile: (p) => (p === "/t/dev" ? "DEVTOKEN\n" : "ORCTOKEN") });
  await m.post({ agentId: "devops", topic: 151, text: "hello" });
  await m.post({ agentId: "nobody", topic: "system", text: "sys" });
  assert.equal(calls[0].url, "https://api.telegram.org/botDEVTOKEN/sendMessage");
  assert.deepEqual(calls[0].body, { chat_id: "-100", text: "hello", disable_web_page_preview: true, message_thread_id: 151 });
  assert.equal(calls[1].url, "https://api.telegram.org/botORCTOKEN/sendMessage");
  assert.equal(calls[1].body.message_thread_id, 160);
});

test("two plugin generations never lose each other's jobs", async () => {
  const { mergeStates, createJobStore } = await import("../jobs.js");
  const a = emptyState();
  const b = emptyState();
  recordSpawn(a, { childSessionKey: "agent:qa:subagent:1", agentId: "qa", label: "x" }, "g1", 1000, CFG);
  recordSpawn(b, { childSessionKey: "agent:qa:subagent:2", agentId: "qa", label: "y" }, "g2", 2000, CFG);
  recordSpawn(b, { childSessionKey: "agent:qa:subagent:1", agentId: "qa", label: "x" }, "g1", 1000, CFG);
  recordEnd(b, "agent:qa:subagent:1", "ok", "", 5000);
  const m = mergeStates(a, b);
  assert.deepEqual(Object.keys(m.jobs).sort(), ["agent:qa:subagent:1", "agent:qa:subagent:2"]);
  assert.equal(m.jobs["agent:qa:subagent:1"].status, "ended"); // the ended copy wins
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const file = join(mkdtempSync(join(tmpdir(), "tg-jobs-")), "jobs.json");
  const s1 = createJobStore(file); s1.load();
  const s2 = createJobStore(file); s2.load();
  recordSpawn(s1.data, { childSessionKey: "k1", agentId: "a" }, "g", 1, CFG); s1.touch(); s1.save();
  recordSpawn(s2.data, { childSessionKey: "k2", agentId: "a" }, "g", 2, CFG); s2.touch(); s2.save(); // must not drop k1
  const s3 = createJobStore(file); s3.load();
  assert.deepEqual(Object.keys(s3.data.jobs).sort(), ["k1", "k2"]);
});

test("mirror retries a failed send", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; if (calls < 3) throw new Error("fetch failed"); return { ok: true, status: 200, json: async () => ({ result: { message_id: 7 } }) }; };
  const m = createMirror({ cfg: { chatId: "-1", botTokenFiles: { coordinator: "/t" }, minIntervalMs: 0 }, fetchImpl, readFile: () => "T", retryDelayMs: 1 });
  assert.equal(await m.post({ agentId: "coordinator", topic: 5, text: "hi" }), 7);
  assert.equal(calls, 3);
});
