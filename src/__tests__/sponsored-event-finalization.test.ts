import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const races = readFileSync("src/routes/races.ts", "utf8");

describe("sponsored event finalization wiring", () => {
  it("freezes sponsored winner slots with the sponsored rule at race start", () => {
    const startTransition = races.slice(
      races.indexOf("// ── Freeze winner slots at race start"),
      races.indexOf("// Compare-and-set: only the caller holding the \"starting\" claim commits the activation."),
    );

    expect(startTransition).toContain('room.type === "sponsored"');
    expect(startTransition).toContain("getSponsoredWinnerCount(startingParticipantCount ?? 0)");
    expect(startTransition).toContain("getWinnerSlotCount(startingParticipantCount ?? 0)");
  });

  it("uses sponsored winner slots for both finish-write finalizers", () => {
    const redisFinish = races.slice(
      races.indexOf("async function persistRedisFinish"),
      races.indexOf("function liveStatusToRaceStatus"),
    );
    const postgresFinish = races.slice(
      races.indexOf("// Detect first-time goal crossing"),
      races.indexOf("// Normal step update — no goal crossing"),
    );

    expect(redisFinish).toContain('room.type === "sponsored"');
    expect(redisFinish).toContain("getSponsoredWinnerCount(room.startingParticipantCount ?? room.currentPlayers ?? 0)");
    expect(postgresFinish).toContain('lockedRoom.type === "sponsored"');
    expect(postgresFinish).toContain("getSponsoredWinnerCount(lockedRoom.startingParticipantCount ?? lockedRoom.currentPlayers ?? 0)");
  });

  it("keeps the sponsored cleanup safety net on the sponsored rule", () => {
    expect(races).toContain("[cleanupOverdueRaces] sponsored winner slots filled");
    expect(races).toContain("[recoverStaleRaces] sponsored winner slots filled");
  });
});
