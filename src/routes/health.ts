import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@api-zod";
import { sql } from "drizzle-orm";
import { db } from "@db";
import { config } from "../lib/config";
import { pingRedis } from "../lib/redis";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/readyz", async (_req, res) => {
  try {
    await db.execute(sql`select 1`);
    if (config.features.rateLimitingEnabled) {
      await pingRedis();
    }

    return res.json({
      status: "ready",
      checks: {
        database: "ok",
        redis: config.features.rateLimitingEnabled ? "ok" : "skipped",
        config: "ok",
      },
    });
  } catch (err) {
    return res.status(503).json({
      status: "not_ready",
      checks: {
        database: "error",
        redis: config.features.rateLimitingEnabled ? "error" : "skipped",
        config: "ok",
      },
      error: err instanceof Error ? err.message : "Unknown readiness failure",
    });
  }
});

export default router;
