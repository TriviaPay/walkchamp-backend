import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildRescheduledTimezoneDays } from "../lib/unlimitedTimezoneChange.js";
import { buildDayWindowsFromLocalDate } from "../lib/challengeDayWindow.js";

function futureDays(timezone: string, startDate: string, firstDayNumber: number, count: number) {
  return buildDayWindowsFromLocalDate(startDate, timezone, count, 10_000).map((day, index) => ({
    id: `day-${firstDayNumber + index}`,
    dayNumber: firstDayNumber + index,
    goalSteps: day.goalSteps,
    timezone,
    windowStartUtc: day.windowStartUtc,
    windowEndUtc: day.windowEndUtc,
    status: "pending",
  }));
}

describe("Streak Challenge timezone changes", () => {
  it("starts the next day at the first new-zone midnight after the immutable current-day end", () => {
    const currentChicago = buildDayWindowsFromLocalDate("2026-08-04", "America/Chicago", 1, 10_000)[0];
    const replacements = buildRescheduledTimezoneDays({
      immutableBoundaryUtc: currentChicago.windowEndUtc,
      timezone: "Asia/Kolkata",
      futureDays: futureDays("America/Chicago", "2026-08-05", 5, 3),
    });

    expect(currentChicago.windowEndUtc.toISOString()).toBe("2026-08-05T05:00:00.000Z");
    expect(replacements[0]).toMatchObject({
      dayNumber: 5,
      localDate: "2026-08-06",
      timezone: "Asia/Kolkata",
    });
    expect(replacements[0].windowStartUtc.toISOString()).toBe("2026-08-05T18:30:00.000Z");
    expect(replacements[0].windowStartUtc.getTime()).toBeGreaterThanOrEqual(currentChicago.windowEndUtc.getTime());
    expect(replacements[1].windowStartUtc.getTime()).toBe(replacements[0].windowEndUtc.getTime());
  });

  it("keeps a seamless boundary when the immutable end is already midnight in the new zone", () => {
    const boundary = new Date("2026-08-05T04:00:00.000Z"); // midnight New York (DST)
    const replacements = buildRescheduledTimezoneDays({
      immutableBoundaryUtc: boundary,
      timezone: "America/New_York",
      futureDays: futureDays("America/Chicago", "2026-08-05", 2, 2),
    });
    expect(replacements[0].windowStartUtc.toISOString()).toBe(boundary.toISOString());
  });

  it("uses IANA calendar arithmetic across DST", () => {
    const replacements = buildRescheduledTimezoneDays({
      immutableBoundaryUtc: new Date("2026-10-31T04:00:00.000Z"),
      timezone: "America/New_York",
      futureDays: futureDays("UTC", "2026-11-01", 3, 3),
    });
    const nov1 = replacements.find((day) => day.localDate === "2026-11-01");
    expect(nov1).toBeDefined();
    expect((nov1!.windowEndUtc.getTime() - nov1!.windowStartUtc.getTime()) / 3_600_000).toBe(25);
  });

  it("rejects offsets and ambiguous abbreviations", () => {
    expect(() => buildRescheduledTimezoneDays({
      immutableBoundaryUtc: new Date(),
      timezone: "+05:30",
      futureDays: futureDays("UTC", "2026-08-05", 2, 1),
    })).toThrow(/Invalid IANA timezone/);
  });

  it("wires an authenticated confirmation endpoint and an auditable history response", () => {
    const route = readFileSync(new URL("../routes/unlimitedChallenge.ts", import.meta.url), "utf8");
    expect(route).toContain('router.post("/unlimited-challenges/:id/timezone", requireAuth, requireActiveAccount');
    expect(route).toContain("changeUnlimitedParticipantTimezone({");
    expect(route).toContain("timezoneHistory: timezoneHistory.map");
    expect(route).toContain("timezoneChangeConfirmedAt");
    expect(route).toContain("timezoneEffectiveDay");
  });

  it("guards future-row updates so a started or terminal day cannot be rewritten", () => {
    const service = readFileSync(new URL("../lib/unlimitedTimezoneChange.ts", import.meta.url), "utf8");
    expect(service).toContain('eq(unlimitedChallengeDaysTable.status, "pending")');
    expect(service).toContain("gt(unlimitedChallengeDaysTable.windowStartUtc, now)");
    expect(service).toContain("challenge.durationDays + 1");
    expect(service).toContain("appliesToChallenge: !finalDayTimezoneLocked");
  });
});
