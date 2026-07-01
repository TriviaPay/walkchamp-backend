import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@api-zod";
import { sql } from "drizzle-orm";
import { db } from "@db";
import { config } from "../lib/config.js";
import { pingRedis } from "../lib/redis.js";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/readyz", async (_req, res) => {
  const shouldCheckDatabase = config.nodeEnv !== "test";
  const shouldCheckRedis = config.features.rateLimitingEnabled && config.nodeEnv !== "test";

  try {
    if (shouldCheckDatabase) {
      await db.execute(sql`select 1`);
    }
    if (shouldCheckRedis) {
      await pingRedis();
    }

    return res.json({
      status: "ready",
      checks: {
        database: shouldCheckDatabase ? "ok" : "skipped",
        redis: shouldCheckRedis ? "ok" : "skipped",
        config: "ok",
      },
    });
  } catch (err) {
    return res.status(503).json({
      status: "not_ready",
      checks: {
        database: "error",
        redis: shouldCheckRedis ? "error" : "skipped",
        config: "ok",
      },
      error: err instanceof Error ? err.message : "Unknown readiness failure",
    });
  }
});

export default router;
