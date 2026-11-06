// The 10-minute triage: a cheap Haiku call (no tools, light context) reads a compact snapshot of
// the board and the running tasks and decides whether the orchestrator (Opus) must act now, and
// at what effort. Code skips the call entirely when nothing needs a decision, so a quiet team
// costs nothing. Pure: no OpenClaw imports.

import { normStatus } from "./board.js";

const DEFAULT_TRIAGE = {
  enabled: true,
  everyMinutes: 10,
  model: "anthropic/claude-haiku-5-5",
  orchestratorQuietMinutes: 10, // do not interrupt an orchestrator that is working
  maxWakesPerDay: 24, // its own budget, separate from the plain reminders
  // The same board state does not wake the orchestrator again within this time: woken every 36 minutes
  // for the same 30 waiting items, it once spent the whole weekly Claude limit re-checking them.
  sameStateRewakeMinutes: 180,
};

function mergeTriageConfig(cfg) {
  return Object.assign({}, DEFAULT_TRIAGE, cfg && typeof cfg === "object" ? cfg : {});
}

const ago = (now, ts) => {
  const t = typeof ts === "number" ? ts : Date.parse(ts || 0);
  return t ? `${Math.round((now - t) / 60000)}m ago` : "?";
};

// The snapshot the triage reads, or null when nothing needs a decision.
function triageSnapshot(data, items, now) {
  const jobs = Object.values(data.jobs || {});
  const running = jobs.filter((j) => j.status === "running");
  const covered = new Set(running.flatMap((j) => j.items || []));
  const open = items.filter((it) => ["todo", "in_progress", "review", "qa"].includes(normStatus(it.status)));
  const waiting = open.filter((it) => !covered.has(it.id));
  const unacted = jobs.filter((j) => j.status !== "running" && j.resultMsgId && !j.answeredAt && now - (j.endedAt || 0) < 6 * 3600000);
  const asks = (data.ownerAsks || []).filter((a) => !a.captured && now - a.at < 6 * 3600000);
  if (!waiting.length && !unacted.length && !asks.length) return null;
  const line = (it) => `- ${it.id} [${normStatus(it.status)}] ${it.project || "?"}: ${String(it.title || "").slice(0, 90)} (owner ${it.owner || "?"}, updated ${ago(now, it.updated_ts || it.created_ts)})`;
  const parts = [];
  if (waiting.length) parts.push(`Open items with no task running (${waiting.length}):`, ...waiting.slice(0, 25).map(line));
  if (running.length) parts.push(`Running tasks (${running.length}):`, ...running.slice(0, 10).map((j) => `- ${j.agentId}: ${String(j.label || "").slice(0, 80)} (started ${ago(now, j.spawnedAt)})`));
  if (unacted.length) parts.push(`Results nobody answered yet (${unacted.length}):`, ...unacted.slice(0, 10).map((j) => `- ${j.agentId}: ${String(j.label || "").slice(0, 80)}, ended ${ago(now, j.endedAt)}, outcome ${j.outcome}`));
  if (asks.length) parts.push(`Owner messages not on the board yet (${asks.length}):`, ...asks.slice(0, 8).map((a) => `- topic ${a.topic}, ${ago(now, a.at)}: "${String(a.text).slice(0, 200)}"`));
  return parts.join("\n");
}

// What the orchestrator would be woken for: waiting items (id and column), unanswered results and owner
// requests. Times are left out, so the same state gives the same signature.
function triageSignature(data, items, now) {
  const jobs = Object.values(data.jobs || {});
  const covered = new Set(jobs.filter((j) => j.status === "running").flatMap((j) => j.items || []));
  const waiting = items
    .filter((it) => ["todo", "in_progress", "review", "qa"].includes(normStatus(it.status)) && !covered.has(it.id))
    .map((it) => `${it.id}:${normStatus(it.status)}`);
  const unacted = jobs
    .filter((j) => j.status !== "running" && j.resultMsgId && !j.answeredAt && now - (j.endedAt || 0) < 6 * 3600000)
    .map((j) => `r:${j.resultMsgId}`);
  const asks = (data.ownerAsks || []).filter((a) => !a.captured && now - a.at < 6 * 3600000).map((a) => `a:${a.at}`);
  return [...waiting.sort(), ...unacted.sort(), ...asks.sort()].join(",");
}

const TRIAGE_PROMPT =
  "You are the team's triage check. The orchestrator (on Opus) runs a team of AI agents for the owner. " +
  "Below is the current state. Decide whether the orchestrator must act now. It must act when an open item " +
  "has no task running and is not waiting on the owner, when a result is unanswered, or when an owner request " +
  "is not on the board. Do not wake it for items that wait on the owner, an approval or a usage limit. Choose its effort: " +
  "low for routine dispatch or acceptance (the default), medium when a decision needs thought, high only for a " +
  "production outage or a red main. " +
  'Reply with JSON only: {"wake": true|false, "effort": "low"|"medium"|"high", "why": "<one line>", ' +
  '"instruction": "<what the orchestrator should do first, naming item ids>"}\n\n';

function parseTriage(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ""));
  if (!m) return null;
  try {
    const d = JSON.parse(m[0]);
    const effort = ["low", "medium", "high"].includes(d.effort) ? d.effort : "medium";
    return { wake: d.wake === true, effort, why: String(d.why || "").slice(0, 300), instruction: String(d.instruction || "").slice(0, 1500) };
  } catch {
    return null;
  }
}

function triageWakeMessage(decision, snapshot) {
  return (
    `[triage, effort ${decision.effort}] First set your effort with the sessions tool (action patch, thinking "${decision.effort}"). ` +
    `Why: ${decision.why}\nDo first: ${decision.instruction}\n\nState:\n${snapshot}\n\n` +
    "Move each item through its columns (no new items for retries or gates), dispatch with sessions_spawn, answer results, " +
    "and tell the owner in the project topic only what changed. This run's own reply is not delivered."
  );
}

export { DEFAULT_TRIAGE, mergeTriageConfig, triageSnapshot, triageSignature, TRIAGE_PROMPT, parseTriage, triageWakeMessage };
