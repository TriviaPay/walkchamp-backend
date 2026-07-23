import { logger } from "./lib/logger.js";
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

async function reconcileAllCoinBalances() {
  const users = await db.select({ userId: coinBalancesTable.userId }).from(coinBalancesTable);
  for (const row of users) {
    await recomputeCoinProjection(row.userId);
  }
}

async function main() {
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
  }

  await runIdempotentJob({
    name: "coin-reconciliation-bootstrap",
    handler: reconcileAllCoinBalances,
  });

  await startWorkerOwnedRecurringJobs();
}

main().catch((err) => {
  logger.error({ err }, "Worker crashed");
  process.exit(1);
});
