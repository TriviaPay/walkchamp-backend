/**
 * Locked-timezone daily-window service for the Unlimited Challenge.
 *
 * THE SCHEDULE IS A CALENDAR DATE, NOT AN INSTANT. The host picks a date ("2026-08-09") and every
 * participant starts at 00:00 on that date in their OWN locked IANA timezone. Those are different
 * UTC instants by design: 2026-08-09 00:00 Asia/Kolkata and 2026-08-09 00:00 America/Chicago are
 * 10.5 hours apart, and both are correct.
 *
 * Build participant windows with buildDayWindowsFromLocalDate / computeParticipantSchedule. The
 * instant-based buildDayWindows below is LEGACY: it re-derives the local date by projecting one UTC
 * instant into the participant's zone, which shifts Day 1 by a calendar day for anyone east of the
 * challenge timezone. It is retained only to reconstruct schedules for challenges created before
 * start_local_date existed.
 *
 * Each day's window is [local-midnight, next-local-midnight) expressed in UTC, using calendar
 * arithmetic so DST days are naturally 23h or 25h.
 */

export interface ChallengeDayWindow {
  dayNumber: number;
  localDate: string; // "YYYY-MM-DD" in the participant's locked timezone
  windowStartUtc: Date;
  windowEndUtc: Date;
  goalSteps: number;
}

/**
 * True if `tz` is resolvable by Intl. TOLERANT — accepts legacy identifiers, because values
 * already stored on live memberships must keep computing rather than throwing on a read path.
 * Validate NEW input with isStrictIanaTimezone.
 */
export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * True if `tz` is a real Area/Location IANA identifier ("America/Chicago"), or UTC.
 *
 * Intl happily resolves bare abbreviations — Node maps "IST" to Asia/Kolkata — but an abbreviation
 * is ambiguous (CST is both North America and China) and carries no DST rules of its own. A
 * multi-week challenge that decides real money cannot anchor a participant's midnights to one, so
 * abbreviations are rejected at every input boundary.
 */
export function isStrictIanaTimezone(tz: string): boolean {
  const zone = tz?.trim();
  if (!zone) return false;
  if (zone.toUpperCase() === "UTC") return true;
  // Area/Location, e.g. America/Chicago, Asia/Kolkata, Etc/GMT+12, America/Argentina/Salta.
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)+$/.test(zone)) return false;
  return isValidTimezone(zone);
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

/** Parse a strict `YYYY-MM-DD` into civil parts, or null when it is not a real calendar date. */
export function parseLocalDate(raw: unknown): { year: number; month: number; day: number } | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  // Round-trip through UTC civil arithmetic to reject 2026-02-31 and friends.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** The local calendar date (`YYYY-MM-DD`) an instant falls on in `tz`. */
export function localDateInZone(instant: Date, tz: string): string {
  const p = localPartsInZone(instant, tz);
  return fmtDate(p.year, p.month, p.day);
}

/**
 * THE core primitive: the ordered challenge-day windows for one participant, anchored to the
 * challenge's semantic calendar date and the participant's own locked timezone.
 *
 * Day 1 IS startLocalDate — there is no warm-up remainder, because the participant's day begins at
 * their own local midnight on that date rather than at some shared instant that may land mid-day
 * for them. Day boundaries advance by CALENDAR days, so a DST transition inside the run yields a
 * 23h or 25h day without shifting any local date.
 *
 * @param startLocalDate challenge calendar date, `YYYY-MM-DD` (semantic; timezone-free)
 * @param timezone       participant's locked IANA timezone
 * @param durationDays   number of required days (7|10|30|60|90)
 * @param goalSteps      daily goal applied to every day
 */
export function buildDayWindowsFromLocalDate(
  startLocalDate: string,
  timezone: string,
  durationDays: number,
  goalSteps: number,
): ChallengeDayWindow[] {
  const day1 = parseLocalDate(startLocalDate);
  if (!day1) throw new Error(`Invalid startLocalDate: ${startLocalDate}`);
  if (!isValidTimezone(timezone)) throw new Error(`Invalid timezone: ${timezone}`);
  if (!Number.isInteger(durationDays) || durationDays < 1) throw new Error(`Invalid durationDays: ${durationDays}`);

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

export interface ParticipantSchedule {
  /** 00:00 on the challenge's calendar date, in the participant's locked timezone, as UTC. */
  startAtUtc: Date;
  /** Exclusive end: 00:00 on (startLocalDate + durationDays), same zone, as UTC. */
  endAtUtc: Date;
  windows: ChallengeDayWindow[];
}

/**
 * One participant's whole schedule. Callers persist startAtUtc/endAtUtc on the membership row and
 * the windows as unlimited_challenge_days.
 */
export function computeParticipantSchedule(input: {
  startLocalDate: string;
  timezone: string;
  durationDays: number;
  goalSteps: number;
}): ParticipantSchedule {
  const windows = buildDayWindowsFromLocalDate(input.startLocalDate, input.timezone, input.durationDays, input.goalSteps);
  return {
    startAtUtc: windows[0].windowStartUtc,
    endAtUtc: windows[windows.length - 1].windowEndUtc,
    windows,
  };
}

/**
 * LEGACY instant-anchored windows. Only for reconstructing pre-start_local_date challenges — see
 * the file header. New code must use buildDayWindowsFromLocalDate.
 *
 * @param startAtUtc challenge start instant
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

// ── USD Unlimited Challenge schedule validation (public + private parity) ──────
// A USD Unlimited Players challenge must start on a FUTURE calendar date at exactly local midnight
// in the challenge timezone, run a supported whole-day duration, and end at local midnight
// (start local date + duration). The end instant is backend-authoritative. Shared by the create
// path for both public and private rooms so the rules can never diverge or be bypassed via the API.

export type UnlimitedScheduleError =
  | "invalid_timezone"
  | "invalid_start"
  | "invalid_duration"
  | "start_not_midnight"
  | "start_not_future";

export type UnlimitedScheduleResult =
  | {
      ok: true;
      /** THE semantic schedule: the calendar date every participant starts on, in their own zone. */
      startLocalDate: string;
      /** Host-zone anchor instant. Retained for audit, ordering and legacy clients — NOT the
       *  authority for any participant's day boundaries. */
      startAtUtc: Date;
      /** Host-zone end instant. Real settlement waits for MAX(participant end); see settlement. */
      challengeEndAtUtc: Date;
      timezone: string;
    }
  | { ok: false; code: UnlimitedScheduleError; error: string };

const ALLOWED_UNLIMITED_DURATIONS = new Set([7, 10, 30, 60, 90]);

/** Civil-date ordinal (days since epoch) for a (y,m,d) — lets us compare calendar dates directly. */
function civilOrdinal(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/**
 * Validate + normalize a USD Unlimited Challenge schedule.
 *
 * Accepts EITHER the semantic form (`startLocalDate: "2026-08-09"`, preferred) or the legacy
 * instant form (`startAtIso`, which must land exactly on local midnight in `timezone` and is
 * immediately reduced to its calendar date). Both produce the same authoritative output, because
 * the calendar date — not the instant — is what participants' days are anchored to.
 */
export function validateUnlimitedSchedule(input: {
  startLocalDate?: string;
  startAtIso?: string;
  durationDays: number;
  timezone: string;
  nowMs: number;
}): UnlimitedScheduleResult {
  const { durationDays, timezone, nowMs } = input;

  if (!isStrictIanaTimezone(timezone)) {
    return { ok: false, code: "invalid_timezone", error: "Select a valid IANA timezone (e.g. America/Chicago)." };
  }
  if (!ALLOWED_UNLIMITED_DURATIONS.has(durationDays)) {
    return { ok: false, code: "invalid_duration", error: "Unlimited challenge duration must be 7, 10, 30, 60 or 90 days." };
  }

  // Resolve the semantic calendar date from whichever form the caller supplied.
  let startCivil: { year: number; month: number; day: number } | null = null;
  if (input.startLocalDate !== undefined) {
    startCivil = parseLocalDate(input.startLocalDate);
    if (!startCivil) {
      return { ok: false, code: "invalid_start", error: "Provide a valid challenge start date (YYYY-MM-DD)." };
    }
  } else if (input.startAtIso !== undefined) {
    const instant = new Date(input.startAtIso);
    if (Number.isNaN(instant.getTime())) {
      return { ok: false, code: "invalid_start", error: "Provide a valid challenge start date." };
    }
    // A legacy instant must be EXACTLY local midnight in the challenge timezone, otherwise its
    // calendar date is ambiguous. IANA offsets are whole-minute, so a non-zero UTC millisecond
    // implies a non-zero local millisecond.
    const local = localPartsInZone(instant, timezone);
    const isLocalMidnight = local.hour === 0 && local.minute === 0 && local.second === 0
      && instant.getUTCMilliseconds() === 0;
    if (!isLocalMidnight) {
      return { ok: false, code: "start_not_midnight", error: "Unlimited challenges must start at 12:00 AM in the selected timezone." };
    }
    startCivil = { year: local.year, month: local.month, day: local.day };
  } else {
    return { ok: false, code: "invalid_start", error: "Provide a challenge start date." };
  }

  // Start calendar date must be strictly after today's date in the challenge timezone.
  const todayLocal = localPartsInZone(new Date(nowMs), timezone);
  const startOrdinal = civilOrdinal(startCivil.year, startCivil.month, startCivil.day);
  const todayOrdinal = civilOrdinal(todayLocal.year, todayLocal.month, todayLocal.day);
  if (startOrdinal <= todayOrdinal) {
    return { ok: false, code: "start_not_future", error: "Unlimited challenges must start tomorrow or later." };
  }

  const startLocalDate = fmtDate(startCivil.year, startCivil.month, startCivil.day);
  // Host-zone anchor + host-zone end. These describe the HOST's own view of the schedule; each
  // participant's real boundaries come from computeParticipantSchedule in their own zone.
  const hostSchedule = computeParticipantSchedule({ startLocalDate, timezone, durationDays, goalSteps: 0 });
  return {
    ok: true,
    startLocalDate,
    startAtUtc: hostSchedule.startAtUtc,
    challengeEndAtUtc: hostSchedule.endAtUtc,
    timezone,
  };
}
