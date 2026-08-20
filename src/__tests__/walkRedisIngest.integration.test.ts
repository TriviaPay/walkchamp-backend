import { execSync, spawn, type ChildProcess } from "node:child_process";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

function redisServerAvailable(): boolean {
  try { execSync("which redis-server", { stdio: "ignore" }); return true; } catch { return false; }
}

const hoisted = vi.hoisted(() => ({ client: null as unknown as Redis }));
vi.mock("../lib/redis.js", () => ({
  getRedisLive: () => hoisted.client,
  ensureRedisLiveConnected: async () => {},
}));
vi.mock("../lib/config.js", () => ({
  config: {
    logLevel: "silent",
    isProduction: true,
    processRole: "test",
    database: {
      runtimeUrl: "postgres://test:test@127.0.0.1:5432/test",
      poolMax: 1,
      connectionTimeoutMillis: 100,
      idleTimeoutMillis: 100,
      statementTimeoutMillis: 100,
      idleInTransactionSessionTimeoutMillis: 100,
    },
    redis: { liveUrl: "redis://test", cacheUrl: null },
    features: {
      redisWalkCanaryPercent: 100,
      redisLeaderboardMirrorWrite: false,
      redisLeaderboardServe: false,
    },
  },
}));

import { applyRedisWalkSubmission, getRedisWalkDay } from "../lib/walkRedisIngest.js";

describe.skipIf(!redisServerAvailable())("walk Redis ingest (integration)", () => {
  let server: ChildProcess;
  let redis: Redis;

  beforeAll(async () => {
    const port = 7600 + (process.pid % 500);
    server = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no", "--maxmemory-policy", "noeviction"], { stdio: "ignore" });
    redis = new Redis(port, "127.0.0.1", { maxRetriesPerRequest: 5, retryStrategy: (attempt) => attempt > 20 ? null : 50 });
    hoisted.client = redis;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("redis did not become ready")), 10_000);
      redis.on("ready", () => { clearTimeout(timer); resolve(); });
      redis.on("error", () => {});
    });
  }, 15_000);

  afterEach(async () => redis.flushall());
  afterAll(async () => { await redis?.quit().catch(() => {}); server?.kill("SIGKILL"); });

  const base = {
    submissionId: "00000000-0000-4000-8000-000000000001",
    userId: "user-a", deviceId: "device-a", localDate: "2026-08-20", timezone: "America/New_York",
    sourceClass: "verified" as const, totalSteps: 1000, distanceMeters: 762,
    caloriesBurned: 40, activeMinutes: 9,
  };

  it("is idempotent when the command applied but the client retries the absolute total", async () => {
    await redis.hset("walk:ingest:control", { mode: "redis", epoch: "7" });
    const first = await applyRedisWalkSubmission(base);
    const retry = await applyRedisWalkSubmission(base);
    expect(first.steps).toBe(1000);
    expect(retry.steps).toBe(1000);
    expect(retry.version).toBeGreaterThan(first.version);
    expect((await getRedisWalkDay(base.userId, base.localDate))?.steps).toBe(1000);
  });

  it("sums independent device watermarks and rejects an old control epoch", async () => {
    await redis.hset("walk:ingest:control", { mode: "redis", epoch: "3" });
    await applyRedisWalkSubmission(base);
    const merged = await applyRedisWalkSubmission({ ...base, deviceId: "device-b", totalSteps: 500 });
    expect(merged.steps).toBe(1500);

    await redis.hset("walk:ingest:control", { mode: "postgres", epoch: "4" });
    await expect(applyRedisWalkSubmission({ ...base, totalSteps: 1200 }))
      .rejects.toThrow("redis_walk_not_authoritative");
  });

  it("fails closed when noeviction rejects the critical write", async () => {
    await redis.hset("walk:ingest:control", { mode: "redis", epoch: "9" });
    await redis.config("SET", "maxmemory", "1");
    try {
      await expect(applyRedisWalkSubmission(base)).rejects.toThrow(/OOM|memory/i);
      expect(await redis.exists("walk:ingest:day:9:user-a:2026-08-20")).toBe(0);
    } finally {
      await redis.config("SET", "maxmemory", "0");
    }
  });
});
