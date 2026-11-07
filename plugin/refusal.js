// A dispatch refused by OpenClaw's own Claude login check, not by a usage limit.
//
// OpenClaw asks `claude auth status --json` (with a 3 s limit) whether the Claude CLI login works,
// keeps the answer per agent, and checks again only when something reads that agent's model list;
// a spawn does not. One slow or failed check therefore refuses every dispatch to that agent
// ("The selected account or native runtime is unavailable ...") until something else happens to read
// the list, which took up to an hour. The orchestrator read the refusal as a usage limit, told the
// owner so, and waited. The guard now reads that agent's model list (which makes OpenClaw check the
// login again), then wakes the orchestrator to send the same dispatch again.

const DEFAULT_REFUSAL = {
  enabled: true,
  command: "openclaw", // `openclaw gateway call models.list` makes OpenClaw check the Claude login again
  retryAfterSeconds: 120,
  maxPerHour: 3, // more refusals of one agent within an hour go to the operator instead
};

const HOUR = 3600000;

function mergeRefusalConfig(cfg) {
  return Object.assign({}, DEFAULT_REFUSAL, cfg && typeof cfg === "object" ? cfg : {});
}

function isLoginRefusal(error) {
  return /selected account or native runtime is unavailable|native runtime is unavailable/i.test(String(error || ""));
}

function prune(data, now) {
  for (const [key, r] of Object.entries(data.refusals || {})) if (!r || now - (r.at || 0) > 6 * HOUR) delete data.refusals[key];
}

// One entry per refusal the orchestrator still has to retry; a second refusal of the same agent
// before the retry wake is the same event (the CLI often reports one spawn twice).
function recordRefusal(data, agentId, error, now) {
  data.refusals = data.refusals || {};
  prune(data, now);
  const open = Object.values(data.refusals).find((r) => r.agentId === agentId && !r.wokeAt && !r.flaggedAt);
  if (open) return null;
  const entry = { agentId, error: String(error || "").slice(0, 300), at: now };
  data.refusals[`${now}:${agentId}`] = entry;
  return entry;
}

function dueRefusals(data, now, cfg) {
  return Object.entries(data.refusals || {})
    .filter(([, r]) => r && !r.wokeAt && !r.flaggedAt && now - (r.at || 0) >= cfg.retryAfterSeconds * 1000)
    .sort((a, b) => a[1].at - b[1].at);
}

function refusalsWithinHour(data, agentId, now) {
  return Object.values(data.refusals || {}).filter((r) => r && r.agentId === agentId && now - (r.at || 0) < HOUR).length;
}

// Two plugin copies share the state file: keep every refusal either copy saw, and once a copy has
// woken the orchestrator (or flagged the operator) for one, it stays done.
function mergeRefusals(a, b) {
  const out = Object.assign({}, b || {});
  for (const [key, r] of Object.entries(a || {})) {
    const o = out[key] || {};
    out[key] = Object.assign({}, o, r);
    for (const f of ["wokeAt", "flaggedAt"]) {
      const v = Math.max(r[f] || 0, o[f] || 0);
      if (v) out[key][f] = v;
    }
  }
  return out;
}

function hhmm(ts) {
  return new Date(ts).toISOString().slice(11, 16);
}

function retryWakeText(name, at, tries, max) {
  return `[dispatch] Your dispatch to ${name} at ${hhmm(at)} UTC was refused by OpenClaw's own Claude login check `
    + `("the selected account or native runtime is unavailable"). It is not a usage limit: the guard has no limit recorded. `
    + `The guard asked OpenClaw to check the login again. Send the same dispatch again now (retry ${tries} of ${max}). `
    + `Never tell the owner this is a usage limit; if you already did, correct it in the same topic.`;
}

export {
  DEFAULT_REFUSAL, mergeRefusalConfig, isLoginRefusal, recordRefusal, dueRefusals, refusalsWithinHour, mergeRefusals, retryWakeText,
};
