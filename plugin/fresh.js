// When the orchestrator's team session starts fresh.
//
// Measured 2026-11-23 (24 h, 8,842 model calls): the orchestrator was 30% of the team's usage, and 52% of that was
// its own history being written to the prompt cache again: 122 rewrites of 20-120k tokens a day, almost all at a
// new wake, plus 80k tokens re-read on every call. The board is the orchestrator's memory, so the session that
// receives the wakes is reset (OpenClaw's sessions.reset, what /new does) when it is quiet. OpenClaw refuses the
// reset while the session is active or changing, so a running turn is never cut and its tasks keep their requester.
//
// Off unless the config switches it on (jobs.fresh.enabled): it runs the `openclaw` command, and a test suite on
// the gateway's own host must never reach the live gateway (2026-11-23: it did, three resets of the team session).

const DEFAULTS = {
  enabled: false,
  command: "openclaw",
  everyMinutes: 30,   // a fresh start at most this often
  quietMinutes: 3,    // only when the orchestrator has made no tool call in this session for this long
  retryMinutes: 5,    // after a refused or failed reset, wait this long before asking again
  timeoutSeconds: 90, // the wake goes ahead after this long, reset or not
};

function mergeFreshConfig(cfg) {
  const out = Object.assign({}, DEFAULTS, cfg && typeof cfg === "object" ? cfg : {});
  for (const k of ["everyMinutes", "quietMinutes", "retryMinutes", "timeoutSeconds"]) out[k] = Number.isFinite(Number(out[k])) ? Number(out[k]) : DEFAULTS[k];
  out.enabled = out.enabled === true;
  out.command = typeof out.command === "string" ? out.command : DEFAULTS.command;
  return out;
}

// Only a session made for wakes (":explicit:"), never a chat with the owner or a task's own session.
function wakeOnlySession(sessionKey) {
  return /^agent:[^:]+:explicit:[^:]+$/.test(String(sessionKey || ""));
}

// state: { at, triedAt } (ms). lastActivityAt: the orchestrator's last tool call in the session (ms, 0 = never).
function dueForFreshStart(state, now, lastActivityAt, rawCfg) {
  const cfg = mergeFreshConfig(rawCfg);
  if (!cfg.enabled || !cfg.command || !(cfg.everyMinutes > 0)) return false;
  const s = state || {};
  if (now - (Number(s.at) || 0) < cfg.everyMinutes * 60000) return false;
  if (now - (Number(s.triedAt) || 0) < cfg.retryMinutes * 60000) return false;
  if (now - (Number(lastActivityAt) || 0) < cfg.quietMinutes * 60000) return false;
  return true;
}

// Asks OpenClaw for the fresh start. Resolves { ok, error }; never rejects.
function requestFreshStart(exec, rawCfg, sessionKey) {
  const cfg = mergeFreshConfig(rawCfg);
  return new Promise((resolve) => {
    try {
      exec(cfg.command, ["gateway", "call", "sessions.reset", "--params", JSON.stringify({ key: sessionKey }), "--json"],
        { timeout: cfg.timeoutSeconds * 1000, maxBuffer: 8 << 20, env: process.env },
        (error) => resolve(error ? { ok: false, error: String(error.message || error).slice(0, 160) } : { ok: true }));
    } catch (error) {
      resolve({ ok: false, error: String(error && error.message).slice(0, 160) });
    }
  });
}

export { DEFAULTS as FRESH_DEFAULTS, mergeFreshConfig, wakeOnlySession, dueForFreshStart, requestFreshStart };
