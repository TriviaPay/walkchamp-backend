import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Contract tests (source-grep) for the winner-selection & forfeit backend requirement.
// These pin the behavioral invariants that live inside the large race route + schema so a
// regression that reverts them fails CI. Pure winner-ordering logic is covered separately in
// raceSettlement.test.ts; DB-effect flows are asserted here structurally.

const racesSrc = readFileSync("src/routes/races.ts", "utf8");
const raceSchema = readFileSync("db/src/schema/races.ts", "utf8");
const liveRaceSchema = readFileSync("db/src/schema/liveRace.ts", "utf8");
const liveStateSrc = readFileSync("src/lib/raceLiveState.ts", "utf8");
const migration = readFileSync("db/migrations/0018_late_starfox.sql", "utf8");

describe("winner-slot freeze at race start", () => {
  it("stores startingParticipantCount + winnerSlotCount columns", () => {
    expect(raceSchema).toContain('startingParticipantCount: integer("starting_participant_count")');
    expect(raceSchema).toContain('winnerSlotCount: integer("winner_slot_count")');
  });

  it("freezes both counts in the /start transition and never recalculates", () => {
    expect(racesSrc).toContain('room.type === "sponsored"');
    expect(racesSrc).toContain("getSponsoredWinnerCount(startingParticipantCount ?? 0)");
    expect(racesSrc).toContain("getWinnerSlotCount(startingParticipantCount ?? 0)");
    expect(racesSrc).toContain("startingParticipantCount: startingParticipantCount ?? 0");
    expect(racesSrc).toContain("winnerSlotCount,");
  });
});

describe("completion-gated settlement", () => {
  it("gates the new path on the frozen starting count (new races only)", () => {
    expect(racesSrc).toContain("const useNewSettlement = !isSponsored && room.startingParticipantCount != null");
  });

  it("selects winners from completers only, ordered by authoritative completion time", () => {
    expect(racesSrc).toContain("const winners = selectWinners(completers, winnerSlotCount, raceId)");
    // completers = participants with a non-null finishedAtMs within the race duration
    expect(racesSrc).toContain("p.finishedAtMs != null");
    expect(racesSrc).toContain("<= raceEndAtForSettlement.getTime()");
  });

  it("assigns unique winner positions with no tie splitting", () => {
    expect(racesSrc).toContain("assignNewSettlementPayouts(uniqueParticipants, newSettlement.positionByUser, newSettlement.cashByUser)");
    expect(racesSrc).toContain("winnerPosition: pos");
  });

  it("retains unfilled winner-slot value for the platform (no redistribution)", () => {
    expect(racesSrc).toContain("totalPoolCents - newSettlement.awardedCashCents");
    expect(racesSrc).toContain("coinPlatformFeeCoins = coinWinnersPool - totalDistributed");
  });

  it("excludes forfeited, left AND disqualified participants from settlement", () => {
    expect(racesSrc).toContain('ne(raceParticipantsTable.status, "disqualified")');
  });

  it("only actual winners (with a winner position) earn race-win / room-win coins", () => {
    expect(racesSrc).toContain("const isActualWinner = newSettlement ? (r.winnerPosition != null) : (r.rank <= winnerSlots)");
    expect(racesSrc).toContain("const isRoomWinner = newSettlement ? (r.winnerPosition === 1) : (r.rank === 1)");
  });
});

describe("goal completion is recorded once, within duration, on server time", () => {
  it("guards both finish-write paths against completion after race end", () => {
    const guards = racesSrc.match(/Within-duration guard \(§4\/§11\)/g) ?? [];
    expect(guards.length).toBe(2); // Postgres path + Redis persistRedisFinish path
    expect(racesSrc).toContain("if (raceEndAt && finishedAtMs > raceEndAt.getTime()) return null");
  });
});

describe("forfeit endpoint", () => {
  it("no longer declares a winner-by-forfeit", () => {
    expect(racesSrc).not.toContain("winner_by_forfeit");
  });

  it("is atomic + idempotent — only transitions from a live status", () => {
    expect(racesSrc).toContain('notInArray(raceParticipantsTable.status, ["forfeited", "disqualified", "left", "completed"])');
  });

  it("records an authoritative forfeitedAtMs and an audit row", () => {
    expect(raceSchema).toContain('forfeitedAtMs: bigint("forfeited_at_ms", { mode: "number" })');
    expect(racesSrc).toContain("forfeitedAtMs,");
    expect(racesSrc).toContain('action: "race.forfeit"');
  });

  it("issues NO refund and keeps the race active", () => {
    expect(racesSrc).toContain('refund: { eligible: false, type: "none", cashAmountMinor: 0, coinAmount: 0 }');
    expect(racesSrc).toContain("raceContinues: true");
    expect(racesSrc).toContain('participantStatus: "forfeited"');
  });

  it("evicts the forfeited player from redis-live so queued ticks cannot reactivate them", () => {
    expect(racesSrc).toContain("void removeParticipantLiveState(raceId, userId)");
    expect(liveStateSrc).toContain("export async function removeParticipantLiveState");
    // Must NOT nuke the race-level state for a single-participant removal.
    expect(liveStateSrc).toContain(".del(pKey(raceId, userId))");
  });
});

describe("step updates stop after forfeit", () => {
  it("the progress endpoint fetches participant status and rejects non-active syncs", () => {
    expect(racesSrc).toContain("status: raceParticipantsTable.status");
    expect(racesSrc).toContain('participantData.status === "forfeited"');
    expect(racesSrc).toContain("You are no longer an active participant in this race.");
  });
});

describe("schema + migration for winner-position uniqueness", () => {
  it("adds a nullable winner_position with a partial unique index", () => {
    expect(liveRaceSchema).toContain('winnerPosition: integer("winner_position")');
    expect(liveRaceSchema).toContain("race_results_room_winner_position_uniq");
  });

  it("migration 0018 applies all four columns + the partial unique index", () => {
    expect(migration).toContain('ADD COLUMN "starting_participant_count" integer');
    expect(migration).toContain('ADD COLUMN "winner_slot_count" integer');
    expect(migration).toContain('ADD COLUMN "forfeited_at_ms" bigint');
    expect(migration).toContain('ADD COLUMN "winner_position" integer');
    expect(migration).toContain('CREATE UNIQUE INDEX "race_results_room_winner_position_uniq"');
    expect(migration).toContain('WHERE "race_results"."winner_position" IS NOT NULL');
  });
});
