// Shared, locale-independent date-of-birth validation and normalization.
//
// Accepts `YYYY-M-D` and `YYYY-MM-DD` (single- or double-digit month/day), validates a real
// calendar date (leap years, days-in-month), rejects future and underage dates, and normalizes
// to the stored `YYYY-MM-DD` format. Never uses `new Date(string)` parsing, which is
// locale/engine dependent and silently corrects invalid dates like 2000-02-31.

export const MIN_SIGNUP_AGE = 18;

export type DobResult =
  | { ok: true; normalized: string; age: number }
  | { ok: false; code: DobErrorCode; message: string };

export type DobErrorCode =
  | "malformed"
  | "out_of_range"
  | "invalid_calendar_date"
  | "future_date"
  | "underage";

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const table = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return table[month - 1];
}

/** Explicit age computation from a normalized `YYYY-MM-DD` string (no Date string parsing). */
export function calcAgeFromDob(normalized: string, now: Date = new Date()): number {
  const [year, month, day] = normalized.split("-").map(Number);
  const ty = now.getFullYear();
  const tm = now.getMonth() + 1;
  const td = now.getDate();
  let age = ty - year;
  if (tm < month || (tm === month && td < day)) age--;
  return age;
}

/**
 * Authoritative adulthood check computed from the stored date of birth, so it
 * stays correct as the user ages (a stored `is_adult` boolean set once at signup
 * never flips when a 17-year-old turns 18). Falls back to `fallback` (the legacy
 * stored flag) only when no valid DOB is present, so pre-DOB accounts are not
 * locked out.
 */
export function computeIsAdult(
  dateOfBirth: string | null | undefined,
  fallback = false,
  now: Date = new Date(),
): boolean {
  if (typeof dateOfBirth === "string") {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateOfBirth.trim());
    if (m) {
      const normalized = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
      return calcAgeFromDob(normalized, now) >= MIN_SIGNUP_AGE;
    }
  }
  return fallback;
}

export function parseAndValidateDob(input: unknown, now: Date = new Date()): DobResult {
  if (typeof input !== "string") {
    return { ok: false, code: "malformed", message: "Date of birth is required." };
  }
  const trimmed = input.trim();
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      code: "malformed",
      message: "Date of birth must be in YYYY-MM-DD format.",
    };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { ok: false, code: "out_of_range", message: "Date of birth has an invalid month or day." };
  }
  if (day > daysInMonth(year, month)) {
    return { ok: false, code: "invalid_calendar_date", message: "Date of birth is not a real calendar date." };
  }

  const normalized = `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  // Future-date rejection (tuple comparison, no Date arithmetic).
  const ty = now.getFullYear();
  const tm = now.getMonth() + 1;
  const td = now.getDate();
  if (year > ty || (year === ty && month > tm) || (year === ty && month === tm && day > td)) {
    return { ok: false, code: "future_date", message: "Date of birth cannot be in the future." };
  }

  const age = calcAgeFromDob(normalized, now);
  if (age < MIN_SIGNUP_AGE) {
    return { ok: false, code: "underage", message: `You must be at least ${MIN_SIGNUP_AGE} years old.` };
  }

  return { ok: true, normalized, age };
}
