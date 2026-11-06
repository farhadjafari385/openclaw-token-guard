import test from "node:test";
import assert from "node:assert/strict";
import { allowAgentWake, wakeMessage } from "../wake.js";
import { CHECK_COMMAND } from "../policy.js";
import { emptyState, recordSpawn, recordCheck, mergeJobsConfig } from "../jobs.js";

test("an agent can wake the orchestrator, at most once per 10 minutes, 6 per hour for the team", () => {
  const st = {};
  const t0 = Date.UTC(2026, 10, 7, 3, 0);
  assert.equal(allowAgentWake(st, "devops", t0).ok, true);
  const again = allowAgentWake(st, "devops", t0 + 5 * 60000);
  assert.equal(again.ok, false);
  assert.match(again.why, /once per 10 minutes/);
  assert.equal(allowAgentWake(st, "devops", t0 + 11 * 60000).ok, true);
  for (const a of ["qa", "writer", "reviewer", "product"]) assert.equal(allowAgentWake(st, a, t0 + 12 * 60000).ok, true);
  assert.equal(allowAgentWake(st, "designer", t0 + 13 * 60000).ok, false); // 6 in this hour already
  assert.equal(allowAgentWake(st, "designer", t0 + 61 * 60000).ok, true); // the first ones aged out
});

test("the wake names the agent, its task and items, and is cut to the limit", () => {
  const m = wakeMessage("devops", "blocked", "x".repeat(500), { label: "demo: fix CI", items: ["a1b2c3d4"] });
  assert.match(m, /^\[agent wake\] devops on "demo: fix CI" \(items a1b2c3d4\), blocked: x{300}\n/);
  assert.match(wakeMessage("qa", "nonsense", "hi", null), /qa on no task, other: hi/);
});

test("the guard records a task's local checks (the commands its pipeline runs)", () => {
  const cfg = mergeJobsConfig({});
  const d = emptyState();
  recordSpawn(d, { childSessionKey: "agent:writer:subagent:1", agentId: "writer", label: "demo: x", topic: 151, requesterSessionKey: "agent:coordinator:main" }, "b", 0, cfg);
  for (const c of ["npm run lint", "npm run typecheck", "pnpm test", "npm run ci:local", "gitleaks detect"]) assert.equal(CHECK_COMMAND.test(c), true, c);
  for (const c of ["git status", "cat README.md", "ls -la"]) assert.equal(CHECK_COMMAND.test(c), false, c);
  assert.equal(recordCheck(d, "agent:writer:subagent:1"), true);
  assert.equal(d.jobs["agent:writer:subagent:1"].checksRun, 1);
  assert.equal(recordCheck(d, "agent:writer:subagent:2"), false);
});
