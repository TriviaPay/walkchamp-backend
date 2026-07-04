import { Router, type IRouter, type Request, type Response } from "express";
import { HealthCheckResponse } from "../../api-zod/src/index.js";
import { sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import { config } from "../lib/config.js";
import {
  inspectRedisRuntime,
  requireSplitQueueRedisIfEnabled,
  type RedisRuntimeStatus,
} from "../lib/redisRuntimeValidation.js";
import { getRuntimeLoadState } from "../middleware/loadShedding.js";
import { readinessStatusCode, shouldExposeReadinessDetails } from "../lib/healthVisibility.js";

const router: IRouter = Router();
type CheckValue = "ok" | "warning" | "error" | "skipped";
type ReadinessStatus = "ready" | "degraded" | "not_ready";

function setHealthNoStoreHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Cloudflare-CDN-Cache-Control", "no-store");
  res.setHeader("CDN-Cache-Control", "no-store");
  res.setHeader("Surrogate-Control", "no-store");
}

function redisCheckValue(status: RedisRuntimeStatus | null, skipped: boolean): CheckValue {
  if (skipped) return "skipped";
  if (!status) return "error";
  if (!status.ok) return "error";
  return status.warnings.length > 0 ? "warning" : "ok";
}

async function checkMigrations(): Promise<void> {
  await db.execute(sql`
    select coalesce(max(created_at), 0)::text as latest_migration
    from drizzle.__drizzle_migrations
  `);
}

router.get("/livez", (_req, res) => {
  setHealthNoStoreHeaders(res);
  const loadState = getRuntimeLoadState();
  const eventLoopResponsive = loadState.eventLoopP95Ms < 1_000;

  if (!eventLoopResponsive) {
    return res.status(503).json({
      status: "not_live",
    });
  }

  const data = HealthCheckResponse.parse({ status: "ok" });
  return res.json(data);
});

router.get("/healthz", (_req, res) => {
  setHealthNoStoreHeaders(res);
  const data = HealthCheckResponse.parse({ status: "ok" });
  return res.json(data);
});

function readinessDetailTokenOf(req: Request): string | null {
  const raw = req.headers["x-health-check-token"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value ? value : null;
}

function sendReadiness(
  req: Request,
  res: Response,
  status: ReadinessStatus,
  details: Record<string, unknown>,
) {
  const exposeDetails = shouldExposeReadinessDetails({
    nodeEnv: config.nodeEnv,
    configuredToken: config.health.readinessDetailToken,
    requestToken: readinessDetailTokenOf(req),
  });

  if (!exposeDetails && status !== "ready") {
    req.log.warn({ status, ...details }, "Readiness is not fully healthy");
  }

  return res.status(readinessStatusCode(status)).json(
    exposeDetails ? { status, ...details } : { status },
  );
}

router.get("/readyz", async (req, res) => {
  setHealthNoStoreHeaders(res);
  const shouldCheckDatabase = config.nodeEnv !== "test";
  const shouldCheckRedis = config.features.rateLimitingEnabled && config.nodeEnv !== "test";
  const shouldInspectQueueRedis = config.redis.queueUrl !== null
    && config.nodeEnv !== "test"
    && (config.features.bullmqWebhookProcessingEnabled || config.processRole === "worker");
  const queueRedisRequired = config.processRole === "worker";

  let redisCacheStatus: RedisRuntimeStatus | null = null;
  let redisQueueStatus: RedisRuntimeStatus | null = null;
  let databaseCheck: CheckValue = "skipped";
  let migrationCheck: CheckValue = "skipped";
  let redisCacheCheck: CheckValue = shouldCheckRedis ? "error" : "skipped";
  let redisQueueCheck: CheckValue = shouldInspectQueueRedis ? "error" : "skipped";
  let redisSplitCheck: CheckValue = "skipped";
  const errors: string[] = [];
  const warnings: string[] = [];
  const loadState = getRuntimeLoadState();
  const eventLoopReady = loadState.eventLoopP95Ms < 250;

  if (!eventLoopReady) {
    errors.push("event loop p95 is above readiness threshold");
  }

  const splitError = requireSplitQueueRedisIfEnabled();
  if (splitError) {
    redisSplitCheck = queueRedisRequired ? "error" : "warning";
    if (queueRedisRequired) {
      errors.push(splitError);
    } else {
      warnings.push(splitError);
    }
  } else {
    redisSplitCheck = shouldInspectQueueRedis ? "ok" : "skipped";
  }

  if (shouldCheckDatabase) {
    try {
      await db.execute(sql`select 1`);
      databaseCheck = "ok";
      await checkMigrations();
      migrationCheck = "ok";
    } catch (err) {
      databaseCheck = databaseCheck === "ok" ? "ok" : "error";
      migrationCheck = migrationCheck === "ok" ? "ok" : "error";
      errors.push(err instanceof Error ? err.message : "database readiness check failed");
    }
  }

  if (shouldCheckRedis) {
    try {
      redisCacheStatus = await inspectRedisRuntime("cache");
      redisCacheCheck = redisCheckValue(redisCacheStatus, false);
      if (!redisCacheStatus.ok) {
        errors.push(...redisCacheStatus.errors);
      }
      warnings.push(...redisCacheStatus.warnings);
    } catch (err) {
      redisCacheCheck = "error";
      errors.push(err instanceof Error ? err.message : "redis-cache readiness check failed");
    }
  }

  if (shouldInspectQueueRedis) {
    try {
      redisQueueStatus = await inspectRedisRuntime("queue");
      redisQueueCheck = redisCheckValue(redisQueueStatus, false);
      if (!redisQueueStatus.ok) {
        if (queueRedisRequired) {
          errors.push(...redisQueueStatus.errors);
        } else {
          warnings.push(...redisQueueStatus.errors);
          redisQueueCheck = "warning";
        }
      }
      warnings.push(...redisQueueStatus.warnings);
    } catch (err) {
      redisQueueCheck = queueRedisRequired ? "error" : "warning";
      const message = err instanceof Error ? err.message : "redis-queue readiness check failed";
      if (queueRedisRequired) {
        errors.push(message);
      } else {
        warnings.push(message);
      }
    }
  }

  const status: ReadinessStatus = errors.length > 0
    ? "not_ready"
    : warnings.length > 0
      ? "degraded"
      : "ready";
  return sendReadiness(req, res, status, {
    checks: {
      database: databaseCheck,
      migrations: migrationCheck,
      redisCache: redisCacheCheck,
      redisQueue: redisQueueCheck,
      redisSplit: redisSplitCheck,
      eventLoop: eventLoopReady ? "ok" : "error",
      config: "ok",
    },
    load: loadState,
    redis: {
      cache: redisCacheStatus,
      queue: redisQueueStatus,
    },
    warnings,
    errors,
  });
});

export default router;
