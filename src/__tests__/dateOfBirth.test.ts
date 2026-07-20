/**
 * Date-of-birth validation — accepts single/double-digit day/month, rejects impossible calendar
 * dates, future dates, and underage dates. Normalizes to YYYY-MM-DD without JS Date correction.
 */
import { describe, it, expect } from "vitest";
import { parseAndValidateDob, calcAgeFromDob, computeIsAdult, MIN_SIGNUP_AGE } from "../lib/dateOfBirth";

// Fixed "today" so future/underage assertions are deterministic (July 18, 2026, local).
const NOW = new Date(2026, 6, 18);

function ok(input: string) {
  const r = parseAndValidateDob(input, NOW);
  expect(r.ok, `expected ${input} to be accepted, got ${JSON.stringify(r)}`).toBe(true);
  return r as Extract<typeof r, { ok: true }>;
}

function reject(input: string, code?: string) {
  const r = parseAndValidateDob(input, NOW);
  expect(r.ok, `expected ${input} to be rejected`).toBe(false);
  if (code && r.ok === false) expect(r.code).toBe(code);
  return r as Extract<typeof r, { ok: false }>;
}

describe("parseAndValidateDob — accepts", () => {
  it("single and double digit forms normalize identically", () => {
    expect(ok("2000-1-1").normalized).toBe("2000-01-01");
    expect(ok("2000-01-01").normalized).toBe("2000-01-01");
    expect(ok("2000-9-9").normalized).toBe("2000-09-09");
    expect(ok("2000-09-09").normalized).toBe("2000-09-09");
    expect(parseAndValidateDob("2000-9-9", NOW)).toEqual(parseAndValidateDob("2000-09-09", NOW));
  });

  it("valid calendar edge dates", () => {
    expect(ok("2000-02-29").normalized).toBe("2000-02-29"); // 2000 is a leap year
    expect(ok("2000-04-30").normalized).toBe("2000-04-30");
    expect(ok("2000-01-31").normalized).toBe("2000-01-31");
  });

  it("computes age correctly (birthday not yet reached this year)", () => {
    expect(ok("2000-09-09").age).toBe(25); // Sep birthday, 'today' is July
    expect(ok("2000-01-01").age).toBe(26);
  });
});

describe("computeIsAdult — derived from DOB, not a stale stored flag", () => {
  it("recomputes adulthood as the user ages (fixes the stored is_adult staleness bug)", () => {
    // Someone who was 17 at signup is now 18 by NOW — must be treated as adult
    // even if a stored flag would still say false.
    const eighteenthBirthday = new Date(NOW.getFullYear() - MIN_SIGNUP_AGE, NOW.getMonth(), NOW.getDate());
    const dob = `${eighteenthBirthday.getFullYear()}-${String(eighteenthBirthday.getMonth() + 1).padStart(2, "0")}-${String(eighteenthBirthday.getDate()).padStart(2, "0")}`;
    expect(computeIsAdult(dob, false, NOW)).toBe(true);
  });

  it("returns false for a genuine minor regardless of a stored true flag", () => {
    expect(computeIsAdult("2020-01-01", true, NOW)).toBe(false);
  });

  it("accepts single-digit month/day", () => {
    expect(computeIsAdult("2000-1-1", false, NOW)).toBe(true);
  });

  it("falls back to the stored flag only when DOB is missing/invalid", () => {
    expect(computeIsAdult(null, true, NOW)).toBe(true);
    expect(computeIsAdult(null, false, NOW)).toBe(false);
    expect(computeIsAdult("garbage", true, NOW)).toBe(true);
  });
});

describe("parseAndValidateDob — rejects day/month out of range", () => {
  it("day 0 / 00 / 32", () => {
    reject("2000-01-0", "out_of_range");
    reject("2000-01-00", "out_of_range");
    reject("2000-01-32", "out_of_range");
  });
  it("month 0 / 00 / 13", () => {
    reject("2000-0-15", "out_of_range");
    reject("2000-00-15", "out_of_range");
    reject("2000-13-01", "out_of_range");
  });
});

describe("parseAndValidateDob — rejects impossible calendar dates", () => {
  it("Feb 30/31, non-leap Feb 29, Apr 31", () => {
    reject("2000-02-31", "invalid_calendar_date");
    reject("2000-02-30", "invalid_calendar_date");
    reject("2001-02-29", "invalid_calendar_date"); // 2001 not a leap year
    reject("2000-04-31", "invalid_calendar_date");
  });
});

describe("parseAndValidateDob — rejects future and underage", () => {
  it("future date", () => {
    reject("2030-01-01", "future_date");
    reject("2026-07-19", "future_date"); // one day after NOW
  });
  it("underage", () => {
    reject("2020-01-01", "underage");
    reject("2008-07-19", "underage"); // turns 18 the day after NOW
  });
  it("exactly minimum age is accepted", () => {
    const r = ok("2008-07-18"); // turns 18 exactly on NOW
    expect(r.age).toBe(MIN_SIGNUP_AGE);
  });
});

describe("parseAndValidateDob — rejects malformed input", () => {
  it("non-date and wrong separators / lengths", () => {
    reject("not-a-date", "malformed");
    reject("2000/01/01", "malformed");
    reject("", "malformed");
    reject("2000-1", "malformed");
    reject("20000-01-01", "malformed");
    reject("01-01-2000", "malformed");
  });
  it("non-string input", () => {
    expect(parseAndValidateDob(undefined as unknown as string, NOW).ok).toBe(false);
    expect(parseAndValidateDob(20000101 as unknown as string, NOW).ok).toBe(false);
  });
});

describe("calcAgeFromDob", () => {
  it("does not apply birthday until the day is reached", () => {
    expect(calcAgeFromDob("2000-07-17", NOW)).toBe(26); // birthday yesterday
    expect(calcAgeFromDob("2000-07-18", NOW)).toBe(26); // birthday today
    expect(calcAgeFromDob("2000-07-19", NOW)).toBe(25); // birthday tomorrow
  });
});
