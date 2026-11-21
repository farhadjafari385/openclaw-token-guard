import test from "node:test";
import assert from "node:assert/strict";
import { recordSample, loopHold, mergeLoopConfig } from "../loopwatch.js";
import { policyDecide } from "../policy.js";

const fresh = () => ({ last: 0, lastBad: 0, runStart: 0, worst: 0, timer: null });

test("a late timer holds dispatches until the loop has been calm", () => {
  const st = fresh(); const t0 = 1e12;
  assert.equal(loopHold(st, t0), 0);
  recordSample(st, t0, t0 - 1100, {});            // 1.1 s late: normal here
  assert.equal(loopHold(st, t0), 0);
  recordSample(st, t0 + 1000, t0 - 60000 + 1000, {}); // 60 s late: blocked
  assert.ok(loopHold(st, t0 + 2000) > t0 + 2000);
  assert.equal(loopHold(st, t0 + 1000 + 120000), 0);  // calm for calmMs
});

test("the hold has a ceiling for a chronically busy host", () => {
  const st = fresh(); const cfg = mergeLoopConfig({});
  let now = 1e12;
  for (let i = 0; i < 20; i++) { now += 60000; recordSample(st, now, now - 9000, {}); } // 9 s late every minute
  assert.ok(now - st.runStart > cfg.maxHoldMs);
  assert.equal(loopHold(st, now), 0);
});

test("a 4 s hiccup on a loaded host does not hold launches (owner 2026-11-21)", () => {
  const st = fresh(); const t0 = 1e12;
  recordSample(st, t0, t0 - 4000, {});
  assert.equal(loopHold(st, t0 + 1000), 0);
});

test("the loop thresholds come from the plugin config", () => {
  const st = fresh(); const t0 = 1e12;
  recordSample(st, t0, t0 - 4000, { lagMs: 3000 });
  assert.ok(loopHold(st, t0 + 1000, { lagMs: 3000 }) > t0 + 1000);
});

test("a spawn is refused while the loop is blocked, other tools are not", () => {
  const now = Date.now();
  const COORD = { agentId: "coordinator", sessionKey: "agent:coordinator:main" };
  const task = { toolName: "sessions_spawn", params: { agentId: "devops", task: "Project: demo\nFix CI", label: "demo: x" } };
  const busy = { loopHold: () => ({ until: now + 60000, text: "token-guard: busy" }) };
  assert.equal(policyDecide(task, COORD, busy, {}, null, now).rule, "gatewayBusy");
  assert.notEqual((policyDecide(task, COORD, { loopHold: () => null }, {}, null, now) || {}).rule, "gatewayBusy");
});
