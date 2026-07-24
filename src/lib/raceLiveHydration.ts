import { and, desc, eq, lt, ne } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import { raceRoomsTable, raceParticipantsTable, profilesTable } from "../../db/src/schema/index.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { getRedisLive, ensureRedisLiveConnected } from "./redis.js";
import { SPONSORED_EVENT_TARGET_STEPS } from "./sponsoredEventRules.js";
import { listActiveRaces } from "./raceRegistry.js";
import {
  hydrateRace,
  addParticipant,
  isRaceHydrated,
  getRaceConfig,
  drainDirtyParticipants,
  getParticipantsState,
  LIVE_RACE_STATE,
  type LiveParticipantSeed,
} from "./raceLiveState.js";

export type LiveStateMode = "postgres" | "redis";

/**
 * Storage engine for a race that is STARTING now. Redis only when the canary flag is on AND a
 * live instance is configured; otherwise legacy Postgres. Immutable once a race starts — a
 * later flag flip only affects future races (so in-flight races never change engine mid-run).
 */
export function resolveLiveStateModeForNewRace(): LiveStateMode {
  return config.features.redisLiveRaceEnabled && config.redis.liveUrl ? "redis" : "postgres";
}

function targetStepsFor(room: { type: string; targetSteps: number }): number {
  return room.type === "sponsored" ? SPONSORED_EVENT_TARGET_STEPS : room.targetSteps;
}

async function loadRaceForHydration(raceId: string) {
  const [room] = await db
    .select({
      id: raceRoomsTable.id,
      type: raceRoomsTable.type,
      status: raceRoomsTable.status,
      targetSteps: raceRoomsTable.targetSteps,
      startedAt: raceRoomsTable.startedAt,
      challengeEndAt: raceRoomsTable.challengeEndAt,
      liveStateMode: raceRoomsTable.liveStateMode,
      liveStateVersion: raceRoomsTable.liveStateVersion,
    })
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.id, raceId))
    .limit(1);
  return room ?? null;
}

async function loadParticipantSeeds(raceId: string): Promise<LiveParticipantSeed[]> {
  const rows = await db
    .select({
      id: raceParticipantsTable.id,
      userId: raceParticipantsTable.userId,
      username: profilesTable.username,
      currentSteps: raceParticipantsTable.currentSteps,
      raceBaselineSteps: raceParticipantsTable.raceBaselineSteps,
      lastStepSequenceId: raceParticipantsTable.lastStepSequenceId,
      finishedGoal: raceParticipantsTable.finishedGoal,
      finishRank: raceParticipantsTable.finishRank,
    })
    .from(raceParticipantsTable)
    .innerJoin(profilesTable, eq(profilesTable.id, raceParticipantsTable.userId))
    .where(and(
      eq(raceParticipantsTable.raceRoomId, raceId),
      ne(raceParticipantsTable.status, "left"),
      ne(raceParticipantsTable.status, "forfeited"),
    ));
  // Collapse duplicate participant rows to the highest steps per user.
  const byUser = new Map<string, LiveParticipantSeed>();
  for (const r of rows) {
    const prev = byUser.get(r.userId);
    const seed: LiveParticipantSeed = {
      userId: r.userId,
      participantId: r.id,
      username: r.username ?? "Runner",
      currentSteps: r.currentSteps,
      raceBaselineSteps: r.raceBaselineSteps ?? 0,
      lastStepSequenceId: r.lastStepSequenceId ?? -1,
      finishedGoal: r.finishedGoal,
      finishRank: r.finishRank ?? null,
    };
    if (!prev || seed.currentSteps > prev.currentSteps) byUser.set(r.userId, seed);
  }
  return [...byUser.values()];
}

async function hydrateFromRoom(
  room: NonNullable<Awaited<ReturnType<typeof loadRaceForHydration>>>,
): Promise<void> {
  const participants = await loadParticipantSeeds(room.id);
  await hydrateRace(
    room.id,
    {
      status: LIVE_RACE_STATE.ACTIVE,
      startedAtMs: room.startedAt?.getTime() ?? Date.now(),
      challengeEndAtMs: room.challengeEndAt?.getTime() ?? null,
      targetSteps: targetStepsFor(room),
      type: room.type,
      liveStateVersion: room.liveStateVersion,
    },
    participants,
  );
}

/**
 * Seed a freshly-started race into redis-live. Called right after the start transaction
 * commits. No-op unless the race was recorded as `redis` mode. Best-effort at this point —
 * the progress path lazily re-hydrates (ensureRaceHydrated) if this did not land.
 */
export async function initializeRaceLiveState(raceId: string): Promise<void> {
  try {
    // Route through the lock-protected path so a concurrent first-tick ensureRaceHydrated and
    // this initializer cannot both hydrate and overwrite an accepted tick's steps.
    const ok = await ensureRaceHydrated(raceId);
    if (ok) logger.info({ raceId }, "[raceLiveHydration] initialized live state in redis-live");
  } catch (err) {
    logger.error({ err, raceId }, "[raceLiveHydration] initializeRaceLiveState failed");
  }
}

/**
 * Ensure a single participant exists in an active redis-mode race's live state. Used when a
 * progress tick arrives for someone not yet in the hash (late join / sponsored auto-create /
 * first sync after a restart). Returns true if the participant is now present in redis; false
 * if they don't exist in Postgres yet (caller should fall back to the Postgres path, which
 * auto-creates them — the next tick will then hydrate them here).
 */
export async function ensureParticipantHydrated(raceId: string, userId: string): Promise<boolean> {
  try {
    if (!(await isRaceHydrated(raceId))) return false;
    const [row] = await db
      .select({
        id: raceParticipantsTable.id,
        username: profilesTable.username,
        currentSteps: raceParticipantsTable.currentSteps,
        raceBaselineSteps: raceParticipantsTable.raceBaselineSteps,
        lastStepSequenceId: raceParticipantsTable.lastStepSequenceId,
        finishedGoal: raceParticipantsTable.finishedGoal,
        finishRank: raceParticipantsTable.finishRank,
        status: raceParticipantsTable.status,
      })
      .from(raceParticipantsTable)
      .innerJoin(profilesTable, eq(profilesTable.id, raceParticipantsTable.userId))
      .where(and(eq(raceParticipantsTable.raceRoomId, raceId), eq(raceParticipantsTable.userId, userId)))
      .orderBy(desc(raceParticipantsTable.currentSteps))
      .limit(1);
    if (!row || row.status === "left" || row.status === "forfeited") return false;
    return await addParticipant(raceId, {
      userId,
      participantId: row.id,
      username: row.username ?? "Runner",
      currentSteps: row.currentSteps,
      raceBaselineSteps: row.raceBaselineSteps ?? 0,
      lastStepSequenceId: row.lastStepSequenceId ?? -1,
      finishedGoal: row.finishedGoal,
      finishRank: row.finishRank ?? null,
    });
  } catch (err) {
    logger.error({ err, raceId, userId }, "[raceLiveHydration] ensureParticipantHydrated failed");
    return false;
  }
}

/**
 * Periodic checkpoint: flush changed participants from redis-live to Postgres so a redis-live
 * loss bounds data loss to one interval. Sequence-fenced via a monotonic-steps guard — an old
 * checkpoint can never overwrite a newer value (steps only advance), so it cannot clobber a
 * finish that already bumped steps. DB-silent when no races are active or nothing changed, so
 * idle periods stay off Postgres.
 */
export async function checkpointRedisRaces(): Promise<void> {
  // Gate on redis-live being configured, NOT the feature flag: races that STARTED in redis mode
  // must keep checkpointing even after the flag is turned off, or a redis-live loss would cause
  // unbounded data loss for those in-flight races.
  if (!config.redis.liveUrl) return;
  const raceIds = await listActiveRaces();
  for (const raceId of raceIds) {
    try {
      if (!(await isRaceHydrated(raceId))) continue;
      // Don't checkpoint a race that's finalizing/frozen — the finalize flush owns those rows.
      const cfg = await getRaceConfig(raceId);
      if (cfg && cfg.status !== LIVE_RACE_STATE.ACTIVE) continue;
      const dirty = await drainDirtyParticipants(raceId);
      if (dirty.length === 0) continue;
      const states = await getParticipantsState(raceId, dirty);
      await db.transaction(async (tx) => {
        for (let i = 0; i < dirty.length; i += 1) {
          const steps = Number(states[i]?.currentSteps);
          if (!Number.isFinite(steps)) continue;
          await tx
            .update(raceParticipantsTable)
            .set({ currentSteps: steps })
            .where(and(
              eq(raceParticipantsTable.raceRoomId, raceId),
              eq(raceParticipantsTable.userId, dirty[i]),
              lt(raceParticipantsTable.currentSteps, steps),
            ));
        }
      });
    } catch (err) {
      logger.error({ err, raceId }, "[raceLiveHydration] checkpoint failed");
    }
  }
}

/**
 * Guarantee an active redis-mode race is hydrated, hydrating ONCE under a short Redis lock so
 * concurrent progress requests don't each rebuild it. Returns true when live state is present
 * and usable. Returns false for postgres-mode races or if hydration could not be established.
 */
export async function ensureRaceHydrated(raceId: string): Promise<boolean> {
  try {
    if (await isRaceHydrated(raceId)) return true;

    const room = await loadRaceForHydration(raceId);
    // Only (re)hydrate an active redis-mode race. A completed/cancelled race must never be
    // resurrected into ACTIVE live state — let such ticks fall through to the Postgres path.
    if (!room || room.liveStateMode !== "redis" || room.status !== "in_progress") return false;

    await ensureRedisLiveConnected();
    const lockKey = `hydrate-lock:race:${raceId}`;
    const acquired = await getRedisLive().set(lockKey, "1", "EX", 10, "NX");
    if (!acquired) {
      // Another worker/request is hydrating; treat as available if it lands, else caller falls
      // back to degraded handling.
      return await isRaceHydrated(raceId);
    }
    try {
      if (await isRaceHydrated(raceId)) return true; // double-check under lock
      await hydrateFromRoom(room);
      return true;
    } finally {
      await getRedisLive().del(lockKey).catch(() => {});
    }
  } catch (err) {
    logger.error({ err, raceId }, "[raceLiveHydration] ensureRaceHydrated failed");
    return false;
  }
}
