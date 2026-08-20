import { config } from "./config.js";
import { ensureRedisCacheConnected, getRedisCache } from "./redis.js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export type SnapshotFamily = "race" | "coin" | "group";

async function generation(family: SnapshotFamily): Promise<number> {
  return Number((await getRedisCache().get(`leaderboard:snapshot:generation:${family}`)) ?? 0);
}

function safeKey(value: string): string { return encodeURIComponent(value).slice(0, 500); }

export async function readLeaderboardSnapshot<T>(family: SnapshotFamily, identity: string): Promise<T | null> {
  if (!config.redis.cacheUrl) return null;
  try {
    await ensureRedisCacheConnected();
    const gen = await generation(family);
    const value = await getRedisCache().get(`leaderboard:snapshot:${family}:${gen}:${safeKey(identity)}`);
    return value ? JSON.parse(value) as T : null;
  } catch {
    return null;
  }
}

export async function beginLeaderboardSnapshotFill<T>(family: SnapshotFamily, identity: string): Promise<{
  cached: T | null; token: string | null;
}> {
  const cached = await readLeaderboardSnapshot<T>(family, identity);
  if (cached || !config.redis.cacheUrl) return { cached, token: null };
  await ensureRedisCacheConnected();
  const gen = await generation(family);
  const lockKey = `leaderboard:snapshot:fill:${family}:${gen}:${safeKey(identity)}`;
  const token = randomUUID();
  if (await getRedisCache().set(lockKey, token, "PX", 5_000, "NX")) return { cached: null, token };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await delay(50);
    const filled = await readLeaderboardSnapshot<T>(family, identity);
    if (filled) return { cached: filled, token: null };
  }
  return { cached: null, token: null };
}

export async function writeLeaderboardSnapshot(
  family: SnapshotFamily, identity: string, value: unknown, fillToken?: string | null,
): Promise<void> {
  if (!config.redis.cacheUrl) return;
  await ensureRedisCacheConnected();
  const gen = await generation(family);
  const ttl = family === "group" ? 30 : 60;
  await getRedisCache().set(`leaderboard:snapshot:${family}:${gen}:${safeKey(identity)}`, JSON.stringify(value), "EX", ttl);
  if (fillToken) {
    const lockKey = `leaderboard:snapshot:fill:${family}:${gen}:${safeKey(identity)}`;
    const owner = await getRedisCache().get(lockKey);
    if (owner === fillToken) await getRedisCache().del(lockKey);
  }
}

export async function invalidateLeaderboardSnapshots(...families: SnapshotFamily[]): Promise<void> {
  if (!config.redis.cacheUrl || families.length === 0) return;
  await ensureRedisCacheConnected();
  const pipe = getRedisCache().multi();
  for (const family of families) pipe.incr(`leaderboard:snapshot:generation:${family}`);
  await pipe.exec();
}
