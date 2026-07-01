import IORedis, { type Redis as RedisClient } from "ioredis";
import { config } from "./config";
import { logger } from "./logger";

let redisClient: RedisClient | null = null;

export function hasRedisConfigured(): boolean {
  return Boolean(config.redis.url);
}

export function getRedis(): RedisClient {
  if (!config.redis.url) {
    throw new Error("REDIS_URL is not configured.");
  }

  if (!redisClient) {
    redisClient = new IORedis(config.redis.url, {
      enableReadyCheck: true,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });

    redisClient.on("error", (err: unknown) => {
      logger.warn({ err }, "Redis client error");
    });
  }

  return redisClient;
}

export async function pingRedis(): Promise<void> {
  if (!config.redis.url) return;
  const redis = getRedis();
  if (redis.status === "wait") {
    await redis.connect();
  }
  await redis.ping();
}
