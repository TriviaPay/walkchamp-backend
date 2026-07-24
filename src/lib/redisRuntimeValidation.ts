import type { Redis } from "ioredis";
import { config } from "./config.js";
import { getRedisCache, getRedisQueue, getRedisLive } from "./redis.js";

type RedisClient = InstanceType<typeof Redis>;
type RedisRole = "cache" | "queue" | "live";

export type RedisRuntimeStatus = {
  role: RedisRole;
  ok: boolean;
  warnings: string[];
  errors: string[];
  config: {
    maxmemory: number | null;
    maxmemoryPolicy: string | null;
    appendonly: string | null;
    appendfsync: string | null;
  };
  memory: {
    usedMemory: number | null;
    maxmemory: number | null;
    usedMemoryRatio: number | null;
    evictedKeys: number | null;
  };
};

let queueMemoryGateCache:
  | { checkedAt: number; pauseNoncritical: boolean; status: RedisRuntimeStatus }
  | null = null;

export function redisConfigPairsToObject(raw: unknown): Record<string, string> {
  const values = Array.isArray(raw) ? raw : [];
  const result: Record<string, string> = {};

  for (let i = 0; i < values.length - 1; i += 2) {
    const key = String(values[i] ?? "").toLowerCase();
    if (!key) continue;
    result[key] = String(values[i + 1] ?? "");
  }

  return result;
}

export function parseRedisInfo(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  return result;
}

function parseNumber(value: string | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function evaluateRedisRuntime(
  role: RedisRole,
  runtimeConfig: Record<string, string>,
  memoryInfo: Record<string, string>,
  statsInfo: Record<string, string>,
): RedisRuntimeStatus {
  const maxmemory = parseNumber(runtimeConfig.maxmemory);
  const usedMemory = parseNumber(memoryInfo.used_memory);
  const evictedKeys = parseNumber(statsInfo.evicted_keys);
  const usedMemoryRatio =
    usedMemory != null && maxmemory != null && maxmemory > 0
      ? usedMemory / maxmemory
      : null;

  const warnings: string[] = [];
  const errors: string[] = [];
  const maxmemoryPolicy = runtimeConfig["maxmemory-policy"] ?? null;
  const appendonly = runtimeConfig.appendonly ?? null;
  const appendfsync = runtimeConfig.appendfsync ?? null;

  if (role === "cache") {
    if (maxmemory == null || maxmemory <= 0) {
      errors.push("redis-cache maxmemory must be set above 0");
    }
    if (maxmemoryPolicy !== "allkeys-lfu") {
      errors.push(`redis-cache maxmemory-policy must be allkeys-lfu, got ${maxmemoryPolicy ?? "unknown"}`);
    }
    if (usedMemoryRatio != null && usedMemoryRatio >= 0.85) {
      warnings.push("redis-cache memory usage is at or above 85%");
    }
  } else {
    // redis-queue and redis-live both hold data that must never be evicted (BullMQ jobs /
    // live race state) and must survive a restart (AOF everysec).
    const name = role === "queue" ? "redis-queue" : "redis-live";
    if (maxmemoryPolicy !== "noeviction") {
      errors.push(`${name} maxmemory-policy must be noeviction, got ${maxmemoryPolicy ?? "unknown"}`);
    }
    if (appendonly !== "yes") {
      errors.push(`${name} appendonly must be yes, got ${appendonly ?? "unknown"}`);
    }
    if (appendfsync !== "everysec") {
      errors.push(`${name} appendfsync must be everysec, got ${appendfsync ?? "unknown"}`);
    }
    if (evictedKeys != null && evictedKeys > 0) {
      errors.push(`${name} has evicted ${evictedKeys} keys; this Redis must not evict`);
    }
    if (usedMemoryRatio != null && usedMemoryRatio >= 0.85) {
      errors.push(`${name} memory usage is at or above 85%; pause noncritical enqueue sources`);
    } else if (usedMemoryRatio != null && usedMemoryRatio >= 0.70) {
      warnings.push(`${name} memory usage is at or above 70%`);
    }
  }

  return {
    role,
    ok: errors.length === 0,
    warnings,
    errors,
    config: {
      maxmemory,
      maxmemoryPolicy,
      appendonly,
      appendfsync,
    },
    memory: {
      usedMemory,
      maxmemory,
      usedMemoryRatio,
      evictedKeys,
    },
  };
}

async function inspectRedisClient(role: RedisRole, redis: RedisClient): Promise<RedisRuntimeStatus> {
  if (redis.status === "wait") {
    await redis.connect();
  }

  await redis.ping();
  const [maxmemoryRaw, maxmemoryPolicyRaw, appendonlyRaw, appendfsyncRaw, memoryRaw, statsRaw] = await Promise.all([
    redis.config("GET", "maxmemory"),
    redis.config("GET", "maxmemory-policy"),
    redis.config("GET", "appendonly"),
    redis.config("GET", "appendfsync"),
    redis.info("memory"),
    redis.info("stats"),
  ]);
  const runtimeConfig = {
    ...redisConfigPairsToObject(maxmemoryRaw),
    ...redisConfigPairsToObject(maxmemoryPolicyRaw),
    ...redisConfigPairsToObject(appendonlyRaw),
    ...redisConfigPairsToObject(appendfsyncRaw),
  };

  return evaluateRedisRuntime(
    role,
    runtimeConfig,
    parseRedisInfo(memoryRaw),
    parseRedisInfo(statsRaw),
  );
}

export async function inspectRedisRuntime(role: RedisRole): Promise<RedisRuntimeStatus> {
  const client = role === "cache" ? getRedisCache() : role === "live" ? getRedisLive() : getRedisQueue();
  return inspectRedisClient(role, client);
}

export async function shouldPauseNoncriticalQueueEnqueue(): Promise<boolean> {
  const now = Date.now();
  if (queueMemoryGateCache && now - queueMemoryGateCache.checkedAt < 30_000) {
    return queueMemoryGateCache.pauseNoncritical;
  }

  const status = await inspectRedisRuntime("queue");
  const pauseNoncritical =
    !status.ok
    || (status.memory.usedMemoryRatio != null && status.memory.usedMemoryRatio >= 0.85);

  queueMemoryGateCache = {
    checkedAt: now,
    pauseNoncritical,
    status,
  };

  return pauseNoncritical;
}

export function requireSplitQueueRedisIfEnabled(): string | null {
  const queueEnabled = config.features.bullmqWebhookProcessingEnabled || config.processRole === "worker";
  if (!queueEnabled || !config.redis.queueUrl) return null;
  if (!config.redis.splitConfigured) {
    return "redis-queue must be split from redis-cache before BullMQ webhook/worker processing is enabled";
  }
  return null;
}
