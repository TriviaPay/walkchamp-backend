import { describe, expect, it } from "vitest";
import { validateRecentLocalDate } from "../lib/localDate.js";

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
