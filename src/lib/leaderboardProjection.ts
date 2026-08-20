import { config } from "./config.js";
import { ensureRedisCacheConnected, getRedisCache } from "./redis.js";

const pointerKey = "leaderboard:active_namespace";
const defaultNamespace = "v1";

function namespaceReadyKey(namespace: string): string {
  return `leaderboard:namespace:${namespace}:ready`;
}

function assertValidNamespace(namespace: string): void {
  if (!/^v[0-9A-Za-z_-]{1,63}$/.test(namespace)) {
    throw new Error("invalid_leaderboard_namespace");
  }
}

function monthKey(localDate: string): string { return localDate.slice(0, 7); }
function weekKey(localDate: string): string {
  const value = new Date(`${localDate}T00:00:00Z`);
  const weekday = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() - weekday + 1);
  return value.toISOString().slice(0, 10);
}

export async function activeLeaderboardNamespace(): Promise<string> {
  await ensureRedisCacheConnected();
  return (await getRedisCache().get(pointerKey)) ?? defaultNamespace;
}

export async function mirrorStepLeaderboardDay(input: {
  userId: string; localDate: string; previousSteps: number; steps: number; lifetime?: number;
}): Promise<void> {
  if (!config.features.redisLeaderboardMirrorWrite || !config.redis.cacheUrl) return;
  await ensureRedisCacheConnected();
  const ns = await activeLeaderboardNamespace();
  const redis = getRedisCache();
  const delta = input.steps - input.previousSteps;
  const pipe = redis.multi();
  pipe.zadd(`lb:${ns}:steps:day:${input.localDate}`, -input.steps, input.userId);
  if (delta !== 0) {
    pipe.zincrby(`lb:${ns}:steps:week:${weekKey(input.localDate)}`, -delta, input.userId);
    pipe.zincrby(`lb:${ns}:steps:month:${monthKey(input.localDate)}`, -delta, input.userId);
  }
  if (input.lifetime != null) pipe.zadd(`lb:${ns}:steps:all_time`, -input.lifetime, input.userId);
  pipe.expire(`lb:${ns}:steps:day:${input.localDate}`, 72 * 60 * 60);
  pipe.expire(`lb:${ns}:steps:week:${weekKey(input.localDate)}`, 21 * 24 * 60 * 60);
  pipe.expire(`lb:${ns}:steps:month:${monthKey(input.localDate)}`, 62 * 24 * 60 * 60);
  await pipe.exec();
}

export async function readStepProjectionIds(key: string, limit = 100): Promise<Array<{ userId: string; steps: number }>> {
  await ensureRedisCacheConnected();
  const ns = await activeLeaderboardNamespace();
  const flat = await getRedisCache().zrange(`lb:${ns}:steps:${key}`, 0, limit - 1, "WITHSCORES");
  const rows: Array<{ userId: string; steps: number }> = [];
  for (let i = 0; i < flat.length; i += 2) rows.push({ userId: flat[i], steps: -Number(flat[i + 1]) });
  return rows;
}

export async function readStepProjectionRanking(input: {
  key: string; userId: string; friendIds?: string[] | null; limit?: number;
}): Promise<Array<{ userId: string; steps: number; rank: number }> | null> {
  if (!config.features.redisLeaderboardServe || !config.redis.cacheUrl) return null;
  await ensureRedisCacheConnected();
  const ns = await activeLeaderboardNamespace();
  const key = `lb:${ns}:steps:${input.key}`;
  const redis = getRedisCache();
  // A partially populated namespace is never authoritative. Mirror writes may
  // continue while a backfill is running, but reads remain on PostgreSQL until
  // reconciliation explicitly marks this namespace ready.
  if (await redis.get(namespaceReadyKey(ns)) !== "1") return null;
  if (await redis.exists(key) !== 1) return null;
  if (input.friendIds) {
    const scores = await redis.zmscore(key, ...input.friendIds);
    return input.friendIds.flatMap((userId, index) => scores[index] == null
      ? [] : [{ userId, steps: -Number(scores[index]), rank: 0 }])
      .sort((a, b) => b.steps - a.steps || a.userId.localeCompare(b.userId))
      .map((row, index) => ({ ...row, rank: index + 1 }));
  }
  const limit = input.limit ?? 100;
  const flat = await redis.zrange(key, 0, limit - 1, "WITHSCORES");
  const rows: Array<{ userId: string; steps: number; rank: number }> = [];
  for (let i = 0; i < flat.length; i += 2) rows.push({ userId: flat[i], steps: -Number(flat[i + 1]), rank: i / 2 + 1 });
  if (!rows.some((row) => row.userId === input.userId)) {
    const [rank, score] = await Promise.all([redis.zrank(key, input.userId), redis.zscore(key, input.userId)]);
    if (rank != null && score != null) rows.push({ userId: input.userId, steps: -Number(score), rank: rank + 1 });
  }
  return rows;
}

export async function setLeaderboardNamespaceReady(namespace: string, ready: boolean): Promise<void> {
  assertValidNamespace(namespace);
  await ensureRedisCacheConnected();
  const redis = getRedisCache();
  if (ready) await redis.set(namespaceReadyKey(namespace), "1");
  else await redis.del(namespaceReadyKey(namespace));
}

export async function switchLeaderboardNamespace(namespace: string): Promise<void> {
  assertValidNamespace(namespace);
  await ensureRedisCacheConnected();
  const redis = getRedisCache();
  if (await redis.get(namespaceReadyKey(namespace)) !== "1") {
    throw new Error("leaderboard_namespace_not_ready");
  }
  await redis.set(pointerKey, namespace);
}
