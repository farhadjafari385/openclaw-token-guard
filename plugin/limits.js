// Recognise provider usage-limit errors and work out when the limit resets.
// Pure: no OpenClaw imports, so it is unit-testable.

const LIMIT_PATTERN =
  /\b(?:hit|reached|exceeded|used up)\s+(?:your|the)\s+(?:\w+\s+){0,3}?limit\b|\b(?:session|weekly|daily|usage|rate)[ -]limit\b|\bquota (?:exceeded|exhausted)\b|\btoo many requests\b/i;

const RESET_PATTERN =
  /\bresets?\s+(?:at\s+|on\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([A-Za-z_]+\/[A-Za-z_/+-]+|UTC|GMT)\)/i;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DEFAULT_LIMIT_MS = 60 * 60 * 1000;
const MAX_LIMIT_MS = 8 * 24 * 60 * 60 * 1000;

function isLimitError(text) {
  return typeof text === "string" && LIMIT_PATTERN.test(text);
}

// Minutes the given time zone is ahead of UTC at `date`.
function tzOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

function zonedDateParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day };
}

// UTC milliseconds of a wall-clock time in a time zone (DST-correct to the minute).
function zonedToUtc(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let utc = guess - tzOffsetMinutes(new Date(guess), timeZone) * 60000;
  utc = guess - tzOffsetMinutes(new Date(utc), timeZone) * 60000;
  return utc;
}

// Codex words it differently: "Next reset in 46 minutes, Nov 5 at 6:43 PM EST."
const RELATIVE_PATTERN = /\breset in (\d+)\s*(minutes?|mins?|hours?|hrs?|days?)\b/i;
const ABBR_PATTERN = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(EST|EDT|CST|CDT|MST|MDT|PST|PDT|UTC|GMT|CET|CEST)\b/i;
const ABBR_ZONES = { est: "America/New_York", edt: "America/New_York", cst: "America/Chicago", cdt: "America/Chicago", mst: "America/Denver", mdt: "America/Denver", pst: "America/Los_Angeles", pdt: "America/Los_Angeles", utc: "UTC", gmt: "UTC", cet: "Europe/Berlin", cest: "Europe/Berlin" };

// When does the limit in `text` reset? Returns epoch ms; falls back to now + 1h.
function limitResetAt(text, now = Date.now()) {
  const rel = typeof text === "string" ? RELATIVE_PATTERN.exec(text) : null;
  if (rel) {
    const unit = /^m/i.test(rel[2]) ? 60000 : /^h/i.test(rel[2]) ? 3600000 : 86400000;
    return Math.min(now + Number(rel[1]) * unit + 60000, now + MAX_LIMIT_MS); // one minute of margin
  }
  const abbr = typeof text === "string" ? ABBR_PATTERN.exec(text) : null;
  if (abbr) {
    const [, monthName, dayStr, hourStr, minuteStr, ampm, zone] = abbr;
    text = `resets ${monthName} ${dayStr}, ${hourStr}${minuteStr ? `:${minuteStr}` : ""}${ampm} (${ABBR_ZONES[zone.toLowerCase()]})`;
  }
  const m = typeof text === "string" ? RESET_PATTERN.exec(text) : null;
  if (!m) return now + DEFAULT_LIMIT_MS;
  const [, monthName, dayStr, hourStr, minuteStr, ampm, zoneRaw] = m;
  const timeZone = /^(UTC|GMT)$/i.test(zoneRaw) ? "UTC" : zoneRaw;
  let hour = Number(hourStr);
  const minute = minuteStr ? Number(minuteStr) : 0;
  if (ampm) {
    const pm = ampm.toLowerCase() === "pm";
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  try {
    const today = zonedDateParts(new Date(now), timeZone);
    let at;
    if (monthName && dayStr) {
      const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase()) + 1;
      if (month === 0) return now + DEFAULT_LIMIT_MS;
      at = zonedToUtc(today.year, month, Number(dayStr), hour, minute, timeZone);
      if (at < now - 24 * 3600 * 1000) at = zonedToUtc(today.year + 1, month, Number(dayStr), hour, minute, timeZone);
    } else {
      at = zonedToUtc(today.year, today.month, today.day, hour, minute, timeZone);
      if (at <= now) at += 24 * 3600 * 1000;
    }
    if (!Number.isFinite(at) || at <= now) return now + DEFAULT_LIMIT_MS;
    return Math.min(at, now + MAX_LIMIT_MS);
  } catch {
    return now + DEFAULT_LIMIT_MS;
  }
}

// The provider's usage-limit error that OpenClaw sends as the agent's reply when a run fails
// ("⚠️ You've hit your weekly limit · resets 9pm (America/New_York)"). OpenClaw's failure replies
// start with ⚠️; an agent's own message that only talks about a limit is longer or starts otherwise.
function isLimitReply(text) {
  const t = String(text || "").trim();
  return t.length > 0 && t.length <= 300 && t.startsWith("⚠️") && isLimitError(t);
}

// One limit reply per chat (and topic) until the limit resets. In a group where the agent answers
// every message, each message would otherwise get the same error back. `seen` maps a destination
// to the reset time; returns true when this reply may go out.
function allowLimitReply(seen, dest, text, now = Date.now()) {
  for (const [k, until] of seen) if (until <= now) seen.delete(k);
  if ((seen.get(dest) || 0) > now) return false;
  seen.set(dest, limitResetAt(text, now));
  if (seen.size > 500) seen.delete(seen.keys().next().value);
  return true;
}

export { isLimitError, isLimitReply, allowLimitReply, limitResetAt, tzOffsetMinutes, zonedToUtc, DEFAULT_LIMIT_MS };
