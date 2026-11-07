import test from "node:test";
import assert from "node:assert/strict";
import { isLoginRefusal, recordRefusal, dueRefusals, closeRefusals, refusalsWithinHour, mergeRefusals, retryWakeText, mergeRefusalConfig } from "../refusal.js";
import { mergeStates, emptyState } from "../jobs.js";

const ERR = 'sessions_spawn model "anthropic/claude-sonnet-5-5" is not usable: The selected account or native runtime is unavailable for anthropic/claude-sonnet-5-5. Restore that account before spawning this model.';

test("only OpenClaw's login-check refusal counts, not other spawn errors", () => {
  assert.equal(isLoginRefusal(ERR), true);
  assert.equal(isLoginRefusal("The native runtime is unavailable for anthropic/x: native catalog renewal failed: boom"), true);
  assert.equal(isLoginRefusal("invalid model: foo"), false);
  assert.equal(isLoginRefusal(""), false);
});

test("a refusal is retried once after the wait; a second report of the same refusal is not a new one", () => {
  const cfg = mergeRefusalConfig({ retryAfterSeconds: 120, maxPerHour: 3 });
  const data = emptyState();
  const t0 = 1_800_000_000_000;
  assert.ok(recordRefusal(data, "writer", ERR, t0));
  assert.equal(recordRefusal(data, "writer", ERR, t0 + 400), null, "the CLI reports one spawn twice");
  assert.ok(recordRefusal(data, "qa", ERR, t0 + 500), "another agent is its own refusal");
  assert.deepEqual(dueRefusals(data, t0 + 119000, cfg), []);
  const due = dueRefusals(data, t0 + 121000, cfg);
  assert.deepEqual(due.map(([, r]) => r.agentId), ["writer", "qa"]);
  due[0][1].wokeAt = t0 + 121000;
  assert.deepEqual(dueRefusals(data, t0 + 200000, cfg).map(([, r]) => r.agentId), ["qa"]);
  // after the retry wake, a new refusal of the same agent is a new try
  assert.ok(recordRefusal(data, "writer", ERR, t0 + 300000));
  assert.equal(refusalsWithinHour(data, "writer", t0 + 300000), 2);
  assert.equal(refusalsWithinHour(data, "writer", t0 + 3600000 + 1000), 1, "an hour later the first one no longer counts");
});

test("a refused dispatch that goes through when sent again needs no retry wake, in either plugin copy", () => {
  const cfg = mergeRefusalConfig({ retryAfterSeconds: 120, maxPerHour: 3 });
  const t0 = 1_800_000_000_000;
  const data = emptyState();
  recordRefusal(data, "reviewer", ERR, t0);
  recordRefusal(data, "qa", ERR, t0 + 1000);
  const stale = JSON.parse(JSON.stringify(data)); // the other copy saw only the refusals
  assert.equal(closeRefusals(data, "reviewer", t0 + 9000), 1);
  assert.equal(closeRefusals(data, "reviewer", t0 + 9500), 0, "already closed");
  assert.deepEqual(dueRefusals(data, t0 + 200000, cfg).map(([, r]) => r.agentId), ["qa"], "only the one still refused is retried");
  const merged = mergeStates(stale, data);
  assert.deepEqual(dueRefusals(merged, t0 + 200000, cfg).map(([, r]) => r.agentId), ["qa"], "the stale copy brought the closed refusal back");
  assert.deepEqual(dueRefusals(mergeStates(merged, stale), t0 + 200000, cfg).map(([, r]) => r.agentId), ["qa"]);
  // a later refusal of the same agent is a new one
  assert.ok(recordRefusal(data, "reviewer", ERR, t0 + 60000));
});

test("two plugin copies: every refusal survives the merge and a woken one stays woken", () => {
  const t0 = 1_800_000_000_000;
  const a = emptyState(), b = emptyState();
  recordRefusal(b, "writer", ERR, t0); // the old copy served the hook and saved
  const merged = mergeStates(a, b); // the ticking copy picks it up
  assert.equal(Object.keys(merged.refusals).length, 1);
  const key = Object.keys(merged.refusals)[0];
  merged.refusals[key].wokeAt = t0 + 121000;
  // the old copy saves its stale view again: the wake is not undone
  const again = mergeStates(merged, JSON.parse(JSON.stringify(b)));
  assert.equal(again.refusals[key].wokeAt, t0 + 121000);
  const back = mergeStates(JSON.parse(JSON.stringify(b)), again);
  assert.equal(back.refusals[key].wokeAt, t0 + 121000);
  assert.deepEqual(mergeRefusals(undefined, undefined), {});
});

test("the retry wake names the agent and the time, says it is no usage limit, and counts the tries", () => {
  const text = retryWakeText("Writer", Date.UTC(2026, 10, 7, 10, 18), 1, 3);
  assert.match(text, /dispatch to Writer at 10:18 UTC was refused/);
  assert.match(text, /not a usage limit/);
  assert.match(text, /Send the same dispatch again now \(retry 1 of 3\)/);
  assert.match(text, /Never tell the owner this is a usage limit/);
});
