import { db } from "@db";
import {
  adRewardClaimsTable,
  coinBalancesTable,
  coinTransactionsTable,
  dailyCoinRewardsTable,
} from "@db/schema";
import { and, eq, sql } from "drizzle-orm";
import { triggerEvent } from "./pusher";
import { logger } from "./logger";
import { writeAuditLog } from "./auditLog";

// ── Ensure a balance row exists for the user ──────────────────────────────────
export async function ensureCoinBalance(userId: string): Promise<void> {
  await db
    .insert(coinBalancesTable)
    .values({ userId, currentBalance: 0, lifetimeEarned: 0, lifetimeSpent: 0 })
    .onConflictDoNothing();
}

// ── Get current balance ───────────────────────────────────────────────────────
export async function getCoinBalance(
  userId: string,
): Promise<{ currentBalance: number; lifetimeEarned: number; lifetimeSpent: number }> {
  await ensureCoinBalance(userId);
  const [row] = await db
    .select()
    .from(coinBalancesTable)
    .where(eq(coinBalancesTable.userId, userId))
    .limit(1);
  return {
    currentBalance: row?.currentBalance ?? 0,
    lifetimeEarned: row?.lifetimeEarned ?? 0,
    lifetimeSpent: row?.lifetimeSpent ?? 0,
  };
}

export async function recomputeCoinProjection(userId: string): Promise<number> {
  const [totals] = await db
    .select({
      currentBalance: sql<number>`coalesce(sum(${coinTransactionsTable.amount}), 0)`,
      lifetimeEarned: sql<number>`coalesce(sum(case when ${coinTransactionsTable.amount} > 0 then ${coinTransactionsTable.amount} else 0 end), 0)`,
      lifetimeSpent: sql<number>`coalesce(sum(case when ${coinTransactionsTable.amount} < 0 then abs(${coinTransactionsTable.amount}) else 0 end), 0)`,
    })
    .from(coinTransactionsTable)
    .where(eq(coinTransactionsTable.userId, userId));

  const currentBalance = Number(totals?.currentBalance ?? 0);
  const lifetimeEarned = Number(totals?.lifetimeEarned ?? 0);
  const lifetimeSpent = Number(totals?.lifetimeSpent ?? 0);

  await db
    .insert(coinBalancesTable)
    .values({
      userId,
      currentBalance,
      lifetimeEarned,
      lifetimeSpent,
    })
    .onConflictDoUpdate({
      target: coinBalancesTable.userId,
      set: {
        currentBalance,
        lifetimeEarned,
        lifetimeSpent,
        updatedAt: new Date(),
      },
    });

  return currentBalance;
}

type CoinLedgerEntry = {
  userId: string;
  amount: number;
  transactionType: "earn" | "spend" | "refund" | "adjustment";
  source: string;
  sourceId?: string | null;
  rewardCode?: string | null;
  reasonCode: string;
  idempotencyKey: string;
  description: string;
  metadata?: Record<string, unknown> | null;
};

export async function recordCoinLedgerEntry(
  tx: any,
  entry: CoinLedgerEntry,
): Promise<{ applied: boolean; newBalance: number }> {
  const [existing] = await tx
    .select({
      id: coinTransactionsTable.id,
      balanceAfter: coinTransactionsTable.balanceAfter,
    })
    .from(coinTransactionsTable)
    .where(and(
      eq(coinTransactionsTable.userId, entry.userId),
      eq(coinTransactionsTable.idempotencyKey, entry.idempotencyKey),
    ))
    .limit(1);

  if (existing) {
    return {
      applied: false,
      newBalance: existing.balanceAfter ?? 0,
    };
  }

  await tx
    .insert(coinBalancesTable)
    .values({ userId: entry.userId, currentBalance: 0, lifetimeEarned: 0, lifetimeSpent: 0 })
    .onConflictDoNothing();

  const [balanceRow] = await tx
    .select({
      currentBalance: coinBalancesTable.currentBalance,
      lifetimeEarned: coinBalancesTable.lifetimeEarned,
      lifetimeSpent: coinBalancesTable.lifetimeSpent,
    })
    .from(coinBalancesTable)
    .where(eq(coinBalancesTable.userId, entry.userId))
    .limit(1);

  const currentBalance = balanceRow?.currentBalance ?? 0;
  if (entry.amount < 0 && currentBalance + entry.amount < 0) {
    throw new Error("NEGATIVE_COIN_BALANCE");
  }

  const newBalance = currentBalance + entry.amount;
  const earnedDelta = entry.amount > 0 ? entry.amount : 0;
  const spentDelta = entry.amount < 0 ? Math.abs(entry.amount) : 0;

  await tx.insert(coinTransactionsTable).values({
    userId: entry.userId,
    amount: entry.amount,
    transactionType: entry.transactionType,
    source: entry.source,
    sourceId: entry.sourceId ?? null,
    rewardCode: entry.rewardCode ?? null,
    reasonCode: entry.reasonCode,
    idempotencyKey: entry.idempotencyKey,
    description: entry.description,
    balanceAfter: newBalance,
    metadata: entry.metadata ?? null,
  });

  await tx
    .update(coinBalancesTable)
    .set({
      currentBalance: newBalance,
      lifetimeEarned: sql`${coinBalancesTable.lifetimeEarned} + ${earnedDelta}`,
      lifetimeSpent: sql`${coinBalancesTable.lifetimeSpent} + ${spentDelta}`,
      updatedAt: new Date(),
    })
    .where(eq(coinBalancesTable.userId, entry.userId));

  return { applied: true, newBalance };
}

// ── Award coins — idempotent by (userId, rewardDate, rewardCode) ──────────────
// Returns coins actually awarded (0 if already awarded / duplicate).
export async function awardCoins(opts: {
  userId: string;
  amount: number;
  source: string;
  sourceId?: string;
  rewardCode: string;
  description: string;
  date: string; // YYYY-MM-DD
  reasonCode?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}): Promise<number> {
  const { userId, amount, source, sourceId, rewardCode, description, date } = opts;

  // Insert into daily_coin_rewards — unique(userId, rewardDate, rewardCode)
  // ON CONFLICT DO NOTHING = idempotent
  const inserted = await db
    .insert(dailyCoinRewardsTable)
    .values({ userId, rewardDate: date, rewardCode, coinsAwarded: amount })
    .onConflictDoNothing()
    .returning({ id: dailyCoinRewardsTable.id });

  if (inserted.length === 0) return 0; // duplicate — already awarded

  // Actually credit the coins
  let newBalance = amount;
  await db.transaction(async (tx) => {
    const result = await recordCoinLedgerEntry(tx, {
      userId,
      amount,
      transactionType: "earn",
      source,
      sourceId: sourceId ?? null,
      rewardCode,
      reasonCode: opts.reasonCode ?? rewardCode.toLowerCase(),
      idempotencyKey: opts.idempotencyKey ?? `daily:${userId}:${date}:${rewardCode}`,
      description,
      metadata: opts.metadata ?? null,
    });

    newBalance = result.newBalance;
  });

  // Notify the user in real-time so all screens refresh their balance immediately
  void triggerEvent(`private-user-${userId}`, "wallet.updated", {
    type: "coins_earned",
    reason: rewardCode,
    coins: amount,
    changeAmount: amount,
    coinBalance: newBalance,
    description,
  }).catch(() => {});

  logger.info({ userId, rewardCode, amount, newBalance }, "[CoinTasks] credit reward");
  return amount;
}

// ── Spend coins (for theme purchases etc.) ────────────────────────────────────
export async function spendCoins(opts: {
  userId: string;
  amount: number;
  source: string;
  sourceId?: string;
  description: string;
  reasonCode?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ success: boolean; newBalance: number; coinsNeeded?: number }> {
  const { userId, amount, source, sourceId, description } = opts;

  await ensureCoinBalance(userId);

  const result = await db.transaction(async (tx) => {
    const [bal] = await tx
      .select({ currentBalance: coinBalancesTable.currentBalance })
      .from(coinBalancesTable)
      .where(eq(coinBalancesTable.userId, userId))
      .limit(1);

    const current = bal?.currentBalance ?? 0;
    if (current < amount) {
      return { success: false, newBalance: current, coinsNeeded: amount - current };
    }

    const ledger = await recordCoinLedgerEntry(tx, {
      userId,
      amount: -amount,
      transactionType: "spend",
      source,
      sourceId: sourceId ?? null,
      rewardCode: null,
      reasonCode: opts.reasonCode ?? source,
      idempotencyKey: opts.idempotencyKey ?? `spend:${userId}:${source}:${sourceId ?? amount}:${amount}`,
      description,
      metadata: opts.metadata ?? null,
    });
    return { success: true, newBalance: ledger.newBalance };
  });

  // Notify the user in real-time so all screens refresh their balance immediately
  if (result.success) {
    void triggerEvent(`private-user-${userId}`, "wallet.updated", {
      type: "coins_spent",
      reason: source,
      coins: amount,
      changeAmount: -amount,
      coinBalance: result.newBalance,
      description,
    }).catch(() => {});
    logger.info({ userId, source, amount, newBalance: result.newBalance }, "[Coins] spendCoins: debited");
  }

  return result;
}

export async function recordAdRewardClaim(opts: {
  userId: string;
  claimId: string;
  date: string;
  network?: string;
  placement?: string;
}): Promise<boolean> {
  const inserted = await db
    .insert(adRewardClaimsTable)
    .values({
      userId: opts.userId,
      claimId: opts.claimId,
      rewardDate: opts.date,
      network: opts.network ?? null,
      placement: opts.placement ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: adRewardClaimsTable.id });

  return inserted.length > 0;
}

export async function auditManualCoinChange(opts: {
  actorUserId?: string | null;
  targetUserId: string;
  amount: number;
  reason: string;
  sourceId?: string | null;
}) {
  await writeAuditLog({
    actorUserId: opts.actorUserId ?? null,
    actorType: "admin",
    action: "coin.manual_adjustment",
    entityType: "user",
    entityId: opts.targetUserId,
    reason: opts.reason,
    metadata: {
      amount: opts.amount,
      sourceId: opts.sourceId ?? null,
    },
  });
}

// ── Evaluate and award step milestone coins ───────────────────────────────────
// Call this after step sync. Fire-and-forget safe. Fully idempotent.
// dailyGoal defaults to 10000 until per-user goal configuration is added.
export async function evaluateStepMilestones(
  userId: string,
  totalStepsToday: number,
  date: string, // YYYY-MM-DD
  dailyGoal = 10000,
): Promise<Array<{ rewardCode: string; coins: number; description: string }>> {
  const pct = totalStepsToday / dailyGoal;

  type Milestone = { code: string; coins: number; desc: string; source: string } & (
    | { pct: number; minSteps?: never }
    | { minSteps: number; pct?: never }
  );

  // Each milestone maps to exactly one task in earn-tasks — no overlapping thresholds.
  // steps_5k and steps_10k are removed: they duplicated daily_goal_50 and daily_goal_100
  // for a user whose goal is 10,000 steps.
  const milestones: Milestone[] = [
    { code: `daily_walk_${date}`,      minSteps: 1,     coins: 1,  desc: "Walked today",             source: "coin_task" },
    { code: `daily_goal_25_${date}`,   pct: 0.25,       coins: 2,  desc: "Reached 25% of daily goal", source: "coin_task" },
    { code: `daily_goal_50_${date}`,   pct: 0.50,       coins: 3,  desc: "Reached 50% of daily goal", source: "coin_task" },
    { code: `daily_goal_75_${date}`,   pct: 0.75,       coins: 5,  desc: "Reached 75% of daily goal", source: "coin_task" },
    { code: `daily_goal_100_${date}`,  pct: 1.00,       coins: 15, desc: "Completed daily goal!",      source: "coin_task" },
    { code: `steps_20k_${date}`,       minSteps: 20000, coins: 40, desc: "Walked 20,000 steps!",       source: "coin_task" },
  ];

  const awarded: Array<{ rewardCode: string; coins: number; description: string }> = [];

  for (const m of milestones) {
    const achieved = m.pct != null ? pct >= m.pct : totalStepsToday >= m.minSteps!;
    if (!achieved) continue;

    const coins = await awardCoins({
      userId,
      amount: m.coins,
      source: m.source,
      rewardCode: m.code,
      description: m.desc,
      date,
    });

    if (coins > 0) {
      awarded.push({ rewardCode: m.code, coins, description: m.desc });
      logger.info({ userId, rewardCode: m.code, coins }, "[CoinTasks] task completed");
    } else {
      logger.info({ userId, rewardCode: m.code }, "[CoinTasks] reward already claimed");
    }
  }

  return awarded;
}
