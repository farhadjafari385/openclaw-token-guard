// Owner-action quick exit, Handoff carried by the guard, User path proof, owner-blocked dispatch gate, one merge at a time.
import test from "node:test";
import assert from "node:assert/strict";
import { ownerActionExit, handoffOf, withHandoffs, hasUserPath, isUserPathProof, policyDecide, MERGE_COMMAND } from "../policy.js";
import { moveAfterJob } from "../board.js";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const BRIEF = (items) => `Project: demo (/srv/demo)\nScope: x\nItems: ${items}\nDone when: x\nStop if: x\nModel: anthropic/claude-sonnet-5-5\nEffort: medium`;

test("a blocked result that names the owner's action is a quick exit", () => {
  const report = "The mail account is signed out in the team browser.\n\nRESULT: blocked\nOwner action: owner account: sign the team browser into the mail account once\nNext: resend";
  assert.equal(ownerActionExit(report), "owner account: sign the team browser into the mail account once");
  assert.equal(ownerActionExit("**RESULT:** blocked\n- Owner action: owner money: approve the $40 plan"), "owner money: approve the $40 plan");
  assert.equal(ownerActionExit("RESULT: blocked\nNext: lint fails"), null);
  assert.equal(ownerActionExit("RESULT: blocked\nOwner action: fix the failing test"), null);
  assert.equal(ownerActionExit("RESULT: done\nOwner action: owner account: nothing"), null);
  // A long line keeps the owner reason in the stored note, so the item is still held.
  const long = ownerActionExit(`RESULT: blocked\nOwner action: ${"x".repeat(400)} owner account: sign in`);
  assert.match(long, /owner account: sign in/);
  assert.ok(long.length <= 280);
});

test("the owner-action exit moves items to Blocked from every work column, Review included", () => {
  for (const role of ["writer", "reviewer", "qa", "devops", "growth"]) {
    for (const before of ["in_progress", "review", "qa"]) {
      const m = moveAfterJob(before, role, "blocked", "owner account: sign in", "j1");
      assert.equal(m.to, "blocked", `${role} from ${before}`);
      assert.equal(m.note, "Owner action: owner account: sign in [job j1]");
    }
    // Without an owner action a blocked claim still goes to Review; items moved elsewhere are left alone.
    assert.equal(moveAfterJob("in_progress", role, "blocked", null, "j1").to, "review");
    assert.equal(moveAfterJob("done", role, "blocked", "owner account: x", "j1").to, "done");
    assert.equal(moveAfterJob("todo", role, "blocked", "owner account: x", "j1").to, "todo");
  }
  assert.equal(moveAfterJob("qa", "qa", "done", null, "j1").to, "done");
});

test("the Handoff block is read verbatim, at most 10 lines of 300 characters", () => {
  const r = "Fixed it.\n\nRESULT: done\nChecks: PASS\nHandoff:\n- bot.php:120 sends a link the client cannot fetch\n- ruled out: webhook, queue\n- changed: send the file bytes\n- next: QA as a real user\n\ntrailing";
  assert.equal(handoffOf(r), "- bot.php:120 sends a link the client cannot fetch\n- ruled out: webhook, queue\n- changed: send the file bytes\n- next: QA as a real user");
  assert.equal(handoffOf("Handoff: one line only"), "one line only");
  assert.equal(handoffOf("Handoff:\n" + Array.from({ length: 14 }, (_, i) => `l${i}`).join("\n")).split("\n").length, 10);
  assert.equal(handoffOf(`Handoff:\n${"y".repeat(900)}`).length, 300);
  assert.equal(handoffOf("RESULT: done"), null);
});

test("every brief gets each item's newest usable Handoff, once per job and once per brief", () => {
  const job = (o) => Object.assign({ status: "ended", endedAt: NOW - 3600000, agentId: "writer" }, o);
  const jobs = [
    job({ items: ["aa11bb22"], endedAt: NOW - 7200000, short: "old111", resultText: "Handoff:\n- old fact" }),
    job({ items: ["aa11bb22", "cc33dd44"], agentId: "reviewer", short: "new222", resultText: "RESULT: done\nHandoff:\n- merged MR 12, main green\n- next: QA" }),
    job({ items: ["aa11bb22"], endedAt: NOW - 600000, short: "nohand", resultText: "RESULT: done" }),
    job({ items: ["aa11bb22"], endedAt: NOW - 500000, short: "failed", resultText: "RESULT: failed\nHandoff:\n- from a failed task" }),
    job({ items: ["aa11bb22"], endedAt: NOW - 400000, short: "cut", outcome: "timeout", resultText: "Handoff:\n- from a cut-off task" }),
    job({ items: ["aa11bb22"], endedAt: NOW - 300000, short: "noproof", missingEvidence: ["/x.png"], resultText: "Handoff:\n- proof missing" }),
    { status: "running", items: ["aa11bb22"], resultText: "Handoff:\n- running, ignored" },
    job({ items: ["ee55ff66"], endedAt: NOW - 72 * 3600000, short: "stale", resultText: "Handoff:\n- three days old" }),
  ];
  const out = withHandoffs(BRIEF("aa11bb22, cc33dd44, ee55ff66"), jobs, NOW);
  assert.match(out, /Last Handoff \(verbatim; do not re-check what it proves\):\n- aa11bb22, cc33dd44, from reviewer \(job new222\):\n {2}- merged MR 12, main green\n {2}- next: QA$/);
  assert.equal(out.match(/merged MR 12/g).length, 1, "one block per job");
  assert.doesNotMatch(out, /old fact|running, ignored|failed task|cut-off|proof missing|three days old/);
  // Run again on its own output (a restart re-dispatch uses the stored brief): unchanged.
  assert.equal(withHandoffs(out, jobs, NOW), null);
  // Pasted by the orchestrator already, no items, or no Handoff: unchanged.
  assert.equal(withHandoffs(`${BRIEF("aa11bb22")}\n- merged MR 12, main green\n- next: QA`, jobs, NOW), null);
  assert.equal(withHandoffs("Project: demo\nDone when: x", jobs, NOW), null);
  assert.equal(withHandoffs(BRIEF("ab12cd34"), jobs, NOW), null);
});

test("a User path is proof only with an action, an arrow and a returned id that has a number", () => {
  for (const ok of [
    "User path: sent a photo to the bot → enhanced photo back, job 77",
    "User path: bought Starter as a new user -> payment 4512 paid",
    "User path: /start as a new user => result file received, message 9912",
    "User path:\n- sent a photo → job 77 delivered",
  ]) assert.equal(isUserPathProof(ok), true, ok);
  for (const bad of [
    "User path: ok",
    "User path: job status is completed",
    "User path: ran it → it works",
    "User path: opened the site → HTTP 200",
    "User path: sent → message sent",
    "User path: → job 77",
    "webhook has no error; 19 tools listed",
  ]) assert.equal(isUserPathProof(bad), false, bad);
});

test("User path proof is linear: a long note is checked fast (it runs in the gateway thread)", () => {
  for (const unit of ["x → y ", "x -> job y ", "a → id - "]) {
    const note = `User path: ${unit.repeat(2000)}`;
    const t0 = process.hrtime.bigint();
    isUserPathProof(note);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 50, `${ms} ms for ${note.length} chars`);
  }
});

test("User path proof from before the item was reopened does not count", () => {
  const proof = "User path: sent a photo → job 77 delivered";
  assert.equal(hasUserPath({ history: [{ to: "qa", note: proof }] }, ""), true);
  assert.equal(hasUserPath({ history: [{ to: "qa", note: proof }, { to: "done" }, { to: "in_progress", note: "bug found again" }, { to: "qa" }] }, ""), false);
  assert.equal(hasUserPath({ history: [{ to: "in_progress" }, { to: "qa", note: proof }] }, ""), true);
});

test("an item parked on the owner is not dispatched again until it is moved out of Blocked", () => {
  const board = new Map([
    ["aa11bb22", { id: "aa11bb22", project: "demo", title: "Post on the job board", status: "blocked", note: "Owner action: owner account: sign in to the job board [job x1]" }],
    ["cc33dd44", { id: "cc33dd44", project: "demo", title: "Fix lint", status: "blocked", note: "lint fails on CI" }],
  ]);
  const ps = { boardItems: () => board, runningItemIds: () => new Set() };
  const cfg = { orchestratorAgent: "coordinator", projects: { demo: "/srv/demo" }, board: { requireItems: true } };
  const COORD = { agentId: "coordinator", sessionKey: "agent:coordinator:main" };
  const spawn = (items) => ({ toolName: "sessions_spawn", params: { agentId: "growth", task: BRIEF(items) } });
  const r = policyDecide(spawn("aa11bb22"), COORD, ps, cfg);
  assert.ok(r && r.block, "owner-blocked item refused");
  assert.match(r.blockReason, /waits on the owner or an outside party/);
  assert.match(r.blockReason, /note starting "Operator:"/);
  const ok = policyDecide(spawn("cc33dd44"), COORD, ps, cfg);
  assert.ok(!ok || !/waits on the owner/.test(ok.blockReason || ""), "a team-clearable block is not held by this rule");
});

test("one merge at a time per project: a merge waits while the last merge's main pipeline runs", () => {
  const W = { agentId: "reviewer", sessionKey: "agent:reviewer:subagent:m2" };
  const url = "https://gitlab.com/g/demo/-/pipelines/901";
  const inflight = [{ sessionKey: "agent:reviewer:subagent:m1", project: "Demo (/srv/demo)", url }];
  const ps = (list) => ({ jobFor: () => ({ project: "demo-alias (/srv/demo)", status: "running", checksRun: 1 }), mergesInFlight: () => list });
  const cfg = { projects: { demo: { path: "/srv/demo", aliases: ["demo-alias"] }, other: { path: "/srv/other" } } };
  const merge = (command) => ({ toolName: "exec", params: { command } });
  for (const c of ["glab mr merge 12 --yes", "gh pr merge 4 --squash", "glab -R g/demo mr merge 12", "gh -R o/demo pr merge 4",
    "curl -X PUT https://gitlab.com/api/v4/projects/1/merge_requests/12/merge"]) {
    const r = policyDecide(merge(c), W, ps(inflight), cfg);
    assert.ok(r && r.block && /one merge at a time/.test(r.blockReason), c);
    assert.ok(r.blockReason.includes(`RESULT: waiting and that pipeline link (${url})`), "points at the pipeline to follow");
  }
  for (const list of [[], [{ ...inflight[0], project: "other (/srv/other)" }], [{ ...inflight[0], sessionKey: W.sessionKey }]]) {
    const r = policyDecide(merge("glab mr merge 12 --yes"), W, ps(list), cfg);
    assert.ok(!r || !/one merge at a time/.test(r.blockReason || ""));
  }
  for (const c of ["glab mr view 12", "glab mr create --merge-when-pipeline-succeeds", "git push -o merge_request.create"]) {
    assert.equal(MERGE_COMMAND.test(c), false, c);
  }
});
