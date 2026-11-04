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

// When does the limit in `text` reset? Returns epoch ms; falls back to now + 1h.
function limitResetAt(text, now = Date.now()) {
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

export { isLimitError, limitResetAt, tzOffsetMinutes, zonedToUtc, DEFAULT_LIMIT_MS };
