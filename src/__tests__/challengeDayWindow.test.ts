import { describe, expect, it } from "vitest";
import { buildDayWindows, computeChallengeEndUtc, isValidTimezone } from "../lib/challengeDayWindow.js";

describe("isValidTimezone", () => {
  it("accepts IANA zones and rejects junk", () => {
    expect(isValidTimezone("America/Chicago")).toBe(true);
    expect(isValidTimezone("Asia/Kolkata")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Not/AZone")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});

describe("buildDayWindows — Day 1 is the first FULL local day (no short Day 1)", () => {
  it("mid-day start: warm-up remainder is skipped, Day 1 is the next local date", () => {
    // 2026-03-02 14:00 UTC. In UTC tz, local = 14:00 on the 2nd, so Day 1 = the 3rd.
    const start = new Date("2026-03-02T14:00:00.000Z");
    const w = buildDayWindows(start, "UTC", 7, 10000);
    expect(w).toHaveLength(7);
    expect(w[0].dayNumber).toBe(1);
    expect(w[0].localDate).toBe("2026-03-03");
    expect(w[0].windowStartUtc.toISOString()).toBe("2026-03-03T00:00:00.000Z");
    expect(w[0].windowEndUtc.toISOString()).toBe("2026-03-04T00:00:00.000Z");
    expect(w[6].localDate).toBe("2026-03-09");
  });

  it("start exactly at local midnight: that date is already a full Day 1", () => {
    const start = new Date("2026-03-02T00:00:00.000Z");
    const w = buildDayWindows(start, "UTC", 10, 10000);
    expect(w[0].localDate).toBe("2026-03-02");
    expect(w).toHaveLength(10);
    expect(w[9].localDate).toBe("2026-03-11");
  });

  it("each day window is contiguous (end of day N == start of day N+1)", () => {
    const w = buildDayWindows(new Date("2026-06-01T09:30:00.000Z"), "America/Chicago", 30, 8000);
    for (let i = 1; i < w.length; i++) {
      expect(w[i].windowStartUtc.toISOString()).toBe(w[i - 1].windowEndUtc.toISOString());
    }
    expect(w.every((d) => d.goalSteps === 8000)).toBe(true);
  });
});

describe("buildDayWindows — timezone correctness", () => {
  it("uses the participant's local midnight, not UTC midnight (Asia/Kolkata = UTC+5:30)", () => {
    // Start 2026-04-10 20:00 UTC = 2026-04-11 01:30 IST -> Day 1 = 2026-04-12 IST.
    const w = buildDayWindows(new Date("2026-04-10T20:00:00.000Z"), "Asia/Kolkata", 7, 10000);
    expect(w[0].localDate).toBe("2026-04-12");
    // IST midnight is 18:30 UTC the previous day.
    expect(w[0].windowStartUtc.toISOString()).toBe("2026-04-11T18:30:00.000Z");
    expect(w[0].windowEndUtc.toISOString()).toBe("2026-04-12T18:30:00.000Z");
  });

  it("handles a US spring-forward DST day as a 23-hour window", () => {
    // US DST 2026: clocks spring forward on 2026-03-08 in America/Chicago.
    const w = buildDayWindows(new Date("2026-03-06T12:00:00.000Z"), "America/Chicago", 7, 10000);
    const dstDay = w.find((d) => d.localDate === "2026-03-08");
    expect(dstDay).toBeDefined();
    const hours = (dstDay!.windowEndUtc.getTime() - dstDay!.windowStartUtc.getTime()) / 3_600_000;
    expect(hours).toBe(23); // spring forward loses an hour
  });

  it("handles a US fall-back DST day as a 25-hour window", () => {
    // US DST 2026: clocks fall back on 2026-11-01 in America/Chicago.
    const w = buildDayWindows(new Date("2026-10-30T12:00:00.000Z"), "America/Chicago", 7, 10000);
    const dstDay = w.find((d) => d.localDate === "2026-11-01");
    expect(dstDay).toBeDefined();
    const hours = (dstDay!.windowEndUtc.getTime() - dstDay!.windowStartUtc.getTime()) / 3_600_000;
    expect(hours).toBe(25); // fall back gains an hour
  });
});

describe("computeChallengeEndUtc", () => {
  it("equals the end of the last day's window", () => {
    const start = new Date("2026-05-01T10:00:00.000Z");
    const end = computeChallengeEndUtc(start, "UTC", 7);
    const w = buildDayWindows(start, "UTC", 7, 10000);
    expect(end.toISOString()).toBe(w[6].windowEndUtc.toISOString());
    // Day 1 = 05-02, 7 days -> last day 05-08, ends 05-09 00:00 UTC.
    expect(end.toISOString()).toBe("2026-05-09T00:00:00.000Z");
  });
});
