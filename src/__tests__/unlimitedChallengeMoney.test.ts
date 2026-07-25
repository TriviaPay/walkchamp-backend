import { describe, expect, it } from "vitest";
import {
  computeTotalChargeCents,
  validateEntryFeeCents,
  validateDailyGoalSteps,
  isAllowedDuration,
  computeEqualSplit,
  UNLIMITED_PLATFORM_FEE_CENTS,
} from "../lib/unlimitedChallengeMoney.js";

describe("unlimited challenge money", () => {
  it("charges entry + fixed $0.50 platform fee", () => {
    expect(UNLIMITED_PLATFORM_FEE_CENTS).toBe(50);
    expect(computeTotalChargeCents(1000)).toBe(1050); // $10 entry -> $10.50
    expect(computeTotalChargeCents(100_000)).toBe(100_050); // $1000 entry -> $1000.50
  });

  it("validates the $10–$1000 entry bounds", () => {
    expect(validateEntryFeeCents(1000).ok).toBe(true);
    expect(validateEntryFeeCents(100_000).ok).toBe(true);
    expect(validateEntryFeeCents(999).ok).toBe(false); // below min
    expect(validateEntryFeeCents(100_001).ok).toBe(false); // above max
    expect(validateEntryFeeCents(10_050.5).ok).toBe(false); // non-integer cents
  });

  it("validates the 3,000–15,000 daily goal bounds", () => {
    expect(validateDailyGoalSteps(3000).ok).toBe(true);
    expect(validateDailyGoalSteps(10000).ok).toBe(true);
    expect(validateDailyGoalSteps(15000).ok).toBe(true);
    expect(validateDailyGoalSteps(2999).ok).toBe(false);
    expect(validateDailyGoalSteps(15001).ok).toBe(false);
  });

  it("only allows 7/10/30/60/90-day durations", () => {
    for (const d of [7, 10, 30, 60, 90]) expect(isAllowedDuration(d)).toBe(true);
    for (const d of [1, 5, 14, 45, 100]) expect(isAllowedDuration(d)).toBe(false);
  });
});

describe("computeEqualSplit", () => {
  it("returns no allocations when there are zero winners", () => {
    expect(computeEqualSplit(10_000, [])).toEqual([]);
  });

  it("gives a single winner the whole pool", () => {
    const out = computeEqualSplit(10_000, ["p1"]);
    expect(out).toEqual([{ participantId: "p1", payoutCents: 10_000 }]);
  });

  it("splits evenly when divisible", () => {
    const out = computeEqualSplit(9000, ["b", "a", "c"]);
    expect(out.map((o) => o.payoutCents)).toEqual([3000, 3000, 3000]);
  });

  it("distributes remainder cents deterministically to the first sorted winners", () => {
    // $100 / 3 = 33.33, 33.33, 33.34 -> remainder 1 cent to the first sorted id
    const out = computeEqualSplit(10_000, ["winnerB", "winnerA", "winnerC"]);
    // sorted: winnerA, winnerB, winnerC
    expect(out).toEqual([
      { participantId: "winnerA", payoutCents: 3334 },
      { participantId: "winnerB", payoutCents: 3333 },
      { participantId: "winnerC", payoutCents: 3333 },
    ]);
  });

  it("fully allocates the pool (sum of payouts === pool) for arbitrary sizes", () => {
    for (const [pool, n] of [[10_000, 3], [12_345, 7], [100_000, 9], [1, 4], [777, 13]] as const) {
      const ids = Array.from({ length: n }, (_, i) => `p${String(i).padStart(3, "0")}`);
      const out = computeEqualSplit(pool, ids);
      const total = out.reduce((s, o) => s + o.payoutCents, 0);
      expect(total).toBe(pool);
      // Payouts differ by at most 1 cent (equal split property).
      const max = Math.max(...out.map((o) => o.payoutCents));
      const min = Math.min(...out.map((o) => o.payoutCents));
      expect(max - min).toBeLessThanOrEqual(1);
    }
  });

  it("is independent of input order (ranking never affects payout)", () => {
    const a = computeEqualSplit(10_000, ["c", "a", "b"]);
    const b = computeEqualSplit(10_000, ["a", "b", "c"]);
    expect(a).toEqual(b);
  });
});
