// Locale-independent validation of client-supplied `YYYY-MM-DD` step dates.
//
// Mirrors the robust approach in dateOfBirth.ts: never uses `new Date(string)`
// (which silently corrects invalid dates like 2000-02-31), validates a real
// calendar date, and bounds the value to a recent window so clients cannot
// backfill or post-date step submissions (which drives milestone/coin farming
// and leaderboard poisoning).

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const table = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return table[month - 1];
}

/** Days since the epoch for a normalized date (integer, timezone-free). */
function toDayNumber(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/**
 * Normalize a client-supplied `YYYY-M-D` / `YYYY-MM-DD` to `YYYY-MM-DD`, or null when it is not a
 * real calendar date. (The client's getTodayKey() returns un-padded month/day — that is fine.)
 */
export function normalizeLocalDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Intl formatters are expensive to build and we key most reads off one, so cache per zone.
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * `YYYY-MM-DD` for `now` as seen in an IANA timezone. Falls back to the UTC calendar date when
 * the zone is missing or unrecognised.
 */
export function localDateInTimeZone(timeZone: string | null | undefined, now: Date = new Date()): string {
  const zone = timeZone?.trim();
  if (!zone || zone.toUpperCase() === "UTC") return now.toISOString().slice(0, 10);
  let formatter = dateFormatters.get(zone);
  if (!formatter) {
    try {
      // en-CA renders as YYYY-MM-DD.
      formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
      return now.toISOString().slice(0, 10); // unknown zone — never throw on a read path
    }
    dateFormatters.set(zone, formatter);
  }
  const formatted = formatter.format(now);
  return normalizeLocalDate(formatted) ?? now.toISOString().slice(0, 10);
}

/**
 * Resolve which calendar day "today" means for a user, most specific source first:
 * the client-supplied localDate, then their stored IANA timezone, then UTC.
 *
 * LOAD-BEARING for daily step reads: step_daily_totals rows are written keyed by the user's LOCAL
 * date, so reading them with the server's UTC date returns yesterday's bucket for every user east
 * of UTC between their local midnight and UTC midnight (e.g. all of India, 00:00–05:30 IST).
 */
export function resolveTodayKey(
  clientLocalDate: unknown,
  timeZone?: string | null,
  now: Date = new Date(),
): string {
  return normalizeLocalDate(clientLocalDate) ?? localDateInTimeZone(timeZone, now);
}

export type LocalDateResult =
  | { ok: true; normalized: string }
  | { ok: false; code: "malformed" | "out_of_range" | "invalid_calendar_date" | "outside_window"; message: string };

/**
 * Validate a client `YYYY-MM-DD` (single- or double-digit month/day accepted)
 * and require it to fall within [today - pastDays, today + futureDays].
 * `now` is compared using its UTC calendar date to stay engine-independent.
 */
export function validateRecentLocalDate(
  input: unknown,
  opts: { pastDays?: number; futureDays?: number; now?: Date; today?: string } = {},
): LocalDateResult {
  const pastDays = opts.pastDays ?? 1;
  const futureDays = opts.futureDays ?? 0;
  const now = opts.now ?? new Date();

  if (typeof input !== "string") {
    return { ok: false, code: "malformed", message: "Date must be a YYYY-MM-DD string." };
  }
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(input.trim());
  if (!match) {
    return { ok: false, code: "malformed", message: "Date must be in YYYY-MM-DD format." };
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { ok: false, code: "out_of_range", message: "Date has an invalid month or day." };
  }
  if (day > daysInMonth(year, month)) {
    return { ok: false, code: "invalid_calendar_date", message: "Date is not a real calendar date." };
  }

  const normalized = `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const normalizedToday = normalizeLocalDate(opts.today);
  const todayNum = normalizedToday
    ? (() => {
        const [todayYear, todayMonth, todayDay] = normalizedToday.split("-").map(Number);
        return toDayNumber(todayYear, todayMonth, todayDay);
      })()
    : toDayNumber(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
  const dateNum = toDayNumber(year, month, day);
  if (dateNum < todayNum - pastDays || dateNum > todayNum + futureDays) {
    return {
      ok: false,
      code: "outside_window",
      message: `Date must be within the last ${pastDays} day(s) and not in the future.`,
    };
  }

  return { ok: true, normalized };
}
