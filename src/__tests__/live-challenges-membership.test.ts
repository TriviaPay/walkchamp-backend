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
});
