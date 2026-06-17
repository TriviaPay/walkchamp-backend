import { db } from "@db";
import {
  coinBalancesTable,
  coinTransactionsTable,
  dailyCoinRewardsTable,
} from "@db/schema";
import { eq, sql } from "drizzle-orm";
import { triggerEvent } from "./pusher";
import { logger } from "./logger";

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
    const [updated] = await tx
      .insert(coinBalancesTable)
      .values({ userId, currentBalance: amount, lifetimeEarned: amount, lifetimeSpent: 0 })
      .onConflictDoUpdate({
        target: [coinBalancesTable.userId],
        set: {
          currentBalance: sql`${coinBalancesTable.currentBalance} + ${amount}`,
          lifetimeEarned: sql`${coinBalancesTable.lifetimeEarned} + ${amount}`,
          updatedAt: new Date(),
        },
      })
      .returning({ currentBalance: coinBalancesTable.currentBalance });

    newBalance = updated?.currentBalance ?? amount;

    await tx.insert(coinTransactionsTable).values({
      userId,
      amount,
      transactionType: "earn",
      source,
      sourceId: sourceId ?? null,
      rewardCode,
      description,
    });
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

    await tx
      .update(coinBalancesTable)
      .set({
        currentBalance: sql`${coinBalancesTable.currentBalance} - ${amount}`,
        lifetimeSpent: sql`${coinBalancesTable.lifetimeSpent} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(coinBalancesTable.userId, userId));

    await tx.insert(coinTransactionsTable).values({
      userId,
      amount: -amount,
      transactionType: "spend",
      source,
      sourceId: sourceId ?? null,
      rewardCode: null,
      description,
    });

    const [updated] = await tx
      .select({ currentBalance: coinBalancesTable.currentBalance })
      .from(coinBalancesTable)
      .where(eq(coinBalancesTable.userId, userId))
      .limit(1);

    return { success: true, newBalance: updated?.currentBalance ?? current - amount };
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
