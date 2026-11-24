// The orchestrator's team session starts fresh when it is quiet (see fresh.js).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dueForFreshStart, mergeFreshConfig, requestFreshStart, wakeOnlySession } from "../fresh.js";

const MIN = 60000;
const NOW = 1_800_000_000_000;
const ON = { enabled: true };

test("off unless the config switches it on: a test suite on the gateway's host must never reach the live gateway", () => {
  assert.equal(mergeFreshConfig().enabled, false);
  assert.equal(dueForFreshStart({ at: 0, triedAt: 0 }, NOW, 0), false);
  assert.equal(dueForFreshStart({ at: 0, triedAt: 0 }, NOW, 0, { enabled: "yes" }), false);
  assert.equal(dueForFreshStart({ at: 0, triedAt: 0 }, NOW, 0, { enabled: true, command: "" }), false);
});

test("a fresh start is due when the session is quiet and the last one is old enough", () => {
  assert.equal(dueForFreshStart({ at: NOW - 31 * MIN, triedAt: 0 }, NOW, NOW - 4 * MIN, ON), true);
  assert.equal(dueForFreshStart({ at: 0, triedAt: 0 }, NOW, 0, ON), true, "first wake after a gateway start");
});

test("never while the orchestrator is working, right after a fresh start, or right after a refused try", () => {
  assert.equal(dueForFreshStart({ at: NOW - 31 * MIN, triedAt: 0 }, NOW, NOW - 1 * MIN, ON), false, "tool call a minute ago");
  assert.equal(dueForFreshStart({ at: NOW - 10 * MIN, triedAt: 0 }, NOW, NOW - 9 * MIN, ON), false, "fresh 10 minutes ago");
  assert.equal(dueForFreshStart({ at: NOW - 40 * MIN, triedAt: NOW - 2 * MIN }, NOW, NOW - 9 * MIN, ON), false, "refused 2 minutes ago");
  assert.equal(dueForFreshStart({ at: 0, triedAt: 0 }, NOW, 0, { enabled: true, everyMinutes: 0 }), false, "every 0 = off");
});

test("only a session made for wakes is ever reset: never a chat with the owner, never a task", () => {
  assert.equal(wakeOnlySession("agent:coordinator:explicit:team-ops"), true);
  for (const key of ["agent:coordinator:main", "agent:coordinator:telegram:group:-1001111111111:topic:153", "agent:devops:subagent:abc", "agent:coordinator:explicit:team-ops:extra", "", undefined]) {
    assert.equal(wakeOnlySession(key), false, String(key));
  }
});

test("the request is OpenClaw's sessions.reset for that one key; a refusal or a missing command is an answer, not an error", async () => {
  const calls = [];
  const ok = await requestFreshStart((cmd, args, opts, cb) => { calls.push({ cmd, args, timeout: opts.timeout }); cb(null); }, { enabled: true, command: "/x/openclaw", timeoutSeconds: 30 }, "agent:coordinator:explicit:team-ops");
  assert.deepEqual(ok, { ok: true });
  assert.deepEqual(calls, [{ cmd: "/x/openclaw", args: ["gateway", "call", "sessions.reset", "--params", "{\"key\":\"agent:coordinator:explicit:team-ops\"}", "--json"], timeout: 30000 }]);
  const refused = await requestFreshStart((cmd, args, opts, cb) => cb(new Error("Session agent:coordinator:explicit:team-ops is still active; try again in a moment.")), ON, "k");
  assert.equal(refused.ok, false);
  assert.match(refused.error, /still active/);
  const thrown = await requestFreshStart(() => { throw new Error("spawn openclaw ENOENT"); }, ON, "k");
  assert.deepEqual(thrown, { ok: false, error: "spawn openclaw ENOENT" });
});

test("bad settings fall back to the defaults", () => {
  const c = mergeFreshConfig({ everyMinutes: "x", quietMinutes: 7, enabled: true, command: 5 });
  assert.deepEqual([c.everyMinutes, c.quietMinutes, c.retryMinutes, c.enabled, c.command], [30, 7, 5, true, "openclaw"]);
});

test("the plugin routes the job-tracker, triage and CI wakes through one helper and retries a wake race quietly", () => {
  const src = fs.readFileSync(fileURLToPath(new URL("../index.js", import.meta.url)), "utf8");
  assert.match(src, /sessionKey !== jobsCfg\.idleWakeSession \|\| !wakeOnlySession\(sessionKey\)/);
  assert.ok((src.match(/await wakeOrchestrator\(/g) || []).length >= 3);
  assert.match(src, /registry persistence\|owner changed/);
  // no other place runs the reset
  assert.equal((src.match(/requestFreshStart\(/g) || []).length, 1);
  assert.doesNotMatch(src, /"sessions\.reset"/);
});
