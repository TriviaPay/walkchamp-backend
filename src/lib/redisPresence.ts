import { eq } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import { friendsTable, userPresenceTable } from "../../db/src/schema/index.js";
import { config } from "./config.js";
import { ensureRedisCacheConnected, getRedisCache } from "./redis.js";
import { triggerEvent } from "./pusher.js";
import { logger } from "./logger.js";

export type PresenceStatus = "racing" | "walking" | "online" | "spectating" | "away";
export type PresenceState = { userId: string; status: PresenceStatus | "offline"; revision: number; expiresAt: number };

const ACTIVE_TTL_MS = 75_000;
const deviceKey = (userId: string, deviceId: string) => `presence:device:${userId}:${deviceId}`;
const devicesKey = (userId: string) => `presence:devices:${userId}`;
const deviceStatusesKey = (userId: string) => `presence:device-statuses:${userId}`;
const userKey = (userId: string) => `presence:user:${userId}`;
const revisionKey = (userId: string) => `presence:revision:${userId}`;
const activeKey = "presence:users:active";
const statusKey = (status: PresenceStatus) => `presence:users:${status}`;
const telemetryKey = "presence:telemetry:dirty";
const allStatuses: PresenceStatus[] = ["racing", "walking", "online", "spectating", "away"];

const RECOMPUTE_LUA = `
local userId = ARGV[1]
local deviceId = ARGV[2]
local incoming = ARGV[3]
local nowMs = tonumber(ARGV[4])
local expiresAt = tonumber(ARGV[5])
local operation = ARGV[6]
redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", nowMs)
if operation == "heartbeat" then
  redis.call("HSET", KEYS[1], "status", incoming, "expiresAt", expiresAt)
  redis.call("PEXPIRE", KEYS[1], expiresAt - nowMs + 5000)
  redis.call("ZADD", KEYS[2], expiresAt, deviceId)
  redis.call("HSET", KEYS[3], deviceId, incoming)
else
  redis.call("DEL", KEYS[1])
  redis.call("ZREM", KEYS[2], deviceId)
  redis.call("HDEL", KEYS[3], deviceId)
end
local members = redis.call("ZRANGEBYSCORE", KEYS[2], nowMs, "+inf", "WITHSCORES")
local best = "offline"
local bestRank = 999
local maxExpiry = 0
local rank = {racing=1, walking=2, online=3, spectating=4, away=5}
for i=1,#members,2 do
  local member = members[i]
  local expiry = tonumber(members[i+1])
  local status = redis.call("HGET", KEYS[3], member)
  if status and rank[status] and rank[status] < bestRank then best=status; bestRank=rank[status] end
  if expiry > maxExpiry then maxExpiry=expiry end
end
local old = redis.call("HGET", KEYS[4], "status") or "offline"
for i=7,11 do redis.call("ZREM", KEYS[i], userId) end
redis.call("ZREM", KEYS[6], userId)
if best ~= "offline" then
  redis.call("ZADD", KEYS[6], maxExpiry, userId)
  local offset = ({racing=7, walking=8, online=9, spectating=10, away=11})[best]
  redis.call("ZADD", KEYS[offset], maxExpiry, userId)
end
local revision = tonumber(redis.call("GET", KEYS[5]) or "0")
if old ~= best then revision = redis.call("INCR", KEYS[5]) end
redis.call("HSET", KEYS[4], "status", best, "revision", revision, "expiresAt", maxExpiry)
redis.call("PEXPIRE", KEYS[2], 86400000)
redis.call("PEXPIRE", KEYS[3], 86400000)
redis.call("PEXPIRE", KEYS[4], 86400000)
redis.call("PEXPIRE", KEYS[5], 86400000)
redis.call("HSET", KEYS[12], userId, cjson.encode({status=best, at=nowMs}))
return cjson.encode({userId=userId,status=best,revision=revision,expiresAt=maxExpiry,changed=(old~=best)})
`;

async function mutate(userId: string, deviceId: string, status: PresenceStatus, operation: "heartbeat" | "offline") {
  await ensureRedisCacheConnected();
  const now = Date.now();
  const keys = [deviceKey(userId, deviceId), devicesKey(userId), deviceStatusesKey(userId),
    userKey(userId), revisionKey(userId), activeKey, ...allStatuses.map(statusKey), telemetryKey];
  const raw = await getRedisCache().eval(RECOMPUTE_LUA, keys.length, ...keys,
    userId, deviceId, status, String(now), String(now + ACTIVE_TTL_MS), operation);
  const state = JSON.parse(String(raw)) as PresenceState & { changed: boolean };
  if (state.changed) void notifyFriends(state);
  return state;
}

async function friendIds(userId: string): Promise<string[]> {
  const redis = getRedisCache();
  const key = `presence:friends:${userId}`;
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached) as string[];
  const rows = await db.select({ userId: friendsTable.friendId }).from(friendsTable)
    .where(eq(friendsTable.userId, userId));
  const ids = rows.map((row) => row.userId);
  await redis.set(key, JSON.stringify(ids), "EX", 300);
  return ids;
}

async function notifyFriends(state: PresenceState): Promise<void> {
  try {
    const ids = await friendIds(state.userId);
    await Promise.all(ids.map((friendId) => triggerEvent(`private-user-${friendId}`,
      "presence:friend_changed", state)));
  } catch (err) {
    logger.warn({ err, userId: state.userId }, "presence friend event failed");
  }
}

export async function redisPresenceHeartbeat(userId: string, deviceId: string, status: PresenceStatus) {
  return mutate(userId, deviceId, status, "heartbeat");
}

export async function redisPresenceOffline(userId: string, deviceId: string) {
  return mutate(userId, deviceId, "away", "offline");
}

export async function redisPresenceCounts() {
  await ensureRedisCacheConnected();
  const now = Date.now();
  const redis = getRedisCache();
  const [online, walking, racing, spectating] = await Promise.all([
    redis.zcount(activeKey, now, "+inf"), redis.zcount(statusKey("walking"), now, "+inf"),
    redis.zcount(statusKey("racing"), now, "+inf"), redis.zcount(statusKey("spectating"), now, "+inf"),
  ]);
  return { online, walking, racing, spectating };
}

export async function redisFriendPresenceSnapshot(userId: string): Promise<{ users: PresenceState[]; snapshotRevision: number }> {
  await ensureRedisCacheConnected();
  const ids = await friendIds(userId);
  return redisPresenceSnapshotForIds(ids);
}

export async function redisPresenceSnapshotForIds(ids: string[]): Promise<{ users: PresenceState[]; snapshotRevision: number }> {
  await ensureRedisCacheConnected();
  if (ids.length === 0) return { users: [], snapshotRevision: 0 };
  const redis = getRedisCache();
  const scores = await redis.zmscore(activeKey, ...ids);
  const pipe = redis.multi();
  ids.forEach((id) => pipe.hgetall(userKey(id)));
  const rows = await pipe.exec();
  const now = Date.now();
  const users = ids.flatMap((id, index) => {
    if (Number(scores[index] ?? 0) < now) return [];
    const value = (rows?.[index]?.[1] ?? {}) as Record<string, string>;
    return [{ userId: id, status: (value.status ?? "online") as PresenceState["status"],
      revision: Number(value.revision ?? 0), expiresAt: Number(value.expiresAt ?? scores[index] ?? 0) }];
  });
  return { users, snapshotRevision: Math.max(0, ...users.map((u) => u.revision)) };
}

export async function flushPresenceTelemetry(): Promise<number> {
  if (!config.features.redisPresenceMirrorWrite || !config.redis.cacheUrl) return 0;
  await ensureRedisCacheConnected();
  const redis = getRedisCache();
  const values = await redis.hgetall(telemetryKey);
  const entries = Object.entries(values);
  if (entries.length === 0) return 0;
  const now = new Date();
  await db.transaction(async (tx) => {
    for (const [userId, encoded] of entries) {
      const state = JSON.parse(encoded) as { status?: PresenceState["status"] };
      const status = state.status ?? "offline";
      await tx.insert(userPresenceTable).values({ userId, status, lastSeenAt: now })
        .onConflictDoUpdate({ target: [userPresenceTable.userId], set: { status, lastSeenAt: now } });
    }
  });
  await redis.hdel(telemetryKey, ...entries.map(([id]) => id));
  return entries.length;
}
