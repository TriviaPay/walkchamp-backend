import { logger } from "./lib/logger.js";
import { initSentry, captureException } from "./lib/sentry.js";
import { runIdempotentJob, startQueueWorker, closeQueues } from "./lib/queue.js";
import { recomputeCoinProjection } from "./lib/coinsService.js";
import { db, pool } from "../db/src/index.js";
import { coinBalancesTable } from "../db/src/schema/index.js";
import { installProcessSafetyHandlers } from "./lib/processSafety.js";
import { config } from "./lib/config.js";
import { startWorkerOwnedRecurringJobs } from "./lib/backgroundJobs.js";
import { startOutboxDispatcher } from "./lib/outbox.js";
import { processApprovedRefundJob } from "./lib/refundService.js";
import { processDepositWebhookEvent } from "./lib/depositWebhookProcessor.js";
import { evaluateScheduledStart, expireOpenWindow, sendScheduledReminder } from "./lib/waitingRoomJobs.js";
import { grantVariableCoinReward } from "./lib/coinRewardService.js";
import { startUnlimitedChallenge } from "./lib/unlimitedChallengeJobs.js";
import { settleUnlimitedChallenge } from "./lib/unlimitedChallengeSettlement.js";
import { processSponsuredEvents } from "./routes/sponsoredEvents.js";
import { autoCompleteRace } from "./routes/races.js";

async function reconcileAllCoinBalances() {
  const users = await db.select({ userId: coinBalancesTable.userId }).from(coinBalancesTable);
  for (const row of users) {
    await recomputeCoinProjection(row.userId);
  }
}

async function main() {
  // Initialize error reporting before any job processing (audit 2026-08-17 M20) — the worker runs
  // settlement/refund/webhook jobs and previously shipped blind.
  await initSentry("worker");

  installProcessSafetyHandlers({
    logger,
    onShutdown: async () => {
      try {
        await closeQueues();
      } catch (err) {
        logger.error({ err }, "[shutdown] closeQueues failed");
      }
      try {
        await pool.end();
      } catch (err) {
        logger.error({ err }, "[shutdown] pool.end failed");
      }
    },
  });

  logger.info("Worker booted");

  if (!config.features.runBackgroundJobs) {
    logger.info("Worker exiting because RUN_BACKGROUND_JOBS=false");
    return;
  }

  if (config.redis.cacheUrl || config.redis.queueUrl) {
    logger.info({
      redisCacheConfigured: Boolean(config.redis.cacheUrl),
      redisQueueConfigured: Boolean(config.redis.queueUrl),
      redisSplitConfigured: config.redis.splitConfigured,
    }, "Worker starting with Redis configured");
  } else {
    logger.warn("REDIS_URL is not configured; recurring jobs are worker-owned but not queue-backed.");
  }

  if (config.features.bullmqWebhookProcessingEnabled) {
    logger.info("Starting outbox dispatcher");
    startOutboxDispatcher();
    startQueueWorker("refund-processing", async (job) => {
      if (job.name !== "provider_refund.approved") return;
      const refundItemId = String((job.data.payload as { refundItemId?: unknown } | undefined)?.refundItemId ?? "");
      if (!refundItemId) throw new Error("refund-processing job missing refundItemId");
      await processApprovedRefundJob({ refundItemId });
    }, { concurrency: 2 });
    startQueueWorker("webhook-processing", async (job) => {
      if (job.name !== "deposit_webhook.process") return;
      const payload = job.data.payload as { provider?: unknown; providerEventId?: unknown } | undefined;
      const provider = payload?.provider;
      const providerEventId = payload?.providerEventId;
      if ((provider !== "stripe" && provider !== "razorpay") || typeof providerEventId !== "string") {
        throw new Error("webhook-processing job missing deposit webhook identity");
      }
      await processDepositWebhookEvent({ provider, providerEventId });
    }, { concurrency: 4 });

    // Durable Coins Battle payout backstop (audit 2026-08-17 M2). Re-drives the coin prize grants
    // if the settlement's fast-path fire-and-forget was lost to a crash/deploy. Each grant is
    // idempotent on rewardCode+sourceId, so re-running a fully-paid room is a no-op.
    startQueueWorker("coin-reconciliation", async (job) => {
      if (job.name !== "coins_battle.payout") return;
      const payload = job.data.payload as {
        raceId?: string;
        payouts?: Array<{ userId: string; coins: number; rank: number }>;
      } | undefined;
      if (!payload?.raceId || !Array.isArray(payload.payouts)) return;
      for (const p of payload.payouts) {
        if (!p?.userId || typeof p.coins !== "number" || p.coins <= 0) continue;
        const rankLabel = p.rank === 1 ? "1st" : p.rank === 2 ? "2nd" : `${p.rank}th`;
        await grantVariableCoinReward({
          userId: p.userId,
          amount: p.coins,
          rewardCode: `COINS_BATTLE_WIN_${p.rank}_${payload.raceId}`,
          sourceId: payload.raceId,
          description: `Coins Battle prize: ${rankLabel} place — ${p.coins} coins`,
        });
      }
    }, { concurrency: 2 });
  }

  // Shared Waiting Room durable delayed jobs (scheduled auto-start / 30-min open-window expiry /
  // T-30 reminder). Exact-time firing; the scheduler's reconcileWaitingRooms tick is the safety net.
  if (config.redis.queueUrl) {
    startQueueWorker("scheduled-jobs", async (job) => {
      const envelope = job.data as { roomId?: unknown; challengeId?: unknown; raceId?: unknown; payload?: Record<string, unknown> };
      const data = (envelope.payload ?? envelope) as { roomId?: unknown; challengeId?: unknown; raceId?: unknown };
      const roomId = String(data.roomId ?? "");
      const challengeId = String(data.challengeId ?? "");
      const raceId = String(data.raceId ?? "");
      switch (job.name) {
        case "waiting_room.scheduled_start":
          if (roomId) await evaluateScheduledStart(roomId);
          break;
        case "waiting_room.expire":
          if (roomId) await expireOpenWindow(roomId);
          break;
        case "waiting_room.scheduled_reminder":
          if (roomId) await sendScheduledReminder(roomId);
          break;
        case "unlimited.start":
          if (challengeId) await startUnlimitedChallenge(challengeId);
          break;
        case "unlimited.settle":
          if (challengeId) await settleUnlimitedChallenge(challengeId);
          break;
        case "sponsored.start":
          if (roomId) await processSponsuredEvents(roomId);
          break;
        case "race.settlement_retry":
          if (raceId) await autoCompleteRace(raceId, "settlement_retry");
          break;
        default:
          break;
      }
    }, { concurrency: 4 });
  }

  await runIdempotentJob({
    name: "coin-reconciliation-bootstrap",
    handler: reconcileAllCoinBalances,
  });

  await startWorkerOwnedRecurringJobs();
}

main().catch((err) => {
  logger.error({ err }, "Worker crashed");
  captureException(err, { component: "worker", phase: "main" });
  process.exit(1);
});
