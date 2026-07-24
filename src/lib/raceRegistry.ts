import { getRedisQueue, ensureRedisQueueConnected } from "./redis.js";
import { logger } from "./logger.js";

/**
 * redis-queue client, guaranteed connected first. The client is lazy (lazyConnect) with
 * enableOfflineQueue=false, so issuing a command before the socket is ready throws
 * "Stream isn't writeable" — ensure the connection like the cache/live modules do.
 */
async function q() {
  await ensureRedisQueueConnected();
  return getRedisQueue();
}

/**
 * Durable registry of races that need periodic attention, used to GATE the recurring
 * Postgres scans (cleanupOverdueRaces, the scheduler) so they can skip the database
 * entirely when nothing is live — letting Neon serverless compute suspend when idle.
 *
 * Lives on `redis-queue` (noeviction + AOF), NOT `redis-cache` (allkeys-lfu, which could
 * evict registry keys and cause a missed scan). Every read/count FAILS OPEN: on any Redis
 * error the count is reported as `null`, which callers MUST treat as "unknown → run the
 * scan anyway." The registry is a fast-path optimization, never the source of truth —
 * Postgres is. Correctness is guaranteed by three backstops: boot-time recovery
 * (seedFromActiveRaces), reconciliation inside each scan (reconcileActive/reconcileScheduled),
 * and an hourly unconditional scan.
 */

const ACTIVE_KEY = "registry:active-races"; // ZSET: member=raceId, score=safety-timeout-at ms
const SCHEDULED_KEY = "registry:scheduled-races"; // ZSET: member=raceId, score=scheduledStartAt ms

export type ActiveRaceEntry = { id: string; timeoutAtMs: number };
export type ScheduledRaceEntry = { id: string; startAtMs: number };

/** Mark a race as live so the safety-net cleanup will consider it. Best-effort. */
export async function markRaceActive(raceId: string, timeoutAtMs: number): Promise<void> {
  try {
    await (await q()).zadd(ACTIVE_KEY, timeoutAtMs, raceId);
  } catch (err) {
    logger.warn({ err, raceId }, "[raceRegistry] markRaceActive failed (non-fatal)");
  }
}

/** Remove a race from the active set once finalized. Best-effort (reconcile also removes). */
export async function markRaceInactive(raceId: string): Promise<void> {
  try {
    await (await q()).zrem(ACTIVE_KEY, raceId);
  } catch (err) {
    logger.warn({ err, raceId }, "[raceRegistry] markRaceInactive failed (non-fatal)");
  }
}

/** Mark a race as scheduled so the scheduler will consider it. Best-effort. */
export async function markRaceScheduled(raceId: string, startAtMs: number): Promise<void> {
  try {
    await (await q()).zadd(SCHEDULED_KEY, startAtMs, raceId);
  } catch (err) {
    logger.warn({ err, raceId }, "[raceRegistry] markRaceScheduled failed (non-fatal)");
  }
}

/** Remove a race from the scheduled set once started/cancelled. Best-effort. */
export async function unmarkRaceScheduled(raceId: string): Promise<void> {
  try {
    await (await q()).zrem(SCHEDULED_KEY, raceId);
  } catch (err) {
    logger.warn({ err, raceId }, "[raceRegistry] unmarkRaceScheduled failed (non-fatal)");
  }
}

/** List active race ids from the registry (best-effort; empty on error). */
export async function listActiveRaces(): Promise<string[]> {
  try {
    return await (await q()).zrange(ACTIVE_KEY, 0, -1);
  } catch (err) {
    logger.warn({ err }, "[raceRegistry] listActiveRaces failed");
    return [];
  }
}

/** Active race count, or null when the registry is unavailable (caller must fail open). */
export async function activeRaceCount(): Promise<number | null> {
  try {
    return await (await q()).zcard(ACTIVE_KEY);
  } catch (err) {
    logger.warn({ err }, "[raceRegistry] activeRaceCount failed — treat as unknown");
    return null;
  }
}

/** Scheduled race count, or null when unavailable (caller must fail open). */
export async function scheduledRaceCount(): Promise<number | null> {
  try {
    return await (await q()).zcard(SCHEDULED_KEY);
  } catch (err) {
    logger.warn({ err }, "[raceRegistry] scheduledRaceCount failed — treat as unknown");
    return null;
  }
}

async function reconcile(key: string, currentIds: Map<string, number>): Promise<void> {
  try {
    const redis = (await q());
    const existing = await redis.zrange(key, 0, -1);
    const stale = existing.filter((id) => !currentIds.has(id));
    const pipeline = redis.multi();
    if (stale.length > 0) pipeline.zrem(key, ...stale);
    for (const [id, score] of currentIds) pipeline.zadd(key, score, id);
    await pipeline.exec();
  } catch (err) {
    logger.warn({ err, key }, "[raceRegistry] reconcile failed (non-fatal)");
  }
}

/**
 * Reconcile the active set to exactly the DB truth: removes finalized races and (re)adds
 * currently in-progress ones. Diff-based (no wholesale DELETE) so a concurrently-added
 * entry is never wiped mid-reconcile.
 */
export async function reconcileActive(entries: ActiveRaceEntry[]): Promise<void> {
  await reconcile(ACTIVE_KEY, new Map(entries.map((e) => [e.id, e.timeoutAtMs])));
}

/** Reconcile the scheduled set to exactly the DB truth. */
export async function reconcileScheduled(entries: ScheduledRaceEntry[]): Promise<void> {
  await reconcile(SCHEDULED_KEY, new Map(entries.map((e) => [e.id, e.startAtMs])));
}
