// The CI watch: a worker pushes, reports "RESULT: waiting" with its pipeline or pull request link and
// ends its session; the guard follows that pipeline through the GitLab or GitHub API (no model runs)
// and moves the item on when it finishes. Waiting inside a session re-read the whole context on every
// poll: 30-38% of the engineers' calls were waiting before this. Pure: no OpenClaw imports, no network.

// The CI link in a report: a GitLab pipeline or merge request, a GitHub Actions run or pull request.
function parseCiLink(text) {
  const t = String(text || "");
  let m = /https:\/\/gitlab\.com\/([\w.\-/]+?)\/-\/pipelines\/(\d+)/.exec(t);
  if (m) return { kind: "gitlab-pipeline", project: m[1], id: m[2], url: m[0] };
  m = /https:\/\/gitlab\.com\/([\w.\-/]+?)\/-\/merge_requests\/(\d+)/.exec(t);
  if (m) return { kind: "gitlab-mr", project: m[1], id: m[2], url: m[0] };
  m = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/(\d+)/.exec(t);
  if (m) return { kind: "github-run", repo: `${m[1]}/${m[2]}`, id: m[3], url: m[0] };
  m = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(t);
  if (m) return { kind: "github-pr", repo: `${m[1]}/${m[2]}`, id: m[3], url: m[0] };
  return null;
}

// The API request that tells the link's state (a pull request needs a second one for its checks).
function ciRequest(link) {
  if (!link) return null;
  if (link.kind === "gitlab-pipeline") return { host: "gitlab", url: `https://gitlab.com/api/v4/projects/${encodeURIComponent(link.project)}/pipelines/${link.id}` };
  if (link.kind === "gitlab-mr") return { host: "gitlab", url: `https://gitlab.com/api/v4/projects/${encodeURIComponent(link.project)}/merge_requests/${link.id}` };
  if (link.kind === "github-run") return { host: "github", url: `https://api.github.com/repos/${link.repo}/actions/runs/${link.id}` };
  if (link.kind === "github-pr") return { host: "github", url: `https://api.github.com/repos/${link.repo}/pulls/${link.id}` };
  return null;
}

const GITLAB_RUNNING = new Set(["created", "waiting_for_resource", "preparing", "pending", "running", "scheduled"]);

// "running" | "success" | "failed" from an API answer (a GitHub pull request answers with its checks).
function ciState(link, body, checks) {
  if (!link || !body) return "running";
  if (link.kind === "gitlab-pipeline" || link.kind === "gitlab-mr") {
    const p = link.kind === "gitlab-mr" ? body.head_pipeline : body;
    // An MR that exists but has no pipeline: nothing may ever run (the caller waits a little first).
    if (link.kind === "gitlab-mr" && !p && body.iid !== undefined) return "none";
    if (!p || !p.status) return "running";
    if (GITLAB_RUNNING.has(p.status)) return "running";
    // "manual": every automatic job passed and only manual ones (a production deploy) are left. GitLab
    // says "failed" when anything failed, even with manual jobs pending. It was counted as failed and a
    // green master went back to the writer to "fix".
    return p.status === "success" || p.status === "manual" ? "success" : "failed"; // failed, canceled, skipped
  }
  if (link.kind === "github-run") {
    if (body.status !== "completed") return "running";
    return ["success", "skipped", "neutral"].includes(body.conclusion) ? "success" : "failed";
  }
  if (link.kind === "github-pr") {
    const runs = (checks && checks.check_runs) || [];
    if (!runs.length || runs.some((r) => r.status !== "completed")) return "running";
    return runs.every((r) => ["success", "skipped", "neutral"].includes(r.conclusion)) ? "success" : "failed";
  }
  return "running";
}

// The names of the failed jobs or checks, for the message to the author.
function failedParts(link, body, checks) {
  if (link && link.kind === "github-pr") return ((checks && checks.check_runs) || []).filter((r) => !["success", "skipped", "neutral"].includes(r.conclusion)).map((r) => r.name).slice(0, 6);
  return [];
}

const DEFAULT_CI = { pollSeconds: 120, maxWaitMinutes: 150, noPipelineMinutes: 10 };

export { parseCiLink, ciRequest, ciState, failedParts, DEFAULT_CI };
