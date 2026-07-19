import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("race win counters", () => {
  it("counts only eligible 1st place as race wins while keeping top-3 podium stats separate", () => {
    const leaderboardRoute = readFileSync("src/routes/leaderboard.ts", "utf8");
    const profileRoute = readFileSync("src/routes/profile.ts", "utf8");

    expect(leaderboardRoute).toContain("const RACE_WIN_RANK = 1");
    expect(leaderboardRoute).toContain("eq(raceResultsTable.rank, RACE_WIN_RANK)");
    expect(leaderboardRoute).toContain("eq(raceResultsTable.eligibleForPrize, true)");

    expect(profileRoute).toContain("function isRaceWinResult");
    expect(profileRoute).toContain("return r.rank === 1 && r.eligibleForPrize !== false");
    expect(profileRoute).toContain("function isRacePodiumRank");
    expect(profileRoute).toContain("racesWon     = allRaceRows.filter(isRaceWinResult).length");
    expect(profileRoute).toContain("racesWon:        raceRows.filter(isRaceWinResult).length");
    expect(profileRoute).toContain("raceWins:          raceRows.filter(isRaceWinResult).length");
    expect(profileRoute).toContain("top3Finishes = allRaceRows.filter((r) => isRacePodiumRank(r.rank)).length");
    expect(profileRoute).toContain("top3Finishes:    raceRows.filter((r) => isRacePodiumRank(r.rank)).length");
  });

  it("aligns title race-win metrics with eligible first-place wins and podiums with top-3", () => {
    const titleEvaluation = readFileSync("src/lib/titleEvaluation.ts", "utf8");

    expect(titleEvaluation).toContain("COUNT(rr2.id) FILTER (WHERE rr2.rank = 1 AND rr2.eligible_for_prize = true)::text AS wins");
    expect(titleEvaluation).toContain("COUNT(rr2.id) FILTER (WHERE rr2.rank <= 3)::text                               AS podiums");
    expect(titleEvaluation).toContain("COUNT(rr2.id) FILTER (WHERE rr2.rank = 1 AND rr2.eligible_for_prize = true AND rm.entry_type = 'free')::text AS free_wins");
    expect(titleEvaluation).toContain("COUNT(rr2.id) FILTER (WHERE rr2.rank = 1 AND rr2.eligible_for_prize = true AND rm.entry_type = 'coins_battle')::text AS cb_wins");
    expect(titleEvaluation).toContain("COUNT(rr2.id) FILTER (WHERE rr2.rank = 1 AND rr2.eligible_for_prize = true AND rm.is_private = false");
    expect(titleEvaluation).toContain("COUNT(rr2.id) FILTER (WHERE rr2.rank = 1 AND rr2.eligible_for_prize = true AND rm.is_private = true)::text");
    expect(titleEvaluation).toContain("COUNT(rr2.id) FILTER (WHERE rm.type = 'sponsored' AND rr2.eligible_for_prize = true)::text AS sponsored_wins");
  });
});
