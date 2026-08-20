import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import {
  profilesTable,
  stepSessionsTable,
  stepDailyDeviceTotalsTable,
  stepDailyTotalsTable,
  walkIngestControlTable,
} from "../../db/src/schema/index.js";
import { config } from "./config.js";
import { ensureRedisLiveConnected, getRedisLive } from "./redis.js";
import { logger } from "./logger.js";
import { mirrorStepLeaderboardDay } from "./leaderboardProjection.js";
import { invalidateLeaderboardSnapshots } from "./leaderboardSnapshotCache.js";

export type WalkIngestMode = "postgres" | "redis_shadow" | "redis" | "rehydrating";

export type RedisWalkSubmission = {
  submissionId: string;
  userId: string;
  deviceId: string;
  localDate: string;
  timezone: string;
  sourceClass: "verified";
  totalSteps: number;
  distanceMeters: number;
  caloriesBurned: number;
  activeMinutes: number;
  trackingSessionId?: string | null;
  sessionStartedAtUtc?: Date | null;
  sessionFinal?: boolean;
};

export type RedisWalkDay = {
  epoch: number;
  version: number;
  steps: number;
  distanceMeters: number;
  caloriesBurned: number;
  activeMinutes: number;
  sourceClass: string;
};

const controlKey = "walk:ingest:control";
const dirtyKey = "walk:dirty";
const inFlightKey = "walk:dirty:inflight";
const dirtyAgeKey = "walk:dirty:ages";
const sessionsDueKey = "walk:sessions:due";
const dayKey = (epoch: number, userId: string, date: string) => `walk:day:${epoch}:${userId}:${date}`;
const devicesKey = (epoch: number, userId: string, date: string) => `walk:devices:${epoch}:${userId}:${date}`;
const deviceKey = (epoch: number, userId: string, date: string, deviceId: string) =>
  `walk:device:${epoch}:${userId}:${date}:${deviceId}`;
const versionKey = (epoch: number, userId: string, date: string) => `walk:version:${epoch}:${userId}:${date}`;

const APPLY_WALK_LUA = `
local liveEpoch = tonumber(redis.call("HGET", KEYS[1], "epoch") or "-1")
local mode = redis.call("HGET", KEYS[1], "mode") or "postgres"
local suppliedEpoch = tonumber(ARGV[1])
if liveEpoch ~= suppliedEpoch then
  return cjson.encode({ok=false, reason="epoch_mismatch", liveEpoch=liveEpoch})
end
if mode ~= "redis" and mode ~= "redis_shadow" then
  return cjson.encode({ok=false, reason="authority_not_redis", mode=mode})
end

local oldSteps = tonumber(redis.call("HGET", KEYS[3], "steps") or "0")
local oldDistance = tonumber(redis.call("HGET", KEYS[3], "distanceMeters") or "0")
local oldCalories = tonumber(redis.call("HGET", KEYS[3], "caloriesBurned") or "0")
local oldActive = tonumber(redis.call("HGET", KEYS[3], "activeMinutes") or "0")
local newSteps = math.max(oldSteps, tonumber(ARGV[4]))
local newDistance = math.max(oldDistance, tonumber(ARGV[5]))
local newCalories = math.max(oldCalories, tonumber(ARGV[6]))
local newActive = math.max(oldActive, tonumber(ARGV[7]))

local daySteps = math.min(200000, tonumber(redis.call("HGET", KEYS[2], "steps") or "0") + (newSteps - oldSteps))
local dayDistance = tonumber(redis.call("HGET", KEYS[2], "distanceMeters") or "0") + (newDistance - oldDistance)
local dayCalories = tonumber(redis.call("HGET", KEYS[2], "caloriesBurned") or "0") + (newCalories - oldCalories)
local dayActive = math.max(tonumber(redis.call("HGET", KEYS[2], "activeMinutes") or "0"), newActive)
local version = redis.call("INCR", KEYS[4])

redis.call("HSET", KEYS[3], "steps", newSteps, "distanceMeters", newDistance,
  "caloriesBurned", newCalories, "activeMinutes", newActive, "sourceClass", ARGV[8],
  "epoch", suppliedEpoch, "version", version, "updatedAtMs", ARGV[9])
redis.call("HSET", KEYS[2], "steps", daySteps, "distanceMeters", dayDistance,
  "caloriesBurned", dayCalories, "activeMinutes", dayActive, "sourceClass", ARGV[8],
  "epoch", suppliedEpoch, "version", version, "timezone", ARGV[3], "updatedAtMs", ARGV[9])
if ARGV[10] ~= "" then
  redis.call("HSET", KEYS[2], "trackingSessionId", ARGV[10], "sessionStartedAtUtc", ARGV[11],
    "sessionFinal", ARGV[12], "sessionLastActivityAtMs", ARGV[9])
  redis.call("ZADD", KEYS[7], ARGV[12] == "1" and ARGV[9] or (tonumber(ARGV[9]) + 900000), ARGV[14])
end
redis.call("SADD", KEYS[5], ARGV[2])
redis.call("SADD", KEYS[6], ARGV[13])
redis.call("ZADD", KEYS[8], "NX", ARGV[9], ARGV[2])
return cjson.encode({ok=true, epoch=suppliedEpoch, version=version, steps=daySteps,
  distanceMeters=dayDistance, caloriesBurned=dayCalories, activeMinutes=dayActive, sourceClass=ARGV[8]})
`;

const CLAIM_DIRTY_LUA = `
local expired = redis.call("ZRANGEBYSCORE", KEYS[2], "-inf", ARGV[1])
for _, member in ipairs(expired) do
  redis.call("ZREM", KEYS[2], member)
  redis.call("SADD", KEYS[1], member)
end
local members = redis.call("SPOP", KEYS[1], tonumber(ARGV[2]))
if type(members) == "string" then members = {members} end
for _, member in ipairs(members) do redis.call("ZADD", KEYS[2], ARGV[3], member) end
return members
`;

export function isWalkCanaryUser(userId: string): boolean {
  const percent = config.features.redisWalkCanaryPercent;
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  let hash = 2166136261;
  for (let i = 0; i < userId.length; i += 1) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100 < percent;
}

export async function syncWalkIngestControlFromPostgres(): Promise<{ mode: WalkIngestMode; epoch: number }> {
  const [row] = await db.select().from(walkIngestControlTable).where(eq(walkIngestControlTable.id, 1)).limit(1);
  const control = { mode: (row?.mode ?? "postgres") as WalkIngestMode, epoch: Number(row?.epoch ?? 1) };
  if (config.redis.liveUrl) {
    await ensureRedisLiveConnected();
    await getRedisLive().hset(controlKey, { mode: control.mode, epoch: String(control.epoch) });
  }
  return control;
}

export async function getRedisWalkControl(): Promise<{ mode: WalkIngestMode; epoch: number } | null> {
  if (!config.redis.liveUrl) return null;
  await ensureRedisLiveConnected();
  const value = await getRedisLive().hmget(controlKey, "mode", "epoch");
  if (!value[0] || !value[1]) return null;
  return { mode: value[0] as WalkIngestMode, epoch: Number(value[1]) };
}

export async function applyRedisWalkSubmission(input: RedisWalkSubmission): Promise<RedisWalkDay> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.deviceId)) throw new Error("invalid_device_id");
  const control = await getRedisWalkControl();
  if (!control || (control.mode !== "redis" && control.mode !== "redis_shadow")) {
    throw new Error("redis_walk_not_authoritative");
  }
  const dirtyMember = `${control.epoch}|${input.userId}|${input.localDate}`;
  const nowMs = Date.now();
  const raw = await getRedisLive().eval(
    APPLY_WALK_LUA,
    8,
    controlKey,
    dayKey(control.epoch, input.userId, input.localDate),
    deviceKey(control.epoch, input.userId, input.localDate, input.deviceId),
    versionKey(control.epoch, input.userId, input.localDate),
    dirtyKey,
    devicesKey(control.epoch, input.userId, input.localDate),
    sessionsDueKey,
    dirtyAgeKey,
    String(control.epoch),
    dirtyMember,
    input.timezone,
    String(input.totalSteps),
    String(input.distanceMeters),
    String(input.caloriesBurned),
    String(input.activeMinutes),
    input.sourceClass,
    String(nowMs),
    input.trackingSessionId ?? "",
    input.sessionStartedAtUtc?.toISOString() ?? "",
    input.sessionFinal ? "1" : "0",
    input.deviceId,
    input.trackingSessionId ? `${input.userId}:${input.trackingSessionId}` : "",
  );
  const result = JSON.parse(String(raw)) as RedisWalkDay & { ok?: boolean; reason?: string };
  if (!result.ok) throw new Error(result.reason ?? "redis_walk_rejected");
  return result;
}

export async function seedRedisShadowDayIfMissing(input: {
  epoch: number; userId: string; localDate: string; deviceId: string;
  day: { steps: number; distanceMeters: number; caloriesBurned: number; activeMinutes: number; sourceClass: string } | null;
  device: { steps: number; distanceMeters: number; caloriesBurned: number; activeMinutes: number; sourceClass: string } | null;
}): Promise<void> {
  await ensureRedisLiveConnected();
  const redis = getRedisLive();
  const key = dayKey(input.epoch, input.userId, input.localDate);
  if (await redis.exists(key)) return;
  const version = 0;
  const pipe = redis.multi();
  pipe.hsetnx(key, "epoch", String(input.epoch));
  if (input.day) pipe.hset(key, {
    epoch: String(input.epoch), version: String(version), steps: String(input.day.steps),
    distanceMeters: String(input.day.distanceMeters), caloriesBurned: String(input.day.caloriesBurned),
    activeMinutes: String(input.day.activeMinutes), sourceClass: input.day.sourceClass,
  });
  if (input.device) {
    pipe.sadd(devicesKey(input.epoch, input.userId, input.localDate), input.deviceId);
    pipe.hset(deviceKey(input.epoch, input.userId, input.localDate, input.deviceId), {
      epoch: String(input.epoch), version: String(version), steps: String(input.device.steps),
      distanceMeters: String(input.device.distanceMeters), caloriesBurned: String(input.device.caloriesBurned),
      activeMinutes: String(input.device.activeMinutes), sourceClass: input.device.sourceClass,
    });
  }
  await pipe.exec();
}

export async function getRedisWalkDay(userId: string, localDate: string): Promise<RedisWalkDay | null> {
  const control = await getRedisWalkControl();
  if (!control || control.mode !== "redis") return null;
  const row = await getRedisLive().hgetall(dayKey(control.epoch, userId, localDate));
  if (!row?.version || Number(row.epoch) !== control.epoch) return null;
  return {
    epoch: Number(row.epoch), version: Number(row.version), steps: Number(row.steps),
    distanceMeters: Number(row.distanceMeters), caloriesBurned: Number(row.caloriesBurned),
    activeMinutes: Number(row.activeMinutes), sourceClass: row.sourceClass ?? "verified",
  };
}

async function claimDirtyWalkDays(limit = 250): Promise<string[]> {
  await ensureRedisLiveConnected();
  const nowMs = Date.now();
  const raw = await getRedisLive().eval(CLAIM_DIRTY_LUA, 2, dirtyKey, inFlightKey,
    String(nowMs), String(limit), String(nowMs + 90_000));
  return Array.isArray(raw) ? raw.map(String) : [];
}

async function checkpointOne(member: string): Promise<void> {
  const [epochRaw, userId, localDate] = member.split("|");
  const epoch = Number(epochRaw);
  if (!epoch || !userId || !localDate) throw new Error("invalid_dirty_member");
  const redis = getRedisLive();
  const [day, deviceIds] = await Promise.all([
    redis.hgetall(dayKey(epoch, userId, localDate)),
    redis.smembers(devicesKey(epoch, userId, localDate)),
  ]);
  if (!day.version) return;
  const version = Number(day.version);
  const devices: Array<Record<string, string> & { deviceId: string }> = await Promise.all(
    deviceIds.map(async (deviceId) => {
      const values = await redis.hgetall(deviceKey(epoch, userId, localDate, deviceId));
      return { deviceId, ...values };
    }),
  );

  let shadowMismatch: { postgres: number; redis: number } | null = null;
  let projection: { previousSteps: number; steps: number; lifetime?: number } | null = null;
  await db.transaction(async (tx) => {
    const [control] = await tx.select().from(walkIngestControlTable)
      .where(eq(walkIngestControlTable.id, 1)).for("update").limit(1);
    if (!control || Number(control.epoch) !== epoch || !["redis", "redis_shadow"].includes(control.mode)) return;

    const [previous] = await tx.select().from(stepDailyTotalsTable)
      .where(and(eq(stepDailyTotalsTable.userId, userId), eq(stepDailyTotalsTable.date, localDate)))
      .for("update").limit(1);
    if (control.mode === "redis_shadow") {
      const redisSteps = Math.min(200000, Number(day.steps ?? 0));
      if ((previous?.steps ?? 0) !== redisSteps) shadowMismatch = { postgres: previous?.steps ?? 0, redis: redisSteps };
      return;
    }
    if (previous && (Number(previous.ingestEpoch) > epoch
      || (Number(previous.ingestEpoch) === epoch && Number(previous.ingestVersion) >= version))) return;

    for (const device of devices) {
      await tx.insert(stepDailyDeviceTotalsTable).values({
        userId, date: localDate, deviceId: device.deviceId,
        steps: Number(device.steps ?? 0), distanceMeters: Number(device.distanceMeters ?? 0),
        caloriesBurned: Number(device.caloriesBurned ?? 0), activeMinutes: Number(device.activeMinutes ?? 0),
        sourceClass: device.sourceClass ?? "verified", ingestEpoch: epoch, ingestVersion: version,
      }).onConflictDoUpdate({
        target: [stepDailyDeviceTotalsTable.userId, stepDailyDeviceTotalsTable.date, stepDailyDeviceTotalsTable.deviceId],
        set: {
          steps: Number(device.steps ?? 0), distanceMeters: Number(device.distanceMeters ?? 0),
          caloriesBurned: Number(device.caloriesBurned ?? 0), activeMinutes: Number(device.activeMinutes ?? 0),
          sourceClass: device.sourceClass ?? "verified", ingestEpoch: epoch, ingestVersion: version,
          updatedAt: new Date(),
        },
      });
    }

    const nextSteps = Math.min(200000, Number(day.steps ?? 0));
    const persistedDelta = nextSteps - (previous?.steps ?? 0);
    await tx.insert(stepDailyTotalsTable).values({
      userId, date: localDate, steps: nextSteps, distanceMeters: Number(day.distanceMeters ?? 0),
      caloriesBurned: Number(day.caloriesBurned ?? 0), activeMinutes: Number(day.activeMinutes ?? 0),
      sourceClass: day.sourceClass ?? "verified", ingestEpoch: epoch, ingestVersion: version,
    }).onConflictDoUpdate({
      target: [stepDailyTotalsTable.userId, stepDailyTotalsTable.date],
      set: {
        steps: nextSteps, distanceMeters: Number(day.distanceMeters ?? 0),
        caloriesBurned: Number(day.caloriesBurned ?? 0), activeMinutes: Number(day.activeMinutes ?? 0),
        sourceClass: day.sourceClass ?? "verified", ingestEpoch: epoch, ingestVersion: version,
        updatedAt: new Date(),
      },
    });
    if (persistedDelta !== 0) {
      const [profile] = await tx.update(profilesTable).set({
        totalSteps: sql`GREATEST(0, ${profilesTable.totalSteps} + ${persistedDelta})`, updatedAt: new Date(),
      }).where(eq(profilesTable.id, userId)).returning({ totalSteps: profilesTable.totalSteps });
      projection = { previousSteps: previous?.steps ?? 0, steps: nextSteps, lifetime: profile?.totalSteps };
    } else {
      projection = { previousSteps: previous?.steps ?? 0, steps: nextSteps };
    }
    if (day.trackingSessionId) {
      const sessionKey = `${userId}:${day.trackingSessionId}`;
      const startedAt = day.sessionStartedAtUtc ? new Date(day.sessionStartedAtUtc) : new Date(Number(day.updatedAtMs));
      const lastActivityAt = new Date(Number(day.sessionLastActivityAtMs ?? day.updatedAtMs));
      const isFinal = day.sessionFinal === "1" || lastActivityAt.getTime() <= Date.now() - 15 * 60_000;
      await tx.insert(stepSessionsTable).values({
        userId, ingestSessionKey: sessionKey, steps: nextSteps,
        distanceMeters: Number(day.distanceMeters ?? 0), caloriesBurned: Number(day.caloriesBurned ?? 0),
        durationSeconds: Math.max(0, Math.floor((lastActivityAt.getTime() - startedAt.getTime()) / 1000)),
        startedAt, endedAt: isFinal ? lastActivityAt : null, lastActivityAt, sessionFinal: isFinal,
        isSynced: true, source: "verified_health", isVerifiedSource: true,
      }).onConflictDoUpdate({
        target: [stepSessionsTable.ingestSessionKey],
        set: {
          steps: nextSteps, distanceMeters: Number(day.distanceMeters ?? 0),
          caloriesBurned: Number(day.caloriesBurned ?? 0),
          durationSeconds: Math.max(0, Math.floor((lastActivityAt.getTime() - startedAt.getTime()) / 1000)),
          endedAt: isFinal ? lastActivityAt : sql`${stepSessionsTable.endedAt}`, lastActivityAt,
          sessionFinal: sql`${stepSessionsTable.sessionFinal} OR ${isFinal}`,
          isSynced: true, isVerifiedSource: true,
        },
      });
    }
    await tx.execute(sql`
      INSERT INTO walking_group_daily_steps
        (id, group_id, user_id, step_date, daily_steps, verified_steps, calories, distance_meters, last_synced_at, created_at, updated_at)
      SELECT gen_random_uuid()::text, m.group_id, ${userId}, ${localDate}::date, ${nextSteps},
        CASE WHEN ${day.sourceClass ?? "verified"} = 'verified' THEN ${nextSteps} ELSE 0 END,
        ${Number(day.caloriesBurned ?? 0)}, ${Number(day.distanceMeters ?? 0)}, now(), now(), now()
      FROM walking_group_members m
      JOIN walking_groups g ON g.id = m.group_id AND g.status = 'active'
      WHERE m.user_id = ${userId} AND m.status = 'active'
      ON CONFLICT (group_id, user_id, step_date) DO UPDATE SET
        daily_steps = EXCLUDED.daily_steps, verified_steps = EXCLUDED.verified_steps,
        calories = EXCLUDED.calories, distance_meters = EXCLUDED.distance_meters,
        last_synced_at = now(), updated_at = now()
    `);
  });

  if (shadowMismatch) {
    const mismatch = shadowMismatch as { postgres: number; redis: number };
    logger.warn({ member, postgres: mismatch.postgres, redis: mismatch.redis }, "walk shadow divergence");
  }
  if (projection) {
    const value = projection as { previousSteps: number; steps: number; lifetime?: number };
    void mirrorStepLeaderboardDay({ userId, localDate, ...value }).catch(() => {});
  }
  void invalidateLeaderboardSnapshots("group").catch(() => {});

  await redis.zrem(inFlightKey, member);
  const retentionSeconds = 72 * 60 * 60;
  const remainsDirty = await redis.sismember(dirtyKey, member);
  if (!remainsDirty) await redis.zrem(dirtyAgeKey, member);
  const expiry = redis.multi();
  const retain = (key: string) => remainsDirty ? expiry.persist(key) : expiry.expire(key, retentionSeconds);
  retain(dayKey(epoch, userId, localDate));
  retain(devicesKey(epoch, userId, localDate));
  retain(versionKey(epoch, userId, localDate));
  for (const deviceId of deviceIds) retain(deviceKey(epoch, userId, localDate, deviceId));
  await expiry.exec();
}

export async function checkpointWalkDays(): Promise<number> {
  if (!config.redis.liveUrl) return 0;
  await finalizeDueWalkSessions();
  const claimed = await claimDirtyWalkDays();
  let completed = 0;
  for (const member of claimed) {
    try {
      await checkpointOne(member);
      completed += 1;
    } catch (err) {
      logger.error({ err, member }, "walk checkpoint failed; lease will retry");
    }
  }
  return completed;
}

export async function getWalkDirtyHealth(): Promise<{
  dirtyCount: number; inFlightCount: number; oldestDirtyAgeMs: number | null; oldestExpiredLeaseAgeMs: number | null;
}> {
  if (!config.redis.liveUrl) return { dirtyCount: 0, inFlightCount: 0, oldestDirtyAgeMs: null, oldestExpiredLeaseAgeMs: null };
  await ensureRedisLiveConnected();
  const redis = getRedisLive();
  const [dirtyCount, inFlightCount, oldestDirty, oldestLease] = await Promise.all([
    redis.scard(dirtyKey), redis.zcard(inFlightKey), redis.zrange(dirtyAgeKey, 0, 0, "WITHSCORES"),
    redis.zrange(inFlightKey, 0, 0, "WITHSCORES"),
  ]);
  const now = Date.now();
  return {
    dirtyCount, inFlightCount,
    oldestDirtyAgeMs: oldestDirty[1] ? Math.max(0, now - Number(oldestDirty[1])) : null,
    oldestExpiredLeaseAgeMs: oldestLease[1] ? Math.max(0, now - Number(oldestLease[1])) : null,
  };
}

export type WalkWatermark = { userId: string; localDate: string; epoch: number; version: number };

export async function captureWalkSettlementWatermarks(
  days: Array<{ userId: string; localDate: string }>,
): Promise<WalkWatermark[]> {
  const captured = await Promise.all(days.map(async (day) => {
    const value = await getRedisWalkDay(day.userId, day.localDate);
    return value ? { ...day, epoch: value.epoch, version: value.version } : null;
  }));
  return captured.filter((value): value is WalkWatermark => value !== null);
}

export async function satisfyWalkSettlementBarrier(watermarks: WalkWatermark[]): Promise<void> {
  for (const watermark of watermarks) {
    await checkpointOne(`${watermark.epoch}|${watermark.userId}|${watermark.localDate}`);
  }
  for (const watermark of watermarks) {
    const [row] = await db.select({ epoch: stepDailyTotalsTable.ingestEpoch, version: stepDailyTotalsTable.ingestVersion })
      .from(stepDailyTotalsTable)
      .where(and(eq(stepDailyTotalsTable.userId, watermark.userId), eq(stepDailyTotalsTable.date, watermark.localDate)))
      .limit(1);
    if (!row || Number(row.epoch) < watermark.epoch
      || (Number(row.epoch) === watermark.epoch && Number(row.version) < watermark.version)) {
      throw new Error(`walk_settlement_barrier_unsatisfied:${watermark.userId}:${watermark.localDate}`);
    }
  }
}

/** Stop new Redis acknowledgements, drain, then advance PostgreSQL authority to a fresh epoch. */
export async function switchWalkAuthorityToPostgres(reason: string): Promise<number> {
  await ensureRedisLiveConnected();
  const current = await syncWalkIngestControlFromPostgres();
  await getRedisLive().hset(controlKey, { mode: "rehydrating", epoch: String(current.epoch) });
  for (let pass = 0; pass < 20; pass += 1) {
    if ((await checkpointWalkDays()) === 0) break;
  }
  const dirty = await getWalkDirtyHealth();
  if (dirty.dirtyCount > 0 || dirty.inFlightCount > 0) {
    throw new Error(`walk_authority_drain_incomplete:${dirty.dirtyCount}:${dirty.inFlightCount}`);
  }
  const [updated] = await db.update(walkIngestControlTable).set({
    mode: "postgres", epoch: current.epoch + 1, changedAt: new Date(), reason,
  }).where(and(eq(walkIngestControlTable.id, 1), eq(walkIngestControlTable.epoch, current.epoch)))
    .returning({ epoch: walkIngestControlTable.epoch });
  if (!updated) throw new Error("walk_authority_changed_concurrently");
  await getRedisLive().hset(controlKey, { mode: "postgres", epoch: String(updated.epoch) });
  return Number(updated.epoch);
}

/**
 * Begin a Redis shadow/serve epoch. Serving is allowed only after callers have reseeded and
 * reconciled the affected current days, so this helper intentionally installs rehydrating first.
 */
export async function beginWalkRedisRehydration(reason: string): Promise<number> {
  const [control] = await db.select().from(walkIngestControlTable).where(eq(walkIngestControlTable.id, 1)).limit(1);
  if (!control) throw new Error("walk_ingest_control_missing");
  const nextEpoch = Number(control.epoch) + 1;
  await db.update(walkIngestControlTable).set({ mode: "rehydrating", epoch: nextEpoch, changedAt: new Date(), reason })
    .where(eq(walkIngestControlTable.id, 1));
  await ensureRedisLiveConnected();
  await getRedisLive().hset(controlKey, { mode: "rehydrating", epoch: String(nextEpoch) });
  return nextEpoch;
}

export async function completeWalkRedisRehydration(
  epoch: number,
  shadow: boolean,
  reason: string,
  expectedDays: Array<{ userId: string; localDate: string }>,
): Promise<void> {
  await ensureRedisLiveConnected();
  for (const day of expectedDays) {
    const seededEpoch = await getRedisLive().hget(dayKey(epoch, day.userId, day.localDate), "epoch");
    if (Number(seededEpoch) !== epoch) throw new Error(`walk_rehydration_missing_day:${day.userId}:${day.localDate}`);
  }
  const mode: WalkIngestMode = shadow ? "redis_shadow" : "redis";
  const updated = await db.update(walkIngestControlTable).set({ mode, changedAt: new Date(), reason })
    .where(and(eq(walkIngestControlTable.id, 1), eq(walkIngestControlTable.epoch, epoch), eq(walkIngestControlTable.mode, "rehydrating")))
    .returning({ id: walkIngestControlTable.id });
  if (updated.length === 0) throw new Error("walk_rehydration_epoch_mismatch");
  await getRedisLive().hset(controlKey, { mode, epoch: String(epoch) });
}

export async function seedWalkDayFromPostgres(epoch: number, userId: string, localDate: string): Promise<void> {
  const [[day], devices] = await Promise.all([
    db.select().from(stepDailyTotalsTable)
      .where(and(eq(stepDailyTotalsTable.userId, userId), eq(stepDailyTotalsTable.date, localDate))).limit(1),
    db.select().from(stepDailyDeviceTotalsTable)
      .where(and(eq(stepDailyDeviceTotalsTable.userId, userId), eq(stepDailyDeviceTotalsTable.date, localDate))),
  ]);
  await ensureRedisLiveConnected();
  const redis = getRedisLive();
  const version = Math.max(1, Number(day?.ingestVersion ?? 0));
  const pipeline = redis.multi();
  pipeline.hset(dayKey(epoch, userId, localDate), {
    epoch: String(epoch), version: String(version), steps: String(day?.steps ?? 0),
    distanceMeters: String(day?.distanceMeters ?? 0), caloriesBurned: String(day?.caloriesBurned ?? 0),
    activeMinutes: String(day?.activeMinutes ?? 0), sourceClass: day?.sourceClass ?? "verified",
    updatedAtMs: String(Date.now()),
  });
  pipeline.set(versionKey(epoch, userId, localDate), String(version));
  for (const device of devices) {
    pipeline.sadd(devicesKey(epoch, userId, localDate), device.deviceId);
    pipeline.hset(deviceKey(epoch, userId, localDate, device.deviceId), {
      epoch: String(epoch), version: String(version), steps: String(device.steps),
      distanceMeters: String(device.distanceMeters), caloriesBurned: String(device.caloriesBurned),
      activeMinutes: String(device.activeMinutes), sourceClass: device.sourceClass,
    });
  }
  await pipeline.exec();
}

export async function scheduleWalkSessionFinalization(ingestSessionKey: string, lastActivityAt: Date, final: boolean): Promise<void> {
  if (!config.redis.liveUrl) return;
  await ensureRedisLiveConnected();
  const dueAt = final ? lastActivityAt.getTime() : lastActivityAt.getTime() + 15 * 60_000;
  await getRedisLive().zadd(sessionsDueKey, dueAt, ingestSessionKey);
}

async function finalizeDueWalkSessions(): Promise<number> {
  const redis = getRedisLive();
  const now = new Date();
  const keys = await redis.zrangebyscore(sessionsDueKey, "-inf", now.getTime(), "LIMIT", 0, 250);
  if (keys.length === 0) return 0;
  await db.update(stepSessionsTable).set({
    sessionFinal: true,
    endedAt: sql`COALESCE(${stepSessionsTable.lastActivityAt}, ${now})`,
  }).where(and(
    inArray(stepSessionsTable.ingestSessionKey, keys),
    eq(stepSessionsTable.sessionFinal, false),
    sql`${stepSessionsTable.lastActivityAt} <= ${new Date(now.getTime() - 15 * 60_000)}`,
  ));
  await redis.zrem(sessionsDueKey, ...keys);
  return keys.length;
}
