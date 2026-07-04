import { Redis } from "ioredis";
import { config } from "./config.js";
import { logger } from "./logger.js";

type RedisClient = InstanceType<typeof Redis>;

let redisCacheClient: RedisClient | undefined;
let redisQueueClient: RedisClient | undefined;

export function hasRedisConfigured(): boolean {
  return Boolean(config.redis.cacheUrl);
}

export function hasRedisQueueConfigured(): boolean {
  return Boolean(config.redis.queueUrl);
}

function createRedisClient(url: string, role: "cache" | "queue"): RedisClient {
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

export function getRedis(): RedisClient {
  return getRedisCache();
}

export async function pingRedis(): Promise<void> {
  if (!config.redis.cacheUrl) return;
  const redis = getRedisCache();
  if (redis.status === "wait") {
    await redis.connect();
  }
  await redis.ping();
}

export async function pingRedisQueue(): Promise<void> {
  if (!config.redis.queueUrl) return;
  const redis = getRedisQueue();
  if (redis.status === "wait") {
    await redis.connect();
  }
  await redis.ping();
}
