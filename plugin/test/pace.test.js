import test from "node:test";
import assert from "node:assert/strict";
import { paceHold, paceText, WEEK_MS } from "../pace.js";
import { scanJobs, emptyState, recordSpawn, recordEnd, mergeJobsConfig } from "../jobs.js";

const resets = Date.parse("2026-11-21T02:00:00Z");
const start = resets - WEEK_MS;
const at = (days) => start + days * 86400000;
const usage = (week, five = 10) => ({ seven_day: { utilization: week, resets_at: new Date(resets).toISOString() }, five_hour: { utilization: five, resets_at: "2026-11-17T15:10:00Z" } });

test("on an even pace there is no hold", () => {
  assert.equal(paceHold(usage(40), at(3.5)), null); // 50% of the week gone, 40% used
  assert.equal(paceHold(usage(54), at(3.5)), null); // within the 5% lead
});

test("ahead of the pace: hold until an even pace reaches the use", () => {
  const h = paceHold(usage(80), at(3.5));
  assert.equal(h.reason, "pace");
  assert.equal(h.until, start + 0.75 * WEEK_MS); // (80 - 5)% of the week
  assert.match(paceText(h, at(3.5)), /ahead of its weekly allowance \(80%.*50% of the week gone\)/);
});

test("the real case of 2026-11-17: 95% used 3.5 days in holds for the owner's reserve near the reset", () => {
  const now = Date.parse("2026-11-17T14:01:00Z");
  const h = paceHold(usage(95, 85), now);
  assert.equal(h.reason, "pace");
  assert.ok(h.until > now && h.until < resets);
  const r = paceHold(usage(97), now);
  assert.equal(r.reason, "reserve");
  assert.equal(r.until, resets);
});

test("the 5-hour window holds until it resets", () => {
  const now = Date.parse("2026-11-17T14:01:00Z");
  const h = paceHold(usage(30, 96), now);
  assert.equal(h.reason, "fiveHour");
  assert.equal(h.until, Date.parse("2026-11-17T15:10:00Z"));
  assert.equal(paceHold(usage(30, 80), now), null);
});

test("a missing or past reading never holds", () => {
  assert.equal(paceHold(null, at(1)), null);
  assert.equal(paceHold({ seven_day: { utilization: 99, resets_at: "2026-11-01T00:00:00Z" } }, at(1)), null);
  assert.equal(paceHold({}, at(1)), null);
});

test("the job tracker does not wake the orchestrator during a pace hold", () => {
  const MIN = 60000, CFG = mergeJobsConfig({}), CHILD = "agent:devops:subagent:1";
  const env = { bootId: "boot1", bootStartedAt: 0, orchestratorAgent: "coordinator", inboxItems: [] };
  const run = (hold) => {
    const d = emptyState();
    recordSpawn(d, { childSessionKey: CHILD, agentId: "devops", label: "demo: fix CI", project: "demo", topic: 151,
      requesterSessionKey: "agent:coordinator:telegram:group:-100:topic:151", brief: "Project: demo\nItems:\nab12cd34\nDone when: green", doneWhen: "green" }, "boot1", 0, CFG);
    recordEnd(d, CHILD, "ok", "", 0);
    if (hold) d.paceHold = { until: 100 * MIN, reason: "pace" };
    return scanJobs(d, CFG, 10 * MIN, env).filter((a) => a.kind === "wake").length;
  };
  assert.equal(run(false), 1);
  assert.equal(run(true), 0);
});

// Owner 2026-11-21: "at most ~6 more points of the weekly limit in the next 12 hours" (started at 8%).
test("an owner budget window holds dispatches above start + rate per hour, only while it runs", () => {
  const start = "2026-11-21T12:00:00Z";
  const cfg = { windowStart: start, windowStartPercent: 8, windowPerHour: 0.5, windowHours: 12 };
  const u = (week) => ({ seven_day: { utilization: week, resets_at: "2026-11-28T02:00:00Z" }, five_hour: { utilization: 10, resets_at: "2026-11-21T20:00:00Z" } });
  const t = (h) => Date.parse(start) + h * 3600000;
  assert.equal(paceHold(u(9), t(4), cfg), null, "4 h in, 10% allowed, 9% used");
  const h = paceHold(u(11), t(4), cfg);
  assert.equal(h.reason, "budget");
  assert.equal(h.allowed, 10);
  assert.equal(h.until, t(6), "11% is allowed 6 h in");
  assert.match(paceText(h, t(4)), /owner's budget allows 10%/);
  assert.equal(paceHold(u(11), t(13), cfg), null, "the window is over");
  assert.equal(paceHold(u(10), t(-1), cfg), null, "not started yet (and within the even weekly pace)");
  assert.equal(paceHold(u(11), t(4), {}), null, "no window configured");
});
