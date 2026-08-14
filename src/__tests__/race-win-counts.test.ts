import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("race win counters", () => {
  it("counts every rewarded placement as a race win while keeping podium stats separate", () => {
    const leaderboardRoute = readFileSync("src/routes/leaderboard.ts", "utf8");
    const profileRoute = readFileSync("src/routes/profile.ts", "utf8");

    expect(leaderboardRoute).toContain("rr.eligible_for_prize = true");
    expect(leaderboardRoute).toContain("unlimited_challenge_payouts up");
    expect(leaderboardRoute).toContain("uc.settlement_status = 'completed'");

    expect(profileRoute).toContain("function isRaceWinResult");
    expect(profileRoute).toContain("return isRewardedRaceWinResult(r)");
    expect(profileRoute).toContain("function isRacePodiumRank");
    expect(profileRoute).toContain("racesWon     = allRaceRows.filter(isRaceWinResult).length");
    expect(profileRoute).toContain("racesWon:        raceRows.filter(isRaceWinResult).length");
    expect(profileRoute).toContain("raceWins:          raceRows.filter(isRaceWinResult).length");
    expect(profileRoute).toContain("top3Finishes = allRaceRows.filter((r) => isRacePodiumRank(r.rank)).length");
    expect(profileRoute).toContain("top3Finishes:    raceRows.filter((r) => isRacePodiumRank(r.rank)).length");
  });

  it("never downgrades a settled 'verified' race result back to pending_verification", () => {
    // POST /races/:id/reconcile only runs after the room is completed, so it rewrites rows that
    // are already settled. Without the no-downgrade guard it could leave a settled winner
    // carrying eligible_for_prize = true alongside a non-terminal status, which the race
    // leaderboard would still count. Both reconcile paths must preserve 'verified'.
    const racesRoute = readFileSync("src/routes/races.ts", "utf8");
    const guards = racesRoute.match(
      /CASE WHEN \$\{raceResultsTable\.status\} = 'verified' THEN 'verified' ELSE/g,
    );
    expect(guards).not.toBeNull();
    expect(guards!.length).toBe(2);
  });

  it("aligns title race-win metrics with eligible rewarded placements and podiums with top-3", () => {
    const titleEvaluation = readFileSync("src/lib/titleEvaluation.ts", "utf8");

    expect(titleEvaluation).toContain("COUNT(rr2.id) FILTER (WHERE rr2.eligible_for_prize = true)::text AS wins");
    expect(titleEvaluation).toContain("COUNT(rr2.id) FILTER (WHERE rr2.rank <= 3)::text                               AS podiums");
    expect(titleEvaluation).toContain("COUNT(rr2.id) FILTER (WHERE rr2.eligible_for_prize = true AND rm.entry_type = 'free')::text AS free_wins");
    expect(titleEvaluation).toContain("COUNT(rr2.id) FILTER (WHERE rr2.eligible_for_prize = true AND rm.entry_type = 'coins_battle')::text AS cb_wins");
    expect(titleEvaluation).toContain("COUNT(rr2.id) FILTER (WHERE rr2.eligible_for_prize = true AND rm.is_private = false");
    expect(titleEvaluation).toContain("COUNT(rr2.id) FILTER (WHERE rr2.eligible_for_prize = true AND rm.is_private = true)::text");
    expect(titleEvaluation).toContain("COUNT(rr2.id) FILTER (WHERE rm.type = 'sponsored' AND rr2.eligible_for_prize = true)::text AS sponsored_wins");
  });
});
