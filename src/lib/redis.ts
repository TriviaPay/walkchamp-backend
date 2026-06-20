import Redis from "ioredis";
import { config } from "./config";
import { logger } from "./logger";

let redisClient: Redis | null = null;

export function hasRedisConfigured(): boolean {
  return Boolean(config.redis.url);
}

export function getRedis(): Redis {
  if (!config.redis.url) {
    throw new Error("REDIS_URL is not configured.");
  }

  if (!redisClient) {
    redisClient = new Redis(config.redis.url, {
      enableReadyCheck: true,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });

    redisClient.on("error", (err) => {
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
