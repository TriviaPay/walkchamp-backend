import { execSync, spawn, type ChildProcess } from "node:child_process";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

function redisServerAvailable(): boolean {
  try { execSync("which redis-server", { stdio: "ignore" }); return true; } catch { return false; }
}

const hoisted = vi.hoisted(() => ({ client: null as unknown as Redis }));
vi.mock("../lib/redis.js", () => ({
  getRedisCache: () => hoisted.client,
  ensureRedisCacheConnected: async () => {},
}));
vi.mock("../lib/config.js", () => ({
  config: {
    logLevel: "silent", isProduction: true,
    redis: { cacheUrl: "redis://test" }, features: { redisPresenceMirrorWrite: true },
  },
}));
vi.mock("../lib/pusher.js", () => ({ triggerEvent: async () => {} }));
vi.mock("../../db/src/index.js", () => ({
  db: {
    select: () => {
      const builder = { from: () => builder, where: async () => [] };
      return builder;
    },
  },
}));

import { redisPresenceHeartbeat, redisPresenceOffline, redisPresenceCounts } from "../lib/redisPresence.js";

describe.skipIf(!redisServerAvailable())("Redis device presence (integration)", () => {
  let server: ChildProcess;
  let redis: Redis;

  beforeAll(async () => {
    const port = 8100 + (process.pid % 500);
    server = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
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

  it("applies multi-device precedence and goes offline only after every device leaves", async () => {
    const online = await redisPresenceHeartbeat("user-a", "phone", "online");
    const racing = await redisPresenceHeartbeat("user-a", "watch", "racing");
    expect(online.status).toBe("online");
    expect(racing.status).toBe("racing");
    expect(racing.revision).toBeGreaterThan(online.revision);

    const phoneOnly = await redisPresenceOffline("user-a", "watch");
    expect(phoneOnly.status).toBe("online");
    const offline = await redisPresenceOffline("user-a", "phone");
    expect(offline.status).toBe("offline");
    expect((await redisPresenceCounts()).online).toBe(0);
  });
});
