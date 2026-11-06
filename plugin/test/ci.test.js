import test from "node:test";
import assert from "node:assert/strict";
import { parseCiLink, ciRequest, ciState, failedParts } from "../ci.js";

test("CI links in a report are found: GitLab pipeline or MR, GitHub run or pull request", () => {
  const gl = parseCiLink("RESULT: waiting\nPipeline: https://gitlab.com/group/sub/repo/-/pipelines/3034898023 (running)");
  assert.deepEqual([gl.kind, gl.project, gl.id], ["gitlab-pipeline", "group/sub/repo", "3034898023"]);
  assert.equal(ciRequest(gl).url, "https://gitlab.com/api/v4/projects/group%2Fsub%2Frepo/pipelines/3034898023");
  const mr = parseCiLink("MR https://gitlab.com/group/repo/-/merge_requests/41");
  assert.equal(ciRequest(mr).url, "https://gitlab.com/api/v4/projects/group%2Frepo/merge_requests/41");
  const pr = parseCiLink("PR https://github.com/owner/demo-ui/pull/63 is open");
  assert.deepEqual([pr.kind, pr.repo, pr.id], ["github-pr", "owner/demo-ui", "63"]);
  assert.equal(ciRequest(pr).url, "https://api.github.com/repos/owner/demo-ui/pulls/63");
  const run = parseCiLink("https://github.com/owner/demo-ui/actions/runs/42129929088");
  assert.equal(ciRequest(run).url, "https://api.github.com/repos/owner/demo-ui/actions/runs/42129929088");
  assert.equal(parseCiLink("RESULT: waiting, no link"), null);
});

test("CI state: running until the pipeline ends; green only when everything passed", () => {
  const gl = { kind: "gitlab-pipeline" };
  assert.equal(ciState(gl, { status: "running" }), "running");
  assert.equal(ciState(gl, { status: "waiting_for_resource" }), "running");
  assert.equal(ciState(gl, { status: "success" }), "success");
  assert.equal(ciState(gl, { status: "failed" }), "failed");
  assert.equal(ciState(gl, { status: "canceled" }), "failed");
  assert.equal(ciState({ kind: "gitlab-mr" }, { head_pipeline: { status: "success" } }), "success");
  assert.equal(ciState({ kind: "gitlab-mr" }, { head_pipeline: null }), "running");
  const run = { kind: "github-run" };
  assert.equal(ciState(run, { status: "in_progress" }), "running");
  assert.equal(ciState(run, { status: "completed", conclusion: "success" }), "success");
  assert.equal(ciState(run, { status: "completed", conclusion: "failure" }), "failed");
  const pr = { kind: "github-pr" };
  const checks = (...runs) => ({ check_runs: runs.map(([name, status, conclusion]) => ({ name, status, conclusion })) });
  assert.equal(ciState(pr, {}, checks(["ci", "in_progress", null])), "running");
  assert.equal(ciState(pr, {}, checks()), "running"); // no checks yet
  assert.equal(ciState(pr, {}, checks(["ci", "completed", "success"], ["lint", "completed", "skipped"])), "success");
  const red = checks(["ci", "completed", "success"], ["deploy", "completed", "failure"]);
  assert.equal(ciState(pr, {}, red), "failed");
  assert.deepEqual(failedParts(pr, {}, red), ["deploy"]);
});
