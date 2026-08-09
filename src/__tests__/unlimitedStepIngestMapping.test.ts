import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { computeParticipantSchedule, isStrictIanaTimezone } from "../lib/challengeDayWindow.js";
import { resolveLockableTimezone } from "../lib/unlimitedParticipantSchedule.js";

const read = (p: string) => readFileSync(p, "utf8");

describe("timezone locking", () => {
  it("locks a real Area/Location identifier unchanged", () => {
    for (const tz of ["America/Chicago", "Asia/Kolkata", "Europe/London", "America/Argentina/Salta", "UTC"]) {
      expect(resolveLockableTimezone(tz)).toBe(tz);
    }
  });

  it("refuses bare abbreviations even when Intl resolves them", () => {
    // Node maps "IST" onto Asia/Kolkata, so an Intl-only check silently accepts it. CST is
    // ambiguous between US Central and China Standard — a month of midnights cannot ride on that.
    for (const abbr of ["IST", "CST", "EST", "PST"]) {
      expect(isStrictIanaTimezone(abbr)).toBe(false);
      expect(resolveLockableTimezone(abbr)).toBe("UTC");
    }
  });

  it("falls back to UTC for junk and empty input", () => {
    expect(resolveLockableTimezone("Not/AZone")).toBe("UTC");
    expect(resolveLockableTimezone("")).toBe("UTC");
    expect(resolveLockableTimezone(null)).toBe("UTC");
  });

  it("is a pure function of the stored value — travel cannot change it", () => {
    // The locked value is what gets passed in; there is no device lookup inside. A membership
    // keeps its zone across relogin, device swap and account switch by construction.
    const locked = resolveLockableTimezone("America/Chicago");
    expect(resolveLockableTimezone(locked)).toBe("America/Chicago");
  });
});

// ── Step ingest maps onto the participant's own window ───────────────────────

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../../db/src/index.js", () => ({
  db: { select: mocks.select, update: mocks.update },
}));

const { applyVerifiedStepsToUnlimitedDays } = await import("../lib/unlimitedStepIngest.js");

const CHALLENGE_DATE = "2026-08-09";
const chicago = computeParticipantSchedule({ startLocalDate: CHALLENGE_DATE, timezone: "America/Chicago", durationDays: 7, goalSteps: 10000 });

function openDayRow(overrides: Record<string, unknown> = {}) {
  return {
    dayId: "day-chicago-1",
    challengeId: "ch-1",
    participantId: "p-chicago",
    dayNumber: 1,
    localDate: CHALLENGE_DATE,
    timezone: "America/Chicago",
    goalSteps: 10000,
    verifiedSteps: 4000,
    dayStatus: "in_progress",
    startBaselineSteps: 0,
    baselineCapturedAt: new Date("2026-08-09T05:00:00Z"),
    windowStartUtc: chicago.windows[0].windowStartUtc,
    ...overrides,
  };
}

/** db.select()...where() resolves to `rows`; db.update()...returning() resolves to `updated`. */
function stubDb(rows: unknown[], updated: unknown[] = [{ verifiedSteps: 0 }]) {
  const selectChain: Record<string, unknown> = {};
  selectChain.from = () => selectChain;
  selectChain.innerJoin = () => selectChain;
  selectChain.where = async () => rows;
  mocks.select.mockReturnValue(selectChain);

  const setCalls: Array<Record<string, unknown>> = [];
  mocks.update.mockReturnValue({
    set: (values: Record<string, unknown>) => {
      setCalls.push(values);
      return { where: () => ({ returning: async () => updated }) };
    },
  });
  return { setCalls };
}

beforeEach(() => {
  mocks.select.mockReset();
  mocks.update.mockReset();
});

describe("verified steps land on the day the window says, not the device date", () => {
  it("credits the open window when the device date agrees", async () => {
    const { setCalls } = stubDb([openDayRow()], [{ verifiedSteps: 9000 }]);

    const credits = await applyVerifiedStepsToUnlimitedDays({
      userId: "u-chicago",
      verifiedTotal: 9000,
      deviceLocalDate: CHALLENGE_DATE,
      now: new Date(chicago.windows[0].windowStartUtc.getTime() + 3_600_000),
    });

    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({ dayNumber: 1, verifiedSteps: 9000, goalReached: false, timezoneDrift: false });
    expect(setCalls[0].status).toBe("in_progress");
  });

  it("stores monotonically so a late smaller sync cannot walk a day backwards", async () => {
    const { setCalls } = stubDb([openDayRow({ verifiedSteps: 12000 })], [{ verifiedSteps: 12000 }]);

    await applyVerifiedStepsToUnlimitedDays({
      userId: "u-chicago",
      verifiedTotal: 500,
      deviceLocalDate: CHALLENGE_DATE,
      now: chicago.windows[0].windowStartUtc,
    });

    // GREATEST is pushed into SQL so two devices racing cannot clobber each other — the write is
    // a SQL expression, never a plain number computed in JS from a stale read.
    const { sql } = new PgDialect().sqlToQuery(setCalls[0].verifiedSteps as SQL);
    expect(sql).toContain("GREATEST");
    expect(sql).toContain("verified_steps");
  });

  it("reports goalReached from the day's own verified total", async () => {
    stubDb([openDayRow()], [{ verifiedSteps: 10320 }]);
    const credits = await applyVerifiedStepsToUnlimitedDays({
      userId: "u-chicago",
      verifiedTotal: 10320,
      deviceLocalDate: CHALLENGE_DATE,
      now: chicago.windows[0].windowStartUtc,
    });
    expect(credits[0].goalReached).toBe(true);
  });

  it("does not credit a day when the device local date disagrees (travel)", async () => {
    // Participant locked to America/Chicago flew to India; their phone now says Aug 10 while their
    // locked challenge day is still Aug 9. The incoming number describes a different 24h span.
    const { setCalls } = stubDb([openDayRow()]);

    const credits = await applyVerifiedStepsToUnlimitedDays({
      userId: "u-chicago",
      verifiedTotal: 15000,
      deviceLocalDate: "2026-08-10",
      now: chicago.windows[0].windowStartUtc,
    });

    expect(setCalls).toHaveLength(0); // nothing written
    expect(credits[0].timezoneDrift).toBe(true);
    expect(credits[0].verifiedSteps).toBe(4000); // unchanged
  });

  it("writes nothing when no window is open (between challenges / before start)", async () => {
    const { setCalls } = stubDb([]);
    const credits = await applyVerifiedStepsToUnlimitedDays({
      userId: "u-chicago",
      verifiedTotal: 9000,
      deviceLocalDate: CHALLENGE_DATE,
      now: new Date("2026-08-01T00:00:00Z"),
    });
    expect(credits).toEqual([]);
    expect(setCalls).toHaveLength(0);
  });

  it("ignores a negative or non-finite total without querying", async () => {
    stubDb([openDayRow()]);
    expect(await applyVerifiedStepsToUnlimitedDays({ userId: "u", verifiedTotal: -5, deviceLocalDate: CHALLENGE_DATE })).toEqual([]);
    expect(await applyVerifiedStepsToUnlimitedDays({ userId: "u", verifiedTotal: Number.NaN, deviceLocalDate: CHALLENGE_DATE })).toEqual([]);
    expect(mocks.select).not.toHaveBeenCalled();
  });
});

describe("live-display baseline (display only — never qualification)", () => {
  it("captures a baseline once, as the day row activates", async () => {
    // Fresh day: nothing credited yet, first sync of the window arrives.
    const { setCalls } = stubDb(
      [openDayRow({ dayStatus: "pending", baselineCapturedAt: null, verifiedSteps: 0 })],
      [{ verifiedSteps: 6000, startBaselineSteps: 0 }],
    );

    const credits = await applyVerifiedStepsToUnlimitedDays({
      userId: "u-chicago",
      verifiedTotal: 6000,
      deviceLocalDate: CHALLENGE_DATE,
      now: chicago.windows[0].windowStartUtc,
    });

    // Window opens at local midnight when the daily bucket is empty, so the normal case is 0 and
    // the live board keeps showing the full day.
    expect(setCalls[0].startBaselineSteps).toBe(0);
    expect(setCalls[0].baselineCapturedAt).toBeInstanceOf(Date);
    expect(credits[0]).toMatchObject({ startBaselineSteps: 0, challengeDaySteps: 6000 });
  });

  it("does not re-capture on later syncs of the same day", async () => {
    const { setCalls } = stubDb(
      [openDayRow({ dayStatus: "in_progress", baselineCapturedAt: new Date(), startBaselineSteps: 1500 })],
      [{ verifiedSteps: 9000, startBaselineSteps: 1500 }],
    );

    const credits = await applyVerifiedStepsToUnlimitedDays({
      userId: "u-chicago",
      verifiedTotal: 9000,
      deviceLocalDate: CHALLENGE_DATE,
      now: chicago.windows[0].windowStartUtc,
    });

    expect(setCalls[0]).not.toHaveProperty("startBaselineSteps");
    expect(setCalls[0]).not.toHaveProperty("baselineCapturedAt");
    // Display subtracts the fixed baseline: 9000 total, 1500 banked before the window opened.
    expect(credits[0]).toMatchObject({ startBaselineSteps: 1500, challengeDaySteps: 7500 });
  });

  it("caps a late activation baseline at what the day already holds", async () => {
    // A day activated late (heal / first sync after the window opened) with steps already banked
    // against this local date. The baseline can never exceed the day's own credited total.
    const { setCalls } = stubDb(
      [openDayRow({ dayStatus: "pending", baselineCapturedAt: null, verifiedSteps: 2000 })],
      [{ verifiedSteps: 8000, startBaselineSteps: 2000 }],
    );

    await applyVerifiedStepsToUnlimitedDays({
      userId: "u-chicago",
      verifiedTotal: 8000,
      deviceLocalDate: CHALLENGE_DATE,
      now: new Date(chicago.windows[0].windowStartUtc.getTime() + 9 * 3_600_000),
    });

    expect(setCalls[0].startBaselineSteps).toBe(2000);
  });

  it("never reports a negative challengeDaySteps", async () => {
    stubDb(
      [openDayRow({ startBaselineSteps: 9999, verifiedSteps: 100 })],
      [{ verifiedSteps: 100, startBaselineSteps: 9999 }],
    );
    const credits = await applyVerifiedStepsToUnlimitedDays({
      userId: "u-chicago",
      verifiedTotal: 100,
      deviceLocalDate: CHALLENGE_DATE,
      now: chicago.windows[0].windowStartUtc,
    });
    expect(credits[0].challengeDaySteps).toBe(0);
  });

  it("goalReached still comes from the FULL daily total, not the baseline-adjusted figure", async () => {
    // 10,400 walked today, 1,000 of it before the window opened. The goal is 10,000: the day
    // passes on the full total even though the display shows 9,400.
    stubDb(
      [openDayRow({ startBaselineSteps: 1000, goalSteps: 10000 })],
      [{ verifiedSteps: 10400, startBaselineSteps: 1000 }],
    );
    const credits = await applyVerifiedStepsToUnlimitedDays({
      userId: "u-chicago",
      verifiedTotal: 10400,
      deviceLocalDate: CHALLENGE_DATE,
      now: chicago.windows[0].windowStartUtc,
    });
    expect(credits[0].goalReached).toBe(true);
    expect(credits[0].challengeDaySteps).toBe(9400);
  });
});

describe("the ingest query is scoped by window, not by client date", () => {
  const source = read("src/lib/unlimitedStepIngest.ts");

  it("selects the open day by window boundaries containing now", () => {
    expect(source).toContain("lte(unlimitedChallengeDaysTable.windowStartUtc, now)");
    expect(source).toContain("gt(unlimitedChallengeDaysTable.windowEndUtc, now)");
    // Never keyed off the submitted local date.
    expect(source).not.toContain("eq(unlimitedChallengeDaysTable.localDate, input.deviceLocalDate)");
  });

  it("only touches days of an active challenge that are not finalized", () => {
    expect(source).toContain('eq(unlimitedChallengesTable.status, "active")');
    expect(source).toContain('inArray(unlimitedChallengeDaysTable.status, ["pending", "in_progress"])');
  });
});

describe("walk.ts routes verified totals through the window-mapped credit", () => {
  const walk = read("src/routes/walk.ts");

  it("calls the challenge-day credit on verified submissions only", () => {
    expect(walk).toContain("applyVerifiedStepsToUnlimitedDays");
    // Only verified HC/HK totals may touch qualification state; provisional/rejected sources
    // still fall through to the broadcast so the live board keeps moving.
    expect(walk).toContain("if (sessionVerified) {");
    expect(walk).toContain("deviceLocalDate: today");
  });

  it("emits per-participant day identity so peers do not assume a shared day", () => {
    expect(walk).toContain("challengeDayIndex: d.dayNumber");
    expect(walk).toContain("participantLocalDate: d.localDate");
    expect(walk).toContain("dayStatus: d.dayStatus");
    expect(walk).toContain("qualificationStatus: d.qualificationStatus");
  });
});

describe("finalization prefers the window-accurate total", () => {
  const jobs = read("src/lib/unlimitedChallengeJobs.ts");

  it("takes the max of the credited day total and the device-local daily total", () => {
    expect(jobs).toContain("Math.max(d.creditedSteps, await getVerifiedSteps(d.userId, d.localDate))");
    // The in-grace snapshot must not overwrite a window-accurate number with the fallback lane.
    expect(jobs).toContain("GREATEST(${unlimitedChallengeDaysTable.verifiedSteps}");
  });

  it("still disqualifies permanently on the first failed day", () => {
    expect(jobs).toContain('qualificationStatus: "disqualified"');
    expect(jobs).toContain('disqualificationReason: "missed_daily_goal"');
  });
});
