import { getRedisLive, ensureRedisLiveConnected } from "./redis.js";
import { logger } from "./logger.js";

/**
 * Live race state on the dedicated `redis-live` instance (Phase 2 canary). Holds, per race:
 *
 *   cfg:race:{id}            HASH  — status, startedAtMs, targetSteps, type, liveStateVersion
 *   lb:race:{id}             ZSET  — member=userId, score=currentSteps (live leaderboard)
 *   p:race:{id}:{userId}     HASH  — full participant state (steps, sequence, baseline, device
 *                                    fields, finish status/ordinal) — enough to reproduce the
 *                                    Postgres progress path with zero SQL on the hot path
 *   dirty:race:{id}          SET   — userIds changed since the last checkpoint (2h)
 *   finish:pending:{id}      ZSET  — member=userId, score=finishAcceptOrdinal (2f recovery)
 *   race:{id}:finishOrdinal  INT   — monotonic server-acceptance counter for finish ordering
 *
 * Postgres remains authoritative for settlement; this is the live tier plus a rebuildable
 * cache. All step acceptance runs in ONE Lua script so validation (sequence monotonicity,
 * cumulative rate cap, baseline/backfill, goal crossing + ordinal assignment) is atomic.
 */

// Kept in lockstep with the Postgres path in routes/races.ts.
export const LIVE_STEPS_PER_SECOND = 6;
export const LIVE_STEP_BURST = 200;

export const LIVE_RACE_STATE = {
  ACTIVE: "active",
  FINALIZING: "finalizing",
  FROZEN: "frozen",
  FINALIZED: "finalized",
} as const;
export type LiveRaceState = (typeof LIVE_RACE_STATE)[keyof typeof LIVE_RACE_STATE];

const cfgKey = (raceId: string) => `cfg:race:${raceId}`;
const lbKey = (raceId: string) => `lb:race:${raceId}`;
const pKey = (raceId: string, userId: string) => `p:race:${raceId}:${userId}`;
const dirtyKey = (raceId: string) => `dirty:race:${raceId}`;
const pendingFinishKey = (raceId: string) => `finish:pending:${raceId}`;
const finishOrdinalKey = (raceId: string) => `race:${raceId}:finishOrdinal`;
const namesKey = (raceId: string) => `names:race:${raceId}`; // userId -> username, for zero-SQL display

export type LiveRaceConfig = {
  status: LiveRaceState;
  startedAtMs: number;
  challengeEndAtMs: number | null;
  targetSteps: number;
  type: string;
  liveStateVersion: number;
};

export type LiveParticipantSeed = {
  userId: string;
  participantId: string;
  username: string;
  currentSteps: number;
  raceBaselineSteps: number;
  lastStepSequenceId: number;
  finishedGoal: boolean;
  /** Authoritative finish rank/ordinal from Postgres (for rehydrating an already-finished user). */
  finishRank: number | null;
};

export type ApplyProgressInput = {
  raceId: string;
  userId: string;
  /** Absolute client-reported race steps (already floored). */
  requestedSteps: number;
  /** Monotonic client sequence id, or null when not provided. */
  clientSeq: number | null;
  /** Device-wide total steps for baseline/backfill, or null. */
  deviceTotal: number | null;
  nowMs: number;
};

export type ApplyProgressResult =
  | { ok: false; reason: "not_hydrated" | "not_active"; status?: string }
  | {
      ok: true;
      accepted: boolean;
      reason?: string;
      newSteps: number;
      pendingReconciliation: boolean;
      justFinished: boolean;
      finishOrdinal: number | null;
      finishedGoal: boolean;
      participantId: string | null;
    };

export type LiveStanding = { userId: string; steps: number; rank: number };

// ── Lua: atomic step acceptance ───────────────────────────────────────────────
// KEYS: 1 cfg, 2 participant, 3 leaderboard, 4 dirty-set, 5 finish-ordinal, 6 pending-finish
// ARGV: 1 userId, 2 requestedSteps, 3 clientSeq(-1=none), 4 deviceTotal(-1=none),
//       5 nowMs, 6 stepsPerSec, 7 burst
const APPLY_PROGRESS_LUA = `
local function tomap(flat)
  local m = {}
  for i = 1, #flat, 2 do m[flat[i]] = flat[i + 1] end
  return m
end

local cfg = tomap(redis.call("HGETALL", KEYS[1]))
if cfg.status == nil then
  return cjson.encode({ ok = false, reason = "not_hydrated" })
end
if cfg.status ~= "active" then
  return cjson.encode({ ok = false, reason = "not_active", status = cfg.status })
end

local p = tomap(redis.call("HGETALL", KEYS[2]))
if p.currentSteps == nil then
  return cjson.encode({ ok = false, reason = "not_hydrated" })
end

local requested = tonumber(ARGV[2])
local clientSeq = tonumber(ARGV[3])
local deviceTotal = tonumber(ARGV[4])
local nowMs = tonumber(ARGV[5])
local rate = tonumber(ARGV[6])
local burst = tonumber(ARGV[7])

local currentSteps = tonumber(p.currentSteps) or 0
local lastSeq = tonumber(p.lastStepSequenceId) or -1
local baseline = tonumber(p.raceBaselineSteps) or 0
local finishedGoal = p.finishedGoal == "1"
local targetSteps = tonumber(cfg.targetSteps) or 0
local startedAtMs = tonumber(cfg.startedAtMs) or nowMs

-- Sequence dedup: stale/duplicate syncs are ignored (matches Postgres monotonic guard).
if clientSeq >= 0 and clientSeq <= lastSeq then
  return cjson.encode({ ok = true, accepted = false, reason = "stale_sequence",
    newSteps = currentSteps, pendingReconciliation = false, justFinished = false,
    finishOrdinal = tonumber(p.finishAcceptOrdinal or "-1"), finishedGoal = finishedGoal,
    participantId = p.participantId })
end

-- Baseline registration + backend-derived recovery from device totals.
local newBaseline = baseline
if deviceTotal >= 0 then
  if baseline == 0 then
    newBaseline = deviceTotal
  else
    local derived = deviceTotal - baseline
    if derived < 0 then derived = 0 end
    if derived > requested then requested = derived end
  end
end

-- Monotonic absolute assignment (sequence-guarded, never a bare last-writer-wins).
local newSteps = currentSteps
if requested > newSteps then newSteps = requested end

-- Cumulative rate cap: clamp implausible totals, flag for reconciliation.
local elapsedSec = (nowMs - startedAtMs) / 1000
if elapsedSec < 0 then elapsedSec = 0 end
local maxCum = math.ceil(elapsedSec * rate) + burst
local pendingRecon = false
if newSteps > maxCum then
  pendingRecon = true
  if maxCum > currentSteps then newSteps = maxCum else newSteps = currentSteps end
end

-- Goal crossing: assign a monotonic server-acceptance ordinal atomically and record the
-- pending finish so the finalizer/worker can discover it even if Postgres write is delayed.
local justFinished = false
local finishOrdinal = tonumber(p.finishAcceptOrdinal or "-1")
if (not finishedGoal) and targetSteps > 0 and newSteps >= targetSteps then
  justFinished = true
  finishedGoal = true
  finishOrdinal = redis.call("INCR", KEYS[5])
  redis.call("ZADD", KEYS[6], finishOrdinal, ARGV[1])
  redis.call("HSET", KEYS[2], "finishStatus", "pending", "finishAcceptOrdinal", finishOrdinal,
    "finishAcceptedAtMs", nowMs, "finishedGoal", "1")
end

redis.call("HSET", KEYS[2],
  "currentSteps", newSteps,
  "raceBaselineSteps", newBaseline,
  "lastStepSyncAtMs", nowMs,
  "lastServerAcceptMs", nowMs)
if clientSeq >= 0 then redis.call("HSET", KEYS[2], "lastStepSequenceId", clientSeq) end
if deviceTotal >= 0 then
  redis.call("HSET", KEYS[2], "lastDeviceTotalSteps", deviceTotal, "lastDeviceTimeMs", nowMs)
end

redis.call("ZADD", KEYS[3], newSteps, ARGV[1])
redis.call("SADD", KEYS[4], ARGV[1])

return cjson.encode({ ok = true, accepted = true, newSteps = newSteps,
  pendingReconciliation = pendingRecon, justFinished = justFinished,
  finishOrdinal = finishOrdinal, finishedGoal = finishedGoal,
  participantId = p.participantId })
`;

/** True when a race's live config hash exists (i.e. it has been hydrated into redis-live). */
export async function isRaceHydrated(raceId: string): Promise<boolean> {
  await ensureRedisLiveConnected();
  return (await getRedisLive().exists(cfgKey(raceId))) === 1;
}

/**
 * Seed a race's live state from Postgres truth. Idempotent-ish: overwrites the config and
 * (re)creates participant hashes + leaderboard. Called at race start and on lazy recovery.
 */
export async function hydrateRace(
  raceId: string,
  cfg: LiveRaceConfig,
  participants: LiveParticipantSeed[],
): Promise<void> {
  await ensureRedisLiveConnected();
  const redis = getRedisLive();
  const pipe = redis.multi();
  pipe.hset(cfgKey(raceId), {
    status: cfg.status,
    startedAtMs: String(cfg.startedAtMs),
    challengeEndAtMs: cfg.challengeEndAtMs != null ? String(cfg.challengeEndAtMs) : "",
    targetSteps: String(cfg.targetSteps),
    type: cfg.type,
    liveStateVersion: String(cfg.liveStateVersion),
  });
  let maxFinishOrdinal = 0;
  for (const p of participants) {
    const fields: Record<string, string> = {
      participantId: p.participantId,
      currentSteps: String(p.currentSteps),
      raceBaselineSteps: String(p.raceBaselineSteps),
      lastStepSequenceId: String(p.lastStepSequenceId),
      finishedGoal: p.finishedGoal ? "1" : "0",
    };
    // Restore finish ordinal/status for an already-finished participant so the live board orders
    // them correctly and the Lua won't re-finish them.
    if (p.finishedGoal && p.finishRank != null) {
      fields.finishAcceptOrdinal = String(p.finishRank);
      fields.finishStatus = "official";
      if (p.finishRank > maxFinishOrdinal) maxFinishOrdinal = p.finishRank;
    }
    pipe.hset(pKey(raceId, p.userId), fields);
    pipe.zadd(lbKey(raceId), p.currentSteps, p.userId);
    pipe.hset(namesKey(raceId), p.userId, p.username);
    if (p.currentSteps > 0) pipe.sadd(dirtyKey(raceId), p.userId);
  }
  // Resume the ordinal counter past existing finishers so new finishes get unique, ordered ranks.
  if (maxFinishOrdinal > 0) pipe.set(finishOrdinalKey(raceId), String(maxFinishOrdinal));
  await pipe.exec();
}

/**
 * Add a single participant to an already-hydrated race (late join / sponsored auto-create /
 * post-restart first sync). Only writes the participant hash + leaderboard + name if the race
 * config exists; returns false when the race is not hydrated so the caller can fall back.
 */
export async function addParticipant(raceId: string, seed: LiveParticipantSeed): Promise<boolean> {
  await ensureRedisLiveConnected();
  const redis = getRedisLive();
  if ((await redis.exists(cfgKey(raceId))) !== 1) return false;
  const fields: Record<string, string> = {
    participantId: seed.participantId,
    currentSteps: String(seed.currentSteps),
    raceBaselineSteps: String(seed.raceBaselineSteps),
    lastStepSequenceId: String(seed.lastStepSequenceId),
    finishedGoal: seed.finishedGoal ? "1" : "0",
  };
  if (seed.finishedGoal && seed.finishRank != null) {
    fields.finishAcceptOrdinal = String(seed.finishRank);
    fields.finishStatus = "official";
  }
  await redis
    .multi()
    .hset(pKey(raceId, seed.userId), fields)
    .zadd(lbKey(raceId), seed.currentSteps, seed.userId)
    .hset(namesKey(raceId), seed.userId, seed.username)
    .exec();
  return true;
}

/** Apply a step update atomically via Lua. Returns the validated outcome. */
export async function applyProgress(input: ApplyProgressInput): Promise<ApplyProgressResult> {
  await ensureRedisLiveConnected();
  const raw = await getRedisLive().eval(
    APPLY_PROGRESS_LUA,
    6,
    cfgKey(input.raceId),
    pKey(input.raceId, input.userId),
    lbKey(input.raceId),
    dirtyKey(input.raceId),
    finishOrdinalKey(input.raceId),
    pendingFinishKey(input.raceId),
    input.userId,
    String(Math.floor(input.requestedSteps)),
    String(input.clientSeq ?? -1),
    String(input.deviceTotal ?? -1),
    String(input.nowMs),
    String(LIVE_STEPS_PER_SECOND),
    String(LIVE_STEP_BURST),
  );
  return JSON.parse(raw as string) as ApplyProgressResult;
}

/** Top-N live standings from the leaderboard ZSET (highest steps first). */
export async function getStandings(raceId: string, limit = 20): Promise<LiveStanding[]> {
  await ensureRedisLiveConnected();
  const flat = await getRedisLive().zrevrange(lbKey(raceId), 0, limit - 1, "WITHSCORES");
  const out: LiveStanding[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    out.push({ userId: flat[i], steps: Number(flat[i + 1]), rank: i / 2 + 1 });
  }
  return out;
}

export type LiveStandingFull = {
  userId: string;
  username: string;
  raceSteps: number;
  rank: number;
  finishedGoal: boolean;
  finishRank: number | null;
};

/**
 * Contract-compatible live standings (matches getLiveRaceStandings shape) built entirely from
 * redis-live — zero SQL. Reads the top-N by steps from the ZSET, resolves usernames from the
 * names hash, pulls finish info from participant hashes, then applies the same
 * finishers-first-by-finishRank ordering the Postgres path uses.
 */
export async function getStandingsWithNames(raceId: string, limit = 20): Promise<LiveStandingFull[]> {
  await ensureRedisLiveConnected();
  const redis = getRedisLive();
  const flat = await redis.zrevrange(lbKey(raceId), 0, limit - 1, "WITHSCORES");
  const userIds: string[] = [];
  const steps: number[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    userIds.push(flat[i]);
    steps.push(Number(flat[i + 1]));
  }
  if (userIds.length === 0) return [];

  const names = await redis.hmget(namesKey(raceId), ...userIds);
  const pipe = redis.multi();
  for (const uid of userIds) pipe.hmget(pKey(raceId, uid), "finishedGoal", "finishAcceptOrdinal");
  const finishRes = (await pipe.exec()) ?? [];

  const rows = userIds.map((userId, idx) => {
    const finish = (finishRes[idx]?.[1] as Array<string | null> | undefined) ?? [null, null];
    return {
      userId,
      username: names[idx] ?? "Runner",
      raceSteps: steps[idx],
      rank: 0,
      finishedGoal: finish[0] === "1",
      finishRank: finish[1] != null ? Number(finish[1]) : null,
    };
  });
  rows.sort((a, b) => {
    if (a.finishedGoal && b.finishedGoal) return (a.finishRank ?? 999) - (b.finishRank ?? 999);
    if (a.finishedGoal !== b.finishedGoal) return a.finishedGoal ? -1 : 1;
    if (b.raceSteps !== a.raceSteps) return b.raceSteps - a.raceSteps;
    return a.userId.localeCompare(b.userId);
  });
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

/** A single participant's rank (1-based) and steps, or null if absent. */
export async function getParticipantRank(
  raceId: string,
  userId: string,
): Promise<{ rank: number; steps: number } | null> {
  await ensureRedisLiveConnected();
  const redis = getRedisLive();
  const [rank, score] = await Promise.all([
    redis.zrevrank(lbKey(raceId), userId),
    redis.zscore(lbKey(raceId), userId),
  ]);
  if (rank == null || score == null) return null;
  return { rank: rank + 1, steps: Number(score) };
}

/** Full snapshot of every participant's steps (for checkpoint / final flush to Postgres). */
export async function snapshotRace(raceId: string): Promise<Array<{ userId: string; steps: number }>> {
  await ensureRedisLiveConnected();
  const flat = await getRedisLive().zrevrange(lbKey(raceId), 0, -1, "WITHSCORES");
  const out: Array<{ userId: string; steps: number }> = [];
  for (let i = 0; i < flat.length; i += 2) out.push({ userId: flat[i], steps: Number(flat[i + 1]) });
  return out;
}

/** Set the race lifecycle state (active → finalizing → frozen → finalized). */
export async function setRaceState(raceId: string, state: LiveRaceState): Promise<void> {
  await ensureRedisLiveConnected();
  await getRedisLive().hset(cfgKey(raceId), "status", state);
}

/** Read the current live config, or null when not hydrated. */
export async function getRaceConfig(raceId: string): Promise<LiveRaceConfig | null> {
  await ensureRedisLiveConnected();
  const m = await getRedisLive().hgetall(cfgKey(raceId));
  if (!m || !m.status) return null;
  return {
    status: m.status as LiveRaceState,
    startedAtMs: Number(m.startedAtMs),
    challengeEndAtMs: m.challengeEndAtMs ? Number(m.challengeEndAtMs) : null,
    targetSteps: Number(m.targetSteps),
    type: m.type,
    liveStateVersion: Number(m.liveStateVersion),
  };
}

/** Total participants currently on the live leaderboard (ZCARD). */
export async function getParticipantCount(raceId: string): Promise<number> {
  await ensureRedisLiveConnected();
  return getRedisLive().zcard(lbKey(raceId));
}

/**
 * Cross-process broadcast coalescing lease. Returns true at most once per ttlMs per race across
 * all API replicas, so per-tick leaderboard broadcasts collapse to ~1 per window (the next
 * broadcast always carries the latest ZSET state). Finish events bypass this — they are rare
 * and must always be delivered.
 */
export async function tryAcquireBroadcastLease(raceId: string, ttlMs = 750): Promise<boolean> {
  await ensureRedisLiveConnected();
  const res = await getRedisLive().set(`bcast:race:${raceId}`, "1", "PX", ttlMs, "NX");
  return res === "OK";
}

/** Pending (unpersisted) finishes ordered by acceptance ordinal — for 2f recovery. */
export async function getPendingFinishes(raceId: string): Promise<Array<{ userId: string; ordinal: number }>> {
  await ensureRedisLiveConnected();
  const flat = await getRedisLive().zrange(pendingFinishKey(raceId), 0, -1, "WITHSCORES");
  const out: Array<{ userId: string; ordinal: number }> = [];
  for (let i = 0; i < flat.length; i += 2) out.push({ userId: flat[i], ordinal: Number(flat[i + 1]) });
  return out;
}

/** Mark a finish officially persisted (removes it from the pending set). */
export async function markFinishOfficial(raceId: string, userId: string): Promise<void> {
  await ensureRedisLiveConnected();
  const redis = getRedisLive();
  await redis
    .multi()
    .zrem(pendingFinishKey(raceId), userId)
    .hset(pKey(raceId, userId), "finishStatus", "official")
    .exec();
}

/** Drain the dirty-participant set (userIds changed since last checkpoint) atomically. */
export async function drainDirtyParticipants(raceId: string): Promise<string[]> {
  await ensureRedisLiveConnected();
  const redis = getRedisLive();
  const [members] = (await redis.multi().smembers(dirtyKey(raceId)).del(dirtyKey(raceId)).exec()) as [
    [Error | null, string[]],
    [Error | null, number],
  ];
  return members?.[1] ?? [];
}

/** Fetch selected participant hashes (full recovery state) for checkpointing. */
export async function getParticipantsState(
  raceId: string,
  userIds: string[],
): Promise<Array<Record<string, string>>> {
  if (userIds.length === 0) return [];
  await ensureRedisLiveConnected();
  const redis = getRedisLive();
  const pipe = redis.multi();
  for (const userId of userIds) pipe.hgetall(pKey(raceId, userId));
  const res = await pipe.exec();
  return (res ?? []).map(([, hash]) => (hash as Record<string, string>) ?? {});
}

/** Best-effort cleanup of a finalized race's live keys. */
export async function clearRaceLiveState(raceId: string, userIds: string[]): Promise<void> {
  try {
    await ensureRedisLiveConnected();
    const redis = getRedisLive();
    const pipe = redis.multi();
    pipe.del(cfgKey(raceId), lbKey(raceId), dirtyKey(raceId), pendingFinishKey(raceId), finishOrdinalKey(raceId), namesKey(raceId));
    for (const userId of userIds) pipe.del(pKey(raceId, userId));
    await pipe.exec();
  } catch (err) {
    logger.warn({ err, raceId }, "[raceLiveState] clearRaceLiveState failed (non-fatal)");
  }
}
