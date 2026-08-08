import { describe, expect, it } from "vitest";
import {
  localDateInTimeZone,
  normalizeLocalDate,
  resolveTodayKey,
  validateRecentLocalDate,
} from "../lib/localDate.js";

// H-7 / M-6: step dates must be bounded to a recent window so users cannot
// backfill milestone rewards or poison historical leaderboards.
describe("validateRecentLocalDate (H-7 / M-6)", () => {
  const now = new Date("2026-07-20T12:00:00Z");

  it("accepts today and yesterday", () => {
    expect(validateRecentLocalDate("2026-07-20", { now }).ok).toBe(true);
    expect(validateRecentLocalDate("2026-07-19", { now }).ok).toBe(true);
  });

  it("normalizes single-digit month/day", () => {
    const r = validateRecentLocalDate("2026-7-20", { now });
    expect(r.ok && r.normalized).toBe("2026-07-20");
  });

  it("rejects backdated submissions (the milestone-farming vector)", () => {
    const r = validateRecentLocalDate("2020-01-01", { now });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("outside_window");
  });

  it("rejects far-future dates", () => {
    const r = validateRecentLocalDate("9999-12-31", { now });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("outside_window");
  });

  it("rejects non-calendar dates without JS Date auto-correction", () => {
    const r = validateRecentLocalDate("2026-02-31", { now });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_calendar_date");
  });

  it("rejects malformed input", () => {
    expect(validateRecentLocalDate("not-a-date", { now }).ok).toBe(false);
    expect(validateRecentLocalDate(12345 as unknown, { now }).ok).toBe(false);
    expect(validateRecentLocalDate("2026-13-01", { now }).ok).toBe(false);
  });

  it("honors a widened past window when configured", () => {
    expect(validateRecentLocalDate("2026-07-14", { now, pastDays: 7 }).ok).toBe(true);
    expect(validateRecentLocalDate("2026-07-10", { now, pastDays: 7 }).ok).toBe(false);
  });
});

// The "daily steps show yesterday" bug: step_daily_totals rows are written keyed by the user's
// LOCAL date, so any read that keys off the server's UTC date returns the wrong bucket for users
// east of UTC between their local midnight and UTC midnight.
describe("local calendar day resolution", () => {
  // 00:30 IST on Aug 8 is still Aug 7 in UTC — the exact window users reported.
  const indiaAfterMidnight = new Date("2026-08-07T19:00:00Z");

  it("resolves the user's local day, not the UTC day", () => {
    expect(indiaAfterMidnight.toISOString().slice(0, 10)).toBe("2026-08-07");
    expect(localDateInTimeZone("Asia/Kolkata", indiaAfterMidnight)).toBe("2026-08-08");
  });

  it("prefers a client-supplied localDate over the stored timezone", () => {
    expect(resolveTodayKey("2026-08-08", "UTC", indiaAfterMidnight)).toBe("2026-08-08");
    expect(resolveTodayKey("2026-8-8", "UTC", indiaAfterMidnight)).toBe("2026-08-08");
  });

  it("falls back to the stored timezone when the client sends nothing", () => {
    expect(resolveTodayKey(undefined, "Asia/Kolkata", indiaAfterMidnight)).toBe("2026-08-08");
    expect(resolveTodayKey(null, "America/Chicago", indiaAfterMidnight)).toBe("2026-08-07");
  });

  it("falls back to UTC for a missing, unknown, or malformed zone", () => {
    expect(resolveTodayKey(undefined, undefined, indiaAfterMidnight)).toBe("2026-08-07");
    expect(resolveTodayKey(undefined, "Not/AZone", indiaAfterMidnight)).toBe("2026-08-07");
    expect(resolveTodayKey("garbage", "UTC", indiaAfterMidnight)).toBe("2026-08-07");
  });

  it("handles a zone west of UTC that is still on the previous day", () => {
    // 00:30 UTC Aug 8 is still Aug 7 in Chicago.
    const justAfterUtcMidnight = new Date("2026-08-08T00:30:00Z");
    expect(localDateInTimeZone("America/Chicago", justAfterUtcMidnight)).toBe("2026-08-07");
    expect(localDateInTimeZone("Asia/Kolkata", justAfterUtcMidnight)).toBe("2026-08-08");
  });

  it("rejects non-calendar dates from the client", () => {
    expect(normalizeLocalDate("2026-02-31")).toBeNull();
    expect(normalizeLocalDate("2026-13-01")).toBeNull();
    expect(normalizeLocalDate(20260808)).toBeNull();
    expect(normalizeLocalDate("2026-02-29")).toBeNull(); // 2026 is not a leap year
    expect(normalizeLocalDate("2024-02-29")).toBe("2024-02-29"); // 2024 is
  });
});
