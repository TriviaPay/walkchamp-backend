import { describe, expect, it } from "vitest";
import {
  buildChallengeParticipationBreakdown,
  emptyChallengeParticipationBreakdown,
  fetchChallengeParticipationBreakdown,
} from "../lib/challengeParticipation.js";

describe("challenge participation breakdown", () => {
  it("returns counts, total, and percentages rounded to two decimals", () => {
    expect(buildChallengeParticipationBreakdown({
      free: 3,
      coins: 1,
      topFinishers: 2,
      sponsoredEvents: 1,
      streakChallenge: 2,
    })).toEqual({
      totalParticipatedChallenges: 9,
      byType: {
        free: { count: 3, percentage: 33.33 },
        coins: { count: 1, percentage: 11.11 },
        topFinishers: { count: 2, percentage: 22.22 },
        sponsoredEvents: { count: 1, percentage: 11.11 },
        streakChallenge: { count: 2, percentage: 22.22 },
      },
    });
  });

  it("returns a stable zero-valued shape when there is no participation", () => {
    expect(emptyChallengeParticipationBreakdown()).toEqual({
      totalParticipatedChallenges: 0,
      byType: {
        free: { count: 0, percentage: 0 },
        coins: { count: 0, percentage: 0 },
        topFinishers: { count: 0, percentage: 0 },
        sponsoredEvents: { count: 0, percentage: 0 },
        streakChallenge: { count: 0, percentage: 0 },
      },
    });
  });

  it("normalizes PostgreSQL string counts", async () => {
    const executor = {
      execute: async () => ({
        rows: [{
          free_count: "1",
          coins_count: "2",
          top_finishers_count: "3",
          sponsored_events_count: "4",
          streak_challenge_count: "5",
        }],
      }),
    };

    const result = await fetchChallengeParticipationBreakdown(executor, "walker-1");
    expect(result.totalParticipatedChallenges).toBe(15);
    expect(result.byType.streakChallenge.count).toBe(5);
  });

  it("does not query for configured admin/test accounts", async () => {
    const previous = process.env.PARTICIPATION_EXCLUDED_USER_IDS;
    process.env.PARTICIPATION_EXCLUDED_USER_IDS = "internal-1, internal-2";
    let called = false;

    try {
      const result = await fetchChallengeParticipationBreakdown({
        execute: async () => {
          called = true;
          return { rows: [] };
        },
      }, "internal-2");
      expect(result).toEqual(emptyChallengeParticipationBreakdown());
      expect(called).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PARTICIPATION_EXCLUDED_USER_IDS;
      else process.env.PARTICIPATION_EXCLUDED_USER_IDS = previous;
    }
  });
});
