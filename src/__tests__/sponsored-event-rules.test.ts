import { describe, expect, it } from "vitest";
import {
  getSponsoredPrizePoolCents,
  getSponsoredWinnerCount,
  SPONSORED_EVENT_PRIZE_PER_WINNER_CENTS,
  SPONSORED_EVENT_TARGET_STEPS,
} from "../lib/sponsoredEventRules.js";

describe("sponsored event rules", () => {
  it("uses one winner for one or two players", () => {
    expect(getSponsoredWinnerCount(1)).toBe(1);
    expect(getSponsoredWinnerCount(2)).toBe(1);
  });

  it("uses two winners for three to ten players", () => {
    for (const playerCount of [3, 4, 5, 10]) {
      expect(getSponsoredWinnerCount(playerCount)).toBe(2);
    }
  });

  it("awards one $5 gift card per winner", () => {
    expect(SPONSORED_EVENT_PRIZE_PER_WINNER_CENTS).toBe(500);
    expect(getSponsoredPrizePoolCents(2)).toBe(500);
    expect(getSponsoredPrizePoolCents(3)).toBe(1000);
    expect(getSponsoredPrizePoolCents(10)).toBe(1000);
  });

  it("keeps sponsored event target steps at 10000", () => {
    expect(SPONSORED_EVENT_TARGET_STEPS).toBe(10000);
  });
});
