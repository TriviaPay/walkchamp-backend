import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const walk = readFileSync("src/routes/walk.ts", "utf8");
const handler = walk.slice(
  walk.indexOf("const submitStepsSchema"),
  walk.indexOf('router.get("/walk/history"'),
);

describe("POST /walk/steps local timezone daily totals", () => {
  it("accepts and persists the device timezone before resolving the daily key", () => {
    expect(handler).toContain("timezone: z.string().trim().max(64).optional()");
    expect(handler).toContain("const submittedTimezone = parsed.data.timezone?.trim()");
    expect(handler).toContain("isRecognizedTimeZone(submittedTimezone)");
    expect(handler).toContain(".insert(userPreferencesTable)");
    expect(handler).toContain("set: { timezone: submittedTimezone, updatedAt: receivedAt }");
    expect(handler).toContain("const effectiveTimezone = submittedTimezone || existingPrefs?.timezone || \"UTC\"");
  });

  it("validates against localToday, allowing yesterday and today but not tomorrow", () => {
    expect(handler).toContain("const localToday = localDateInTimeZone(effectiveTimezone, receivedAt)");
    expect(handler).toContain("validateRecentLocalDate(parsed.data.localDate ?? localToday");
    expect(handler).toContain("pastDays: 1");
    expect(handler).toContain("futureDays: hasTrustedTimezone ? 0 : 1");
    expect(handler).toContain("today: localToday");
    expect(handler).not.toContain("localDateStr(undefined); // server UTC date");
  });

  it("keeps the +1 day tolerance when the timezone is a UTC guess, so stale clients still sync", () => {
    // A client that predates the timezone field, with no stored preference, falls back to UTC.
    // For any positive offset its localDate is a day AHEAD of the UTC date every evening/night;
    // rejecting that would silently stop step ingestion until the user's local morning.
    expect(handler).toContain("const hasTrustedTimezone = !!(submittedTimezone || existingPrefs?.timezone)");

    const toNum = (s: string) => {
      const [y, m, d] = s.split("-").map(Number);
      return Date.UTC(y, m - 1, d) / 86_400_000;
    };
    const accepts = (localDate: string, today: string, futureDays: number) =>
      toNum(localDate) >= toNum(today) - 1 && toNum(localDate) <= toNum(today) + futureDays;

    // 00:30 IST on Aug 8 is still Aug 7 in UTC.
    expect(accepts("2026-08-08", "2026-08-07", 0)).toBe(false); // strict: would 400 a stale client
    expect(accepts("2026-08-08", "2026-08-07", 1)).toBe(true);  // tolerant fallback: still syncs

    // With the real zone, localToday IS Aug 8, so strictness costs nothing and tomorrow is still out.
    expect(accepts("2026-08-08", "2026-08-08", 0)).toBe(true);
    expect(accepts("2026-08-09", "2026-08-08", 0)).toBe(false);
  });

  it("does not preserve yesterday's leftover total during local midnight rollover", () => {
    expect(handler).toContain("const allowRolloverReplace =");
    expect(handler).toContain("&& sessionVerified");
    expect(handler).toContain("&& today === localToday");
    expect(handler).toContain("&& totalSteps < previousSteps");
    expect(handler).toContain("localHourInTimeZone(effectiveTimezone, receivedAt) < ROLLOVER_REPLACE_HOURS");
    expect(handler).toContain("steps: totalSteps");
    expect(handler).toContain("Replace the row so yesterday's leftover does not become today's steps.");
  });

  it("still uses monotonic GREATEST outside rollover and keeps yesterday writes independent", () => {
    expect(handler).toContain("Absolute mode: GREATEST so daily steps are monotonically increasing.");
    expect(handler).toContain("steps: sql`GREATEST(${stepDailyTotalsTable.steps}, ${totalSteps})`");
    expect(handler).toContain("deviceLocalDate: today");
  });
});
