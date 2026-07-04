import { logger } from "./lib/logger.js";
import { runIdempotentJob } from "./lib/queue.js";
import { recomputeCoinProjection } from "./lib/coinsService.js";
import { db } from "../db/src/index.js";
import { coinBalancesTable } from "../db/src/schema/index.js";
import { config } from "./lib/config.js";
import { startWorkerOwnedRecurringJobs } from "./lib/backgroundJobs.js";
import { startOutboxDispatcher } from "./lib/outbox.js";

async function reconcileAllCoinBalances() {
  const users = await db.select({ userId: coinBalancesTable.userId }).from(coinBalancesTable);
  for (const row of users) {
    await recomputeCoinProjection(row.userId);
  }
}

async function main() {
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
