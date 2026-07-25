/**
 * Locked-timezone daily-window service for the Unlimited Challenge.
 *
 * Each challenge "day" is one calendar date in the participant's LOCKED IANA timezone. Day 1 is the
 * first FULL local calendar date at/after the start instant — the partial span from the start instant
 * to the first local midnight is an uncounted warm-up, so there is never a short Day 1. Each day's
 * window is [local-midnight, next-local-midnight) expressed in UTC. DST is handled (23h/25h days).
 *
 * Qualification for a day is evaluated against the participant's verified daily total for that local
 * calendar date (stepDailyTotalsTable, keyed by userId + date).
 */

export interface ChallengeDayWindow {
  dayNumber: number;
  localDate: string; // "YYYY-MM-DD" in the participant's locked timezone
  windowStartUtc: Date;
  windowEndUtc: Date;
  goalSteps: number;
}

/** True if `tz` is a valid IANA timezone accepted by Intl. */
export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

/** Wall-clock parts of a UTC instant as seen in `tz`. */
function localPartsInZone(instant: Date, tz: string): LocalParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(instant).map((part) => [part.type, part.value]));
  // Intl may emit hour "24" at midnight in some environments — normalize to 0.
  const hour = Number(p.hour) === 24 ? 0 : Number(p.hour);
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour, minute: Number(p.minute), second: Number(p.second) };
}

/** Offset (ms) between wall-clock time in `tz` and UTC, at the given instant. */
function tzOffsetMs(instant: Date, tz: string): number {
  const lp = localPartsInZone(instant, tz);
  const asUtc = Date.UTC(lp.year, lp.month - 1, lp.day, lp.hour, lp.minute, lp.second);
  return asUtc - instant.getTime();
}

/**
 * The UTC instant of local midnight (00:00:00) on the given local calendar date in `tz`.
 * Double-corrects the offset so DST-transition days resolve to the correct instant.
 */
function zonedMidnightToUtc(year: number, month: number, day: number, tz: string): Date {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0);
  let utc = naive - tzOffsetMs(new Date(naive), tz);
  utc = naive - tzOffsetMs(new Date(utc), tz);
  return new Date(utc);
}

/** Add `n` calendar days to a (year, month, day), returning the new civil date. */
function addCalendarDays(year: number, month: number, day: number, n: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + n);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function fmtDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Build the ordered list of challenge-day windows for a participant.
 *
 * @param startAtUtc challenge start instant (authoritative, backend UTC)
 * @param timezone   participant's locked IANA timezone
 * @param durationDays number of required days (7|10|30|60|90)
 * @param goalSteps  daily goal applied to every day
 */
export function buildDayWindows(startAtUtc: Date, timezone: string, durationDays: number, goalSteps: number): ChallengeDayWindow[] {
  const startLocal = localPartsInZone(startAtUtc, timezone);
  const startsExactlyAtMidnight = startLocal.hour === 0 && startLocal.minute === 0 && startLocal.second === 0;
  // Day 1 = the local date of the start if it begins exactly at local midnight (already a full day),
  // otherwise the NEXT local date (the partial remainder of the start date is an uncounted warm-up).
  const day1 = startsExactlyAtMidnight
    ? { year: startLocal.year, month: startLocal.month, day: startLocal.day }
    : addCalendarDays(startLocal.year, startLocal.month, startLocal.day, 1);

  const windows: ChallengeDayWindow[] = [];
  for (let i = 0; i < durationDays; i++) {
    const cur = addCalendarDays(day1.year, day1.month, day1.day, i);
    const next = addCalendarDays(cur.year, cur.month, cur.day, 1);
    windows.push({
      dayNumber: i + 1,
      localDate: fmtDate(cur.year, cur.month, cur.day),
      windowStartUtc: zonedMidnightToUtc(cur.year, cur.month, cur.day, timezone),
      windowEndUtc: zonedMidnightToUtc(next.year, next.month, next.day, timezone),
      goalSteps,
    });
  }
  return windows;
}

/**
 * The authoritative UTC end instant of the whole challenge = end of the last day's window.
 * Used to derive challengeEndAtUtc / settlementNotBeforeUtc from the HOST's locked timezone.
 */
export function computeChallengeEndUtc(startAtUtc: Date, timezone: string, durationDays: number): Date {
  const windows = buildDayWindows(startAtUtc, timezone, durationDays, 0);
  return windows[windows.length - 1].windowEndUtc;
}
