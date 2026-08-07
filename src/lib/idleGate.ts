import { ensureRedisQueueConnected, getRedisQueue } from "./redis.js";
import { logger } from "./logger.js";

/**
 * Idle gates for the recurring worker ticks that would otherwise touch Postgres on a fixed
 * interval forever. Neon serverless bills compute while it is awake and only suspends after a
 * window of total inactivity, so a query every 60s — even one that finds nothing — pins the
 * compute on 24/7. Measured on this database: 12.5 days of unbroken uptime with `n_tup_upd = 0`
 * on the table the 60s deposit tick was scanning.
 *
 * Same contract as raceRegistry: these keys live on `redis-queue` (noeviction + AOF), are a
 * fast-path HINT only, and every read FAILS OPEN. `null` means "unknown" and callers MUST run
 * the Postgres pass anyway. Postgres stays the source of truth — never gate money on a cache.
 * Correctness is guaranteed by the coalesced hourly maintenance pass (backgroundJobs), which
 * runs every gated job unconditionally and rebuilds these hints from DB truth.
 *
 * Keys are tri-state on purpose. Absent = unknown (Redis was flushed / never seeded) → run.
 * Only an explicit written value may suppress a pass.
 */

const SCHEDULER_NEXT_DUE_KEY = "gate:scheduler-next-due-at-ms";
const DEPOSITS_PENDING_KEY = "gate:deposits-maybe-pending";

async function q() {
  await ensureRedisQueueConnected();
  return getRedisQueue();
}

// ── Scheduler gate ────────────────────────────────────────────────────────────
// Holds the epoch-ms of the earliest moment the scheduler could next have work. Until then
// every tick is a no-op that never opens a Postgres connection.

/** Earliest ms the scheduler may have work, or null when unknown (caller must fail open). */
export async function getSchedulerNextDueAtMs(): Promise<number | null> {
  try {
    const raw = await (await q()).get(SCHEDULER_NEXT_DUE_KEY);
    if (raw == null) return null; // never seeded / flushed → unknown
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch (err) {
    logger.warn({ err }, "[idleGate] getSchedulerNextDueAtMs failed — treat as unknown");
    return null;
  }
}

/**
 * Record the next moment the scheduler could have work. Pass `null` when nothing is pending
 * — stored as a far-future sentinel so ticks stay suppressed until a writer clears the gate
 * or the hourly backstop reseeds it.
 */
export async function setSchedulerNextDueAtMs(atMs: number | null): Promise<void> {
  try {
    const value = atMs == null ? Number.MAX_SAFE_INTEGER : atMs;
    await (await q()).set(SCHEDULER_NEXT_DUE_KEY, String(value));
  } catch (err) {
    logger.warn({ err }, "[idleGate] setSchedulerNextDueAtMs failed (non-fatal)");
  }
}

/**
 * Force the next scheduler tick to run a full Postgres pass. Called by writers that create
 * time-sensitive work (a scheduled room, an unlimited challenge) so the gate cannot hold a
 * stale "nothing due until tomorrow" while new work is waiting.
 */
export async function invalidateSchedulerGate(): Promise<void> {
  try {
    await (await q()).del(SCHEDULER_NEXT_DUE_KEY);
  } catch (err) {
    logger.warn({ err }, "[idleGate] invalidateSchedulerGate failed (non-fatal)");
  }
}

// ── Deposit reconciliation gate ───────────────────────────────────────────────
// Money path: this gate may only ever suppress work when it has positively been told the
// deposit table holds no non-terminal rows. Anything else — missing key, unreadable Redis,
// unparseable value — reconciles.

/** True when deposits may need reconciling, false when known-clear, null when unknown. */
export async function depositsMaybePending(): Promise<boolean | null> {
  try {
    const raw = await (await q()).get(DEPOSITS_PENDING_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null; // absent or unrecognised → unknown → caller reconciles
  } catch (err) {
    logger.warn({ err }, "[idleGate] depositsMaybePending failed — treat as unknown");
    return null;
  }
}

/** Flag that a deposit exists which may need reconciling. Called on every deposit write. */
export async function markDepositsMaybePending(): Promise<void> {
  try {
    await (await q()).set(DEPOSITS_PENDING_KEY, "1");
  } catch (err) {
    logger.warn({ err }, "[idleGate] markDepositsMaybePending failed (non-fatal)");
  }
}

/**
 * Record that Postgres holds zero non-terminal deposits, so the tick may skip until a new
 * deposit is written. Only ever called after a pass has confirmed that against the database.
 */
export async function clearDepositsMaybePending(): Promise<void> {
  try {
    await (await q()).set(DEPOSITS_PENDING_KEY, "0");
  } catch (err) {
    logger.warn({ err }, "[idleGate] clearDepositsMaybePending failed (non-fatal)");
  }
}
