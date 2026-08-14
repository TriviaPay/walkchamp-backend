import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const races = readFileSync("src/routes/races.ts", "utf8");
const router = readFileSync("src/routes/unlimitedChallenge.ts", "utf8");
const liveProgress = readFileSync("src/lib/unlimitedLiveProgress.ts", "utf8");
const statuses = readFileSync("src/lib/unlimitedChallengeStatuses.ts", "utf8");
const service = readFileSync("src/lib/unlimitedChallengeService.ts", "utf8");
const leaveRoute = races.slice(
  races.indexOf('router.post("/races/:id/leave"'),
  races.indexOf("// ── GET /api/races", races.indexOf('router.post("/races/:id/leave"')),
);
const startRoute = races.slice(
  races.indexOf('router.post("/races/:id/start"'),
  races.indexOf("// ── POST /api/races/:id/cancel"),
);
const cancelRoute = races.slice(
  races.indexOf('router.post("/races/:id/cancel"'),
  races.indexOf("// Participant leaves a race."),
);

describe("Unlimited leave membership", () => {
  it("records leave as a left participant with leftAt", () => {
    expect(service).toContain('qualificationStatus: "left"');
    expect(service).toContain("leftAt: now");
  });

  it("treats leave/forfeit aliases as inactive membership statuses", () => {
    expect(statuses).toContain('["left", "forfeited", "withdrawn", "quit"] as const');
    expect(statuses).toContain('export const UNLIMITED_NON_ACTIVE_STATUSES = [...UNLIMITED_LEFT_STATUSES, "disqualified"] as const');
  });

  it("classic /races/:id/leave falls through to Unlimited leave when the id is not a race room", () => {
    expect(leaveRoute).toContain("const result = await leaveUnlimitedChallenge(userId, raceId)");
    expect(leaveRoute).toContain("current_user_registered: false");
    expect(startRoute).not.toContain("leaveUnlimitedChallenge(userId, raceId)");
    expect(cancelRoute).not.toContain("leaveUnlimitedChallenge(userId, raceId)");
  });

  it("Unlimited active/upcoming/list reads exclude inactive membership statuses", () => {
    expect(router).toContain("notInArray(unlimitedChallengeParticipantsTable.qualificationStatus, [...UNLIMITED_NON_ACTIVE_STATUSES])");
    expect(races).toContain("notInArray(unlimitedChallengeParticipantsTable.qualificationStatus, [...UNLIMITED_NON_ACTIVE_STATUSES])");
    expect(router).toContain("current_user_registered: currentUserRegistered");
  });

  it("detail roster and leaderboard exclude inactive racers", () => {
    expect(liveProgress).toContain("notInArray(unlimitedChallengeParticipantsTable.qualificationStatus, [...UNLIMITED_NON_ACTIVE_STATUSES])");
    expect(router).toContain("notInArray(unlimitedChallengeParticipantsTable.qualificationStatus, [...UNLIMITED_NON_ACTIVE_STATUSES])");
  });
});
