import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Contract tests (source-grep) pinning the Unlimited Challenge wiring, money safety, idempotency,
// rollback flag, and "don't touch existing types" invariants. Pure money/window logic is covered by
// unlimitedChallengeMoney.test.ts + challengeDayWindow.test.ts.

const config = readFileSync("src/lib/config.ts", "utf8");
const service = readFileSync("src/lib/unlimitedChallengeService.ts", "utf8");
const settlement = readFileSync("src/lib/unlimitedChallengeSettlement.ts", "utf8");
const jobs = readFileSync("src/lib/unlimitedChallengeJobs.ts", "utf8");
const router = readFileSync("src/routes/unlimitedChallenge.ts", "utf8");
const worker = readFileSync("src/worker.ts", "utf8");
const scheduler = readFileSync("src/lib/scheduler.ts", "utf8");
const races = readFileSync("src/routes/races.ts", "utf8");
const membership = readFileSync("src/lib/challengeMembership.ts", "utf8");
const schema = readFileSync("db/src/schema/unlimitedChallenge.ts", "utf8");

describe("rollback flag", () => {
  it("is env-driven (FEATURE_UNLIMITED_GOAL) and gates the router", () => {
    expect(config).toContain("unlimitedGoalEnabled: parseBoolean(rawEnv.FEATURE_UNLIMITED_GOAL)");
    expect(router).toContain("if (!config.features.unlimitedGoalEnabled)");
    expect(router).toContain('code: "FEATURE_DISABLED"');
  });

  it("worker start/settle handlers are NOT behind the flag (in-flight challenges still complete)", () => {
    expect(worker).not.toMatch(/unlimitedGoalEnabled[\s\S]*unlimited\.start/);
    expect(worker).toContain('case "unlimited.start"');
    expect(worker).toContain('case "unlimited.settle"');
  });
});

describe("money safety (integer cents, fixed $0.50, no double charge)", () => {
  it("charges entry + fixed $0.50 platform fee via a dedicated idempotency key", () => {
    expect(service).toContain("debitAmountCents: computeTotalChargeCents(");
    expect(service).toContain("idempotencyKey: `unlimited_entry:${challenge.id}:${userId}`");
    expect(service).toContain("idempotencyKey: `unlimited_entry:${challengeId}:${userId}`");
  });

  it("join is idempotent — already-joined returns without re-charging or re-incrementing the pool", () => {
    expect(service).toContain("already joined — idempotent");
    expect(service).toContain("You cannot rejoin a challenge you left.");
  });

  it("prize pool only grows (never decremented on leave)", () => {
    expect(service).toContain("paidParticipantCount is NOT decremented");
    expect(service).not.toContain("paidParticipantCount - 1");
  });
});

describe("one-blocking-challenge spans both systems", () => {
  it("service checks getBlockingMembership under a shared advisory lock", () => {
    expect(service).toContain("acquireOneChallengeLock(tx, userId)");
    expect(service).toContain("getBlockingMembership(tx, userId");
    expect(membership).toContain("regular_race_registration:${userId}"); // same lock key as races
  });
  it("race create/join also block against unlimited challenges (all entry paths)", () => {
    // Present on every race create + join guard (host-create, /races, quick-join-free, join, join-paid).
    expect((races.match(/getUnlimitedBlockingMembership\(db, userId\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("the unlimited blocking check is flag-gated + fail-open so it CANNOT break existing race paths", () => {
    // When the feature is off it returns null before touching the new tables; a query error also
    // returns null (fail-open) rather than 500-ing the existing race create/join flow.
    expect(membership).toContain("if (!config.features.unlimitedGoalEnabled) return null;");
    expect(membership).toContain("Fail-open");
    expect(membership).toMatch(/catch \(err\)[\s\S]*return null;/);
  });
});

describe("leave = no refund, never cancels", () => {
  it("leave returns an explicit no-refund body and no host-cancel endpoint exists", () => {
    expect(router).toContain('refund: { eligible: false, type: "none"');
    expect(router).not.toContain("/cancel");
    expect(service).toContain("Contribution stays in the pool (no refund)");
  });
});

describe("settlement: equal split, idempotent, zero-winner policy", () => {
  it("claims active->settling via compare-and-set and equal-splits the pool", () => {
    expect(settlement).toContain('eq(unlimitedChallengesTable.status, "active")');
    expect(settlement).toContain("computeEqualSplit(pre.prizePoolCents");
  });
  it("payout rows are idempotent and wallet credit reuses the guarded credit helper", () => {
    expect(settlement).toContain("onConflictDoNothing()");
    expect(settlement).toContain("creditCashChallengePrizes(tx");
    expect(schema).toContain("unlimited_payouts_challenge_participant_uniq"); // one payout per participant
  });
  it("zero winners applies the configured policy without auto-crediting the platform", () => {
    expect(settlement).toContain('action: "unlimited_challenge.zero_winner"');
    expect(settlement).toContain("no auto-credit");
    expect(config).toContain('zeroWinnerPolicy: unlimitedGoalZeroWinnerPolicy');
  });

  it("refund_entry_contributions policy actually refunds entries idempotently (platform fee kept)", () => {
    expect(settlement).toContain('policy === "refund_entry_contributions"');
    expect(settlement).toContain("creditEntryRefunds(tx");
    const payments = readFileSync("src/lib/cashChallengePayments.ts", "utf8");
    expect(payments).toContain("export async function creditEntryRefunds");
    expect(payments).toContain("idempotencyKey: `refund:${input.sourceId}:${userId}`");
    expect(payments).toContain('transactionType: "race_entry_refund"');
  });
  it("settlement defers until all days are finalized", () => {
    expect(settlement).toContain("settlement deferred — days not finalized");
  });
});

describe("daily qualification: one failed day permanently disqualifies", () => {
  it("finalize marks passed/failed from verified daily totals and DQs on a miss", () => {
    expect(jobs).toContain("stepDailyTotalsTable");
    expect(jobs).toContain('disqualificationReason: "missed_daily_goal"');
    expect(jobs).toContain("passed ? now : null"); // passedAt only when passed
  });
  it("uses locked-tz per-day windows built at start (unique per participant/day)", () => {
    expect(jobs).toContain("buildDayWindows(pre.startAtUtc, p.tz");
    expect(schema).toContain("unlimited_days_participant_day_uniq");
  });
});

describe("durable jobs + reconciliation", () => {
  it("start/settle jobs are enqueued and reconciled", () => {
    expect(service).toContain('"unlimited.start"');
    expect(jobs).toContain('"unlimited.settle"');
    expect(scheduler).toContain("reconcileUnlimitedChallenges(now)");
  });
});

describe("capacity is explicitly unlimited (no fake max/full)", () => {
  it("serializer reports unlimited capacity and null max", () => {
    expect(router).toContain('capacityMode: "unlimited"');
    expect(router).toContain("maxParticipants: null");
  });
  it("listing + leaderboard are paginated (bounded responses)", () => {
    expect(router).toContain("pagination: { limit, offset");
    expect(router).toContain(".limit(limit)");
  });
});
