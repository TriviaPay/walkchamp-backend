import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const races = readFileSync("src/routes/races.ts", "utf8");

describe("GET /api/races viewer membership", () => {
  it("excludes terminal participant statuses from active roster previews", () => {
    expect(races).toContain('const RACE_ROSTER_EXCLUDED_STATUSES = ["left", "forfeited", "disqualified"] as const');
    expect(races).toContain("notInArray(raceParticipantsTable.status, [...RACE_ROSTER_EXCLUDED_STATUSES])");
  });

  it("returns explicit viewer participant status and active membership", () => {
    expect(races).toContain("const RACE_NON_PARTICIPATING_STATUSES = [\"left\", \"forfeited\", \"disqualified\", \"completed\"] as const");
    expect(races).toContain("const viewerStatusByRace = new Map");
    expect(races).toContain("currentUserParticipantStatus,");
    expect(races).toContain("currentUserParticipating,");
  });

  it("uses participant rows as completed-card roster source while result rows supply prizes", () => {
    const completedBranch = races.slice(
      races.indexOf('if (room.status === "completed")'),
      races.indexOf("} else {", races.indexOf('if (room.status === "completed")')),
    );

    expect(completedBranch).toContain(".from(raceResultsTable)");
    expect(completedBranch).toContain("prizeCents: raceResultsTable.prizeCents");
    expect(completedBranch).toContain("eligibleForPrize: raceResultsTable.eligibleForPrize");
    expect(completedBranch).toContain(".from(raceParticipantsTable)");
    expect(completedBranch).toContain("where(eq(raceParticipantsTable.raceRoomId, room.id))");
    expect(completedBranch).toContain("const resultByUserId = new Map");
    expect(completedBranch).toContain(".filter((p) => !resultByUserId.has(p.userId))");
    expect(completedBranch).toContain("currentSteps: p.finalSteps ?? p.currentSteps");
    expect(completedBranch).toContain("eligibleForPrize: false");
    expect(completedBranch).toContain("rank: room.currentPlayers + i + 1");
    expect(completedBranch).toContain("players = [...players, ...terminalPlayers]");
  });
});
