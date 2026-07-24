import { Redis } from "ioredis";
import { config } from "./config.js";
import { logger } from "./logger.js";

type RedisClient = InstanceType<typeof Redis>;
type RedisRole = "cache" | "queue" | "live";

let redisCacheClient: RedisClient | undefined;
let redisQueueClient: RedisClient | undefined;
let redisLiveClient: RedisClient | undefined;
const connectPromises: Record<RedisRole, Promise<void> | null> = {
  cache: null,
  queue: null,
  live: null,
};

export function hasRedisConfigured(): boolean {
  return Boolean(config.redis.cacheUrl);
}

export function hasRedisQueueConfigured(): boolean {
  return Boolean(config.redis.queueUrl);
}

export function hasRedisLiveConfigured(): boolean {
  return Boolean(config.redis.liveUrl);
}

function createRedisClient(url: string, role: RedisRole): RedisClient {
  const client = new Redis(url, {
    enableReadyCheck: true,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: config.runtime.redisCommandTimeoutMs,
    commandTimeout: config.runtime.redisCommandTimeoutMs,
  });

  client.on("error", (err: unknown) => {
    logger.warn({ err, role }, "Redis client error");
  });

  return client;
}

export function getRedisCache(): RedisClient {
  if (!config.redis.cacheUrl) {
    throw new Error("REDIS_CACHE_URL or REDIS_URL is not configured.");
  }

  if (!redisCacheClient) {
    redisCacheClient = createRedisClient(config.redis.cacheUrl, "cache");
  }

  return redisCacheClient;
}

export function getRedisQueue(): RedisClient {
  if (!config.redis.queueUrl) {
    throw new Error("REDIS_QUEUE_URL or REDIS_URL is not configured.");
  }

  if (!redisQueueClient) {
    redisQueueClient = createRedisClient(config.redis.queueUrl, "queue");
  }

  return redisQueueClient;
}

export function getRedisLive(): RedisClient {
  if (!config.redis.liveUrl) {
    throw new Error("REDIS_LIVE_URL (or a fallback queue/REDIS_URL) is not configured.");
  }

  if (!redisLiveClient) {
    redisLiveClient = createRedisClient(config.redis.liveUrl, "live");
  }

  return redisLiveClient;
}

export function getRedis(): RedisClient {
  return getRedisCache();
}

async function ensureConnected(redis: RedisClient, role: RedisRole): Promise<void> {
  if (redis.status === "ready") return;
  if (redis.status === "wait" || redis.status === "end") {
    const existing = connectPromises[role];
    if (existing) {
      await existing;
      return;
    }

    const connectPromise = redis.connect().finally(() => {
      connectPromises[role] = null;
    });
    connectPromises[role] = connectPromise;

    await connectPromise;
    return;
  }

  throw new Error(`Redis ${role} client is not ready: ${redis.status}`);
}

export async function ensureRedisCacheConnected(): Promise<void> {
  if (!config.redis.cacheUrl) return;
  await ensureConnected(getRedisCache(), "cache");
}

export async function ensureRedisQueueConnected(): Promise<void> {
  if (!config.redis.queueUrl) return;
  await ensureConnected(getRedisQueue(), "queue");
}

export async function ensureRedisLiveConnected(): Promise<void> {
  if (!config.redis.liveUrl) return;
  await ensureConnected(getRedisLive(), "live");
}

export async function pingRedis(): Promise<void> {
  if (!config.redis.cacheUrl) return;
  await ensureRedisCacheConnected();
  const redis = getRedisCache();
  await redis.ping();
}

export async function pingRedisQueue(): Promise<void> {
  if (!config.redis.queueUrl) return;
  await ensureRedisQueueConnected();
  const redis = getRedisQueue();
  await redis.ping();
}
