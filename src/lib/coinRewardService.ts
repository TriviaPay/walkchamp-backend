import { db } from "../../db/src/index.js";
import { coinRewardGrantsTable } from "../../db/src/schema/index.js";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger.js";
import { triggerEvent } from "./pusher.js";
import { evaluateUserTitles } from "./titleEvaluation.js";
import { recordCoinLedgerEntry } from "./coinsService.js";

// ── Grant a variable-amount coin reward (idempotent by rewardCode + sourceId) ──
// Use for coins_battle prizes where amounts vary per race.
export async function grantVariableCoinReward(opts: {
  userId: string;
  amount: number;
  rewardCode: string;
  sourceId: string;
  description: string;
}): Promise<number | null> {
  const { userId, amount, rewardCode, sourceId, description } = opts;
  if (amount <= 0) return null;

  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: coinRewardGrantsTable.id })
        .from(coinRewardGrantsTable)
        .where(
          and(
            eq(coinRewardGrantsTable.userId, userId),
            eq(coinRewardGrantsTable.rewardCode, rewardCode),
            eq(coinRewardGrantsTable.sourceId, sourceId),
          ),
        )
        .limit(1);

      if (existing) {
        logger.debug({ userId, rewardCode, sourceId }, "grantVariableCoinReward: duplicate skipped");
        return null;
      }

      await tx.insert(coinRewardGrantsTable).values({ userId, rewardCode, sourceId, coinsAwarded: amount });

      const { newBalance } = await recordCoinLedgerEntry(tx, {
        userId,
        amount,
        transactionType: "earn",
        source: "coins_battle",
        sourceId,
        rewardCode,
        reasonCode: rewardCode.toLowerCase(),
        idempotencyKey: `coins-battle:${userId}:${rewardCode}:${sourceId}`,
        description,
        metadata: { rewardType: "coins_battle" },
      });
      logger.info({ userId, rewardCode, sourceId, amount, newBalance }, "grantVariableCoinReward: granted");

      void triggerEvent(`private-user-${userId}`, "wallet.updated", {
        type: "coins_battle_win",
        reason: "coins_battle_reward",
        coins: amount,
        changeAmount: amount,
        coinBalance: newBalance,
        raceId: sourceId,
        description,
        rewardCode,
      }).catch(() => {});

      return amount;
    });
  } catch (err) {
    logger.error({ userId, rewardCode, sourceId, amount, err }, "grantVariableCoinReward: failed");
    return null;
  }
}

// ── Reward amounts by code ─────────────────────────────────────────────────────
export const REWARD_AMOUNTS: Record<string, number> = {
  FREE_RACE_WIN_1:        50,
  FREE_RACE_WIN_2:        30,
  FREE_RACE_WIN_3:        20,
  PAID_1_RACE_WIN_1:     100,
  PAID_1_RACE_WIN_2:      60,
  PAID_1_RACE_WIN_3:      40,
  PAID_3_RACE_WIN_1:     300,
  PAID_3_RACE_WIN_2:     180,
  PAID_3_RACE_WIN_3:     120,
  PAID_5_RACE_WIN_1:     500,
  PAID_5_RACE_WIN_2:     300,
  PAID_5_RACE_WIN_3:     200,
  PUBLIC_ROOM_WIN:        50,
  PRIVATE_ROOM_WIN:       50,
  FRIEND_ACCEPT:           5,
  SPECTATE_MATCH:          2,
};

// ── Resolve race-win reward code ───────────────────────────────────────────────
export function getRaceWinRewardCode(entryType: string, rank: number, targetSteps: number): string | null {
  if (rank > 3) return null;
  if (targetSteps < 1000) return null; // coins only for 1k+ goal races
  const tier =
    entryType === "free"   ? "FREE"   :
    entryType === "paid_1" ? "PAID_1" :
    entryType === "paid_3" ? "PAID_3" :
    entryType === "paid_5" ? "PAID_5" : null;
  if (!tier) return null;
  return `${tier}_RACE_WIN_${rank}`;
}

// ── Central reward-granting function ──────────────────────────────────────────
// Idempotent: (userId, rewardCode, sourceId) is unique. Returns coins granted,
// or null if already granted / unknown code / error.
export async function grantCoinReward(
  userId: string,
  rewardCode: string,
  sourceId: string,
  description: string,
): Promise<number | null> {
  const amount = REWARD_AMOUNTS[rewardCode];
  if (!amount) {
    logger.warn({ userId, rewardCode }, "grantCoinReward: unknown reward code");
    return null;
  }

  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: coinRewardGrantsTable.id })
        .from(coinRewardGrantsTable)
        .where(
          and(
            eq(coinRewardGrantsTable.userId, userId),
            eq(coinRewardGrantsTable.rewardCode, rewardCode),
            eq(coinRewardGrantsTable.sourceId, sourceId),
          ),
        )
        .limit(1);

      if (existing) {
        logger.debug({ userId, rewardCode, sourceId }, "grantCoinReward: duplicate skipped");
        return null;
      }

      await tx.insert(coinRewardGrantsTable).values({
        userId,
        rewardCode,
        sourceId,
        coinsAwarded: amount,
      });

      const { newBalance } = await recordCoinLedgerEntry(tx, {
        userId,
        amount,
        transactionType: "earn",
        source: rewardCode.toLowerCase(),
        sourceId,
        rewardCode,
        reasonCode: rewardCode.toLowerCase(),
        idempotencyKey: `reward:${userId}:${rewardCode}:${sourceId}`,
        description,
        metadata: { rewardType: rewardCode },
      });
      logger.info({ userId, rewardCode, sourceId, amount, newBalance }, "grantCoinReward: granted");

      // Notify the user in real-time — include exact new balance so frontend can set it directly
      void triggerEvent(`private-user-${userId}`, "coins:earned", {
        coins: amount,
        coinBalance: newBalance,
        description,
        rewardCode,
      }).catch(() => {});

      // Evaluate achievement titles — fire-and-forget so coin grant never fails on this
      evaluateUserTitles(userId).catch(() => {});

      return amount;
    });
  } catch (err) {
    logger.error({ userId, rewardCode, sourceId, err }, "grantCoinReward: failed");
    return null;
  }
}
