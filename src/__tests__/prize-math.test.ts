/**
 * Pure unit tests for prize distribution math.
 * These functions are duplicated from races.ts to allow isolated testing.
 * Any change to the originals must be reflected here.
 */
import { describe, it, expect } from "vitest";

const PLATFORM_FEE_PERCENT = 20;
const WINNER_REWARD_PERCENT = 100 - PLATFORM_FEE_PERCENT;

function calcPrizePool(entryAmountCents: number, playerCount: number) {
  const total = entryAmountCents * playerCount;
  const platformFee = Math.round((total * PLATFORM_FEE_PERCENT) / 100);
  const winners = total - platformFee;
  return { total, platformFee, winners };
}

function numWinners(playerCount: number): number {
  if (playerCount <= 2) return 1;
  if (playerCount === 3) return 2;
  return 3;
}

function getPrizeSplits(playerCount: number): number[] {
  const w = numWinners(playerCount);
  if (w === 1) return [1.0];
  if (w === 2) return [0.6, 0.4];
  return [0.5, 0.3, 0.2];
}

function buildRewardSplitCents(
  entryAmountCents: number,
  playerCount: number,
): Array<{ rank: number; amountCents: number }> {
  if (entryAmountCents === 0 || playerCount < 2) return [];
  const { winners: winnersPoolCents } = calcPrizePool(entryAmountCents, playerCount);
  const splits = getPrizeSplits(playerCount);
  const slots = splits.map((s, i) => ({
    rank: i + 1,
    amountCents: Math.floor(winnersPoolCents * s),
  }));
  const distributed = slots.reduce((sum, s) => sum + s.amountCents, 0);
  if (slots.length > 0) slots[0].amountCents += winnersPoolCents - distributed;
  return slots;
}

// ── calcPrizePool ─────────────────────────────────────────────────────────────
describe("calcPrizePool", () => {
  it("takes 20% platform fee from total pot", () => {
    const { total, platformFee, winners } = calcPrizePool(100, 4);
    expect(total).toBe(400);
    expect(platformFee).toBe(80);
    expect(winners).toBe(320);
  });

  it("platform fee + winners pool equals total", () => {
    for (const players of [2, 3, 4, 5, 10]) {
      const { total, platformFee, winners } = calcPrizePool(300, players);
      expect(platformFee + winners).toBe(total);
    }
  });

  it("free race returns zero pool", () => {
    const { total, platformFee, winners } = calcPrizePool(0, 4);
    expect(total).toBe(0);
    expect(platformFee).toBe(0);
    expect(winners).toBe(0);
  });

  it("$1 race with 2 players", () => {
    const { total, platformFee, winners } = calcPrizePool(100, 2);
    expect(total).toBe(200);
    expect(platformFee).toBe(40);
    expect(winners).toBe(160);
  });

  it("$5 race with 10 players yields large pool", () => {
    const { total } = calcPrizePool(500, 10);
    expect(total).toBe(5000);
  });
});

// ── numWinners ────────────────────────────────────────────────────────────────
describe("numWinners", () => {
  it("2 players → 1 winner", () => expect(numWinners(2)).toBe(1));
  it("3 players → 2 winners", () => expect(numWinners(3)).toBe(2));
  it("4 players → 3 winners", () => expect(numWinners(4)).toBe(3));
  it("10 players → 3 winners", () => expect(numWinners(10)).toBe(3));
  it("1 player (edge) → 1 winner", () => expect(numWinners(1)).toBe(1));
});

// ── getPrizeSplits ────────────────────────────────────────────────────────────
describe("getPrizeSplits", () => {
  it("2-player race: 1 winner takes all (100%)", () => {
    const splits = getPrizeSplits(2);
    expect(splits).toEqual([1.0]);
    expect(splits.reduce((a, b) => a + b, 0)).toBeCloseTo(1.0);
  });

  it("3-player race: 60/40 split", () => {
    const splits = getPrizeSplits(3);
    expect(splits).toEqual([0.6, 0.4]);
    expect(splits.reduce((a, b) => a + b, 0)).toBeCloseTo(1.0);
  });

  it("4+ player race: 50/30/20 split", () => {
    const splits = getPrizeSplits(4);
    expect(splits).toEqual([0.5, 0.3, 0.2]);
    expect(splits.reduce((a, b) => a + b, 0)).toBeCloseTo(1.0);
  });

  it("splits always sum to 1.0", () => {
    for (const players of [2, 3, 4, 5, 8, 10]) {
      const splits = getPrizeSplits(players);
      expect(splits.reduce((a, b) => a + b, 0)).toBeCloseTo(1.0);
    }
  });
});

// ── buildRewardSplitCents ─────────────────────────────────────────────────────
describe("buildRewardSplitCents", () => {
  it("free race returns empty slots", () => {
    expect(buildRewardSplitCents(0, 4)).toEqual([]);
  });

  it("single-player returns empty slots", () => {
    expect(buildRewardSplitCents(100, 1)).toEqual([]);
  });

  it("slots sum equals winners pool (no cents lost)", () => {
    const { winners } = calcPrizePool(300, 4);
    const slots = buildRewardSplitCents(300, 4);
    const distributed = slots.reduce((sum, s) => sum + s.amountCents, 0);
    expect(distributed).toBe(winners);
  });

  it("rank-1 slot absorbs rounding remainder", () => {
    // 3-player $3 race: pool=900, fee=180, winners=720 → 720*0.6=432, 720*0.4=288 → exact
    const slots = buildRewardSplitCents(300, 3);
    expect(slots[0].rank).toBe(1);
    expect(slots[0].amountCents).toBeGreaterThanOrEqual(slots[1].amountCents);
  });

  it("no negative prizes", () => {
    for (const [entry, players] of [[100, 2], [300, 3], [500, 4], [100, 10]] as const) {
      const slots = buildRewardSplitCents(entry, players);
      for (const s of slots) {
        expect(s.amountCents).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("$1 race 2 players: winner gets 160 cents (80% of $2)", () => {
    const slots = buildRewardSplitCents(100, 2);
    expect(slots.length).toBe(1);
    expect(slots[0].rank).toBe(1);
    expect(slots[0].amountCents).toBe(160);
  });
});

// ── simulation disqualification guard ────────────────────────────────────────
describe("simulation disqualification guard", () => {
  type ResultRow = {
    userId: string;
    eligibleForPrize: boolean;
    status: string;
    prizeCents: number;
  };

  function applySimGuard(
    rows: ResultRow[],
    simulatedUserIds: Set<string>,
  ): ResultRow[] {
    return rows.map((r) =>
      simulatedUserIds.has(r.userId)
        ? { ...r, prizeCents: 0, eligibleForPrize: false, status: "disqualified_simulation" }
        : r,
    );
  }

  it("does not affect free-race results", () => {
    const rows: ResultRow[] = [
      { userId: "u1", eligibleForPrize: true, status: "pending_verification", prizeCents: 0 },
    ];
    const result = applySimGuard(rows, new Set(["u1"]));
    // Even if disqualified by guard, free races would have prizeCents=0 anyway
    expect(result[0].prizeCents).toBe(0);
  });

  it("zeroes out prize for simulated user in paid race", () => {
    const rows: ResultRow[] = [
      { userId: "u1", eligibleForPrize: true, status: "pending_verification", prizeCents: 500 },
      { userId: "u2", eligibleForPrize: true, status: "pending_verification", prizeCents: 300 },
    ];
    const result = applySimGuard(rows, new Set(["u1"]));
    expect(result[0].prizeCents).toBe(0);
    expect(result[0].eligibleForPrize).toBe(false);
    expect(result[0].status).toBe("disqualified_simulation");
    expect(result[1].prizeCents).toBe(300);
    expect(result[1].eligibleForPrize).toBe(true);
  });

  it("leaves real users unaffected when none are simulated", () => {
    const rows: ResultRow[] = [
      { userId: "u1", eligibleForPrize: true, status: "pending_verification", prizeCents: 500 },
      { userId: "u2", eligibleForPrize: true, status: "pending_verification", prizeCents: 300 },
    ];
    const result = applySimGuard(rows, new Set());
    expect(result).toEqual(rows);
  });

  it("handles all users simulated", () => {
    const rows: ResultRow[] = [
      { userId: "u1", eligibleForPrize: true, status: "pending_verification", prizeCents: 500 },
      { userId: "u2", eligibleForPrize: true, status: "pending_verification", prizeCents: 300 },
    ];
    const result = applySimGuard(rows, new Set(["u1", "u2"]));
    expect(result.every((r) => r.prizeCents === 0)).toBe(true);
    expect(result.every((r) => r.status === "disqualified_simulation")).toBe(true);
  });
});
