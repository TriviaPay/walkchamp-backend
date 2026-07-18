import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("race win counters", () => {
  it("counts 1st, 2nd, and 3rd place as race wins in leaderboard and profile stats", () => {
    const leaderboardRoute = readFileSync("src/routes/leaderboard.ts", "utf8");
    const profileRoute = readFileSync("src/routes/profile.ts", "utf8");

    expect(leaderboardRoute).toContain("const RACE_WIN_MAX_RANK = 3");
    expect(leaderboardRoute).toContain("lte(raceResultsTable.rank, RACE_WIN_MAX_RANK)");
    expect(leaderboardRoute).not.toContain("eq(raceResultsTable.rank, 1)");

    expect(profileRoute).toContain("function isRaceWinRank");
    expect(profileRoute).toContain("racesWon     = allRaceRows.filter((r) => isRaceWinRank(r.rank)).length");
    expect(profileRoute).toContain("racesWon:        raceRows.filter((r) => isRaceWinRank(r.rank)).length");
    expect(profileRoute).toContain("raceWins:          raceRows.filter((r) => isRaceWinRank(r.rank)).length");
  });

  it("aligns title race-win metrics with the top-3 win definition", () => {
    const titleEvaluation = readFileSync("src/lib/titleEvaluation.ts", "utf8");

    expect(titleEvaluation).toContain("COUNT(rr2.id) FILTER (WHERE rr2.rank <= 3)::text                               AS wins");
    expect(titleEvaluation).toContain("COUNT(rr2.id) FILTER (WHERE rr2.rank <= 3 AND rm.entry_type = 'free')::text    AS free_wins");
    expect(titleEvaluation).toContain("COUNT(rr2.id) FILTER (WHERE rr2.rank <= 3 AND rm.entry_type = 'coins_battle')::text AS cb_wins");
    expect(titleEvaluation).toContain("COUNT(rr2.id) FILTER (WHERE rr2.rank <= 3 AND rm.is_private = false");
    expect(titleEvaluation).toContain("COUNT(rr2.id) FILTER (WHERE rr2.rank <= 3 AND rm.is_private = true)::text");
  });
});
