// Weekly pace: the team spends the subscription's weekly allowance evenly over the week.
// On 2026-11-17 a Max plan's weekly limit was 95% used 3.5 days into the week (the team ran around the clock at
// about twice the even pace), so the team would have stopped for the last 3.5 days. Claude Code's own usage
// endpoint gives the used percent and the reset time; when the team is ahead of an even pace, new dispatches and
// the guard's own wakes wait until the pace catches up. Running tasks finish and the owner's messages still go
// through. Pure: no OpenClaw imports, so it is unit-testable.

const WEEK_MS = 7 * 86400000;

const DEFAULT_PACE = {
  enabled: false,          // on only when the plugin config turns it on (it reads the Claude CLI's login)
  everyMinutes: 10,         // how often the usage is read
  aheadPercent: 5,          // how far ahead of an even pace the team may run (early in the week, a burst is fine)
  reservePercent: 97,       // above this, only the owner's conversations run until the reset
  fiveHourPercent: 95,      // the 5-hour window: hold at this until it resets
  // An owner budget for a stretch of hours (owner 2026-11-21: "at most ~6 more points in 12 h"): from windowStart,
  // weekly use may grow by windowPerHour points per hour above windowStartPercent, for windowHours.
  windowStart: "",
  windowStartPercent: 0,
  windowPerHour: 0,
  windowHours: 0,
  credentialsFile: "~/.claude/.credentials.json",
  url: "https://api.anthropic.com/api/oauth/usage",
};

function mergePaceConfig(raw) {
  const cfg = Object.assign({}, DEFAULT_PACE, raw || {});
  for (const k of ["everyMinutes", "aheadPercent", "reservePercent", "fiveHourPercent", "windowStartPercent", "windowPerHour", "windowHours"]) cfg[k] = Number(cfg[k]) || 0;
  cfg.enabled = cfg.enabled === true;
  return cfg;
}

// The hold the usage calls for, or null. `usage` is the endpoint's answer.
// Returns { until, reason, used, allowed, resetsAt }: dispatches wait until `until` (ms).
function paceHold(usage, now, rawCfg) {
  const cfg = mergePaceConfig(rawCfg);
  const week = usage && usage.seven_day;
  const used = week && Number(week.utilization);
  const resetsAt = week && Date.parse(week.resets_at);
  if (!Number.isFinite(used) || !Number.isFinite(resetsAt) || resetsAt <= now) return null;
  const start = resetsAt - WEEK_MS;
  const elapsed = Math.max(0, Math.min(100, ((now - start) / WEEK_MS) * 100));
  const allowed = Math.min(cfg.reservePercent, elapsed + cfg.aheadPercent);
  if (used >= cfg.reservePercent) {
    return { until: resetsAt, reason: "reserve", used, allowed, elapsed, resetsAt };
  }
  if (used > allowed) {
    // The moment an even pace reaches today's use (less the lead it may have).
    const until = Math.min(resetsAt, start + ((used - cfg.aheadPercent) / 100) * WEEK_MS);
    if (until > now) return { until, reason: "pace", used, allowed, elapsed, resetsAt };
  }
  // The owner's budget window, if one is set and running.
  const wStart = Date.parse(cfg.windowStart || "");
  if (Number.isFinite(wStart) && cfg.windowPerHour > 0 && cfg.windowHours > 0 && now >= wStart && now < wStart + cfg.windowHours * 3600000) {
    const budget = cfg.windowStartPercent + cfg.windowPerHour * ((now - wStart) / 3600000);
    if (used > budget) {
      const until = Math.min(wStart + cfg.windowHours * 3600000, wStart + ((used - cfg.windowStartPercent) / cfg.windowPerHour) * 3600000);
      if (until > now) return { until, reason: "budget", used, allowed: Math.round(budget * 10) / 10, elapsed, resetsAt };
    }
  }
  const five = usage.five_hour;
  const fiveUsed = five && Number(five.utilization);
  const fiveReset = five && Date.parse(five.resets_at);
  if (Number.isFinite(fiveUsed) && Number.isFinite(fiveReset) && fiveReset > now && fiveUsed >= cfg.fiveHourPercent) {
    return { until: fiveReset, reason: "fiveHour", used: fiveUsed, allowed: cfg.fiveHourPercent, elapsed, resetsAt: fiveReset };
  }
  return null;
}

function utc(ms, now) {
  const iso = new Date(ms).toISOString();
  return iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? `${iso.slice(11, 16)} UTC` : `${new Date(ms).toUTCString().slice(0, 11)} ${iso.slice(11, 16)} UTC`;
}

// What the orchestrator is told when it tries to dispatch during a hold.
function paceText(hold, now) {
  const when = utc(hold.until, now);
  if (hold.reason === "fiveHour") {
    return `token-guard: the Claude plan's 5-hour window is ${hold.used}% used, so this task would stop halfway. Do not dispatch now and leave its items in To do; the guard wakes you after ${when}. Answer the owner as usual.`;
  }
  if (hold.reason === "budget") {
    return `token-guard: the owner's budget allows ${hold.allowed}% of the Claude plan's weekly limit by now and ${hold.used}% is used, so dispatches wait until ${when}. Do not dispatch now and leave the items in To do; the guard wakes you then. Answer the owner as usual.`;
  }
  if (hold.reason === "reserve") {
    return `token-guard: the Claude plan's weekly limit is ${hold.used}% used; the rest is kept for the owner's conversations until it resets at ${when}. Do not dispatch and leave the items in To do; the guard wakes you after the reset. Answer the owner as usual.`;
  }
  return `token-guard: the team is ahead of its weekly allowance (${hold.used}% of the Claude plan's weekly limit used, ${Math.round(hold.elapsed)}% of the week gone), so dispatches wait until ${when}, when an even pace catches up; otherwise the team would stop for days before the reset. Do not dispatch now and leave the items in To do; the guard wakes you then. Answer the owner as usual.`;
}

export { DEFAULT_PACE, mergePaceConfig, paceHold, paceText, WEEK_MS };
