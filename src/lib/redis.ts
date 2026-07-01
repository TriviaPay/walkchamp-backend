import { Redis } from "ioredis";
import { config } from "./config.js";
import { logger } from "./logger.js";

type RedisClient = InstanceType<typeof Redis>;

let redisClient: RedisClient | undefined;

export function hasRedisConfigured(): boolean {
  return Boolean(config.redis.url);
}

export function getRedis(): RedisClient {
  if (!config.redis.url) {
    throw new Error("REDIS_URL is not configured.");
  }

  if (!redisClient) {
    const client = new Redis(config.redis.url, {
      enableReadyCheck: true,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });

    client.on("error", (err: unknown) => {
      logger.warn({ err }, "Redis client error");
    });

    redisClient = client;
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
