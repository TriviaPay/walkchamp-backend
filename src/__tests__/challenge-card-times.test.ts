import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Regression guard: the Walk "My Race" card hides its clock unless the list payload carries
// real timestamps. The card endpoints used to select neither the start columns nor the
// duration, so startedAt / scheduledStartAt / challengeEndAt were simply absent — and the
// upcoming tab echoed the raw `challenge_end_at` column, which is null until materialized
// even when the end is derivable from scheduledStartAt + challengeDurationDays.

const races = readFileSync("src/routes/races.ts", "utf8");

const cardsFn = races.slice(
  races.indexOf("export async function getChallengeCardsForUser"),
  races.indexOf("export async function getRoomCountsSummary"),
);

const upcomingTab = races.slice(
  races.indexOf('if (tab === "upcoming")'),
  races.indexOf("// ── Current tab (default)"),
);

const myActive = races.slice(
  races.indexOf('router.get("/races/my-active"'),
  races.indexOf("// ── GET /api/races/my-upcoming"),
);

/** Columns `deriveChallengeEndAt` needs — missing any one of them makes the end null. */
const TIME_COLUMNS = [
  "startedAt: raceRoomsTable.startedAt",
  "scheduledStartAt: raceRoomsTable.scheduledStartAt",
  "challengeDurationDays: raceRoomsTable.challengeDurationDays",
  "challengeEndAt: raceRoomsTable.challengeEndAt",
];

describe("challenge card time fields", () => {
  it("derives the end from the same helper the race detail uses", () => {
    const helper = races.slice(
      races.indexOf("function buildCardTimeFields"),
      races.indexOf("const EMPTY_CARD_TIME_FIELDS"),
    );
    expect(helper).toContain("buildChallengeTimeFields(room)");
    expect(helper).toContain("scheduled_start_at: scheduledStartAt");
  });

  it("every card query selects the columns the end-time derivation needs", () => {
    for (const column of TIME_COLUMNS) {
      // one for the user's own room, one for the joinable room, one for the active-other room
      expect(cardsFn.split(column).length - 1).toBeGreaterThanOrEqual(3);
    }
  });

  it("every card status carries a clock, including the empty host card", () => {
    // The four "my race" statuses share one `cardTime`; join/active-other build their own.
    expect(cardsFn).toContain("const cardTime = buildCardTimeFields(room);");
    expect(cardsFn.split("...cardTime,").length - 1).toBe(2);
    expect(cardsFn).toContain("...buildCardTimeFields(best),");
    expect(cardsFn).toContain("...buildCardTimeFields(activeOther[0]),");
    expect(cardsFn).toContain("...EMPTY_CARD_TIME_FIELDS,");
  });

  it("the upcoming tab derives challenge_end_at instead of echoing the raw column", () => {
    expect(upcomingTab).toContain("startedAt: raceRoomsTable.startedAt");
    expect(upcomingTab).toContain("const cardTime = buildCardTimeFields(r);");
    expect(upcomingTab).toContain("...cardTime,");
    // The literal below would overwrite the derived value with null.
    expect(upcomingTab).not.toContain("challenge_end_at: r.challengeEndAt");
  });

  it("my-active returns derived times for classic and unlimited races alike", () => {
    for (const column of TIME_COLUMNS) expect(myActive).toContain(column);
    expect(myActive).toContain("...buildCardTimeFields(row),");
    // Unlimited: startedAt is the actual start, so a waiting challenge reports null rather
    // than a future timestamp the card would render as an already-running clock.
    expect(myActive).toContain("startedAt: hasStarted ? startAt : null");
    expect(myActive).toContain("scheduledStartAt: startAt");
    expect(myActive).toContain("challengeEndAt: endAt");
  });
});
