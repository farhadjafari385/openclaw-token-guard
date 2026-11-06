// Agents waking the orchestrator (owner's order: "Let them wake u up too! They get stalled because of
// this!"). Bots cannot read each other in Telegram, so a blocked or finished agent had no way to reach
// the orchestrator before its task ended. The wake is rate-limited so it cannot spam or burn tokens.
// Pure: no OpenClaw imports.

const DEFAULT_WAKE = { perAgentMinutes: 10, perHour: 6, maxChars: 300 };

// May this agent wake the orchestrator now? `state` = { last: { agentId: ts }, recent: [ts, ...] }.
function allowAgentWake(state, agentId, now, cfg = DEFAULT_WAKE) {
  const c = Object.assign({}, DEFAULT_WAKE, cfg || {});
  state.last = state.last || {};
  state.recent = (state.recent || []).filter((t) => now - t < 3600000);
  const since = now - (state.last[agentId] || 0);
  if (since < c.perAgentMinutes * 60000) {
    return { ok: false, why: `you woke the orchestrator ${Math.round(since / 60000)} minutes ago; once per ${c.perAgentMinutes} minutes. Put the rest in your final report.` };
  }
  if (state.recent.length >= c.perHour) {
    return { ok: false, why: `the team has used its ${c.perHour} wakes for this hour. Put it in your final report; it reaches the orchestrator when your task ends.` };
  }
  state.last[agentId] = now;
  state.recent.push(now);
  return { ok: true };
}

const WAKE_REASONS = ["blocked", "decision", "finished", "other"];

function wakeMessage(agentId, reason, text, job, maxChars = DEFAULT_WAKE.maxChars) {
  const r = WAKE_REASONS.includes(String(reason)) ? String(reason) : "other";
  const where = job ? `"${String(job.label || "").slice(0, 80)}"${(job.items || []).length ? ` (items ${job.items.join(", ")})` : ""}` : "no task";
  return `[agent wake] ${agentId} on ${where}, ${r}: ${String(text || "").replace(/\s+/g, " ").trim().slice(0, maxChars)}\n` +
    "Act on it now: answer in that item's project topic, and if it needs work, dispatch it on the same item (one item at a time).";
}

export { DEFAULT_WAKE, WAKE_REASONS, allowAgentWake, wakeMessage };
