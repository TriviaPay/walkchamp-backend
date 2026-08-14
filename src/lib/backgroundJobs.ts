import { logger } from "./logger.js";
import { recoverStaleRaces, cleanupOverdueRaces, recoverPendingRedisFinishes, resettlePendingRaces } from "../routes/races.js";
import { startScheduler, runSchedulerTick } from "./scheduler.js";
import { processSponsuredEvents, autoFillSchedule, nextSponsoredStartAt } from "../routes/sponsoredEvents.js";
import { runDepositReconciliationTick } from "./depositSettlement.js";
import { runWalletLedgerReconciliationTick } from "./walletLedgerReconciliation.js";
import { flushSessionLastSeen } from "./sessionService.js";
import { checkpointRedisRaces } from "./raceLiveHydration.js";

let started = false;

/**
 * Every job that cannot be gated on Redis has to run on *some* timer, and Neon bills a full
 * ~5-minute autosuspend tail per wake regardless of how little SQL that wake issued. So the
 * unit of cost here is the number of distinct timers that touch Postgres, not the number of
 * queries. Two passes, and only two, so the idle cost is bounded at 4 wakes/hour.
 */
const FREQUENT_MAINTENANCE_INTERVAL_MS = 15 * 60_000;

async function runPass(label: string, steps: [string, () => Promise<unknown>][]): Promise<void> {
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (err) {
      logger.error({ err, step: name, pass: label }, "maintenance pass step failed");
    }
  }
}

/**
 * Time-sensitive work, every 15 minutes. These two are ungatable — neither a due sponsored
 * event nor a race owing a deferred payout leaves any trace in Redis for a gate to read, so
 * both must poll. Coalescing them onto one timer means they share a single autosuspend tail
 * instead of paying one each.
 *
 * 15 minutes is the responsiveness/cost trade: a sponsored event can start up to 15 minutes
 * after its scheduledStartAt, and a deferred payout retries within 15 minutes of its grace
 * window (hours) expiring. Shortening this is the main knob if starts need to be punctual —
 * each halving roughly doubles the idle compute bill.
 */
async function runFrequentMaintenancePass(): Promise<void> {
  await runPass("frequent", [
    ["resettlePendingRaces", () => resettlePendingRaces()],
    ["sponsoredEvents", () => processSponsuredEvents()],
    ["armNextSponsoredStart", () => armNextSponsoredStart()],
  ]);
}

let armedSponsoredStart: ReturnType<typeof setTimeout> | null = null;

/**
 * Arms a one-shot wake for the exact moment the next sponsored event is due.
 *
 * Without this, a sponsored event would start up to FREQUENT_MAINTENANCE_INTERVAL_MS late, and
 * for that whole window it is invisible to GET /api/sponsored-events — see nextSponsoredStartAt
 * for why that is user-visible. Sponsored events are rare (two per weekend), so paying one
 * extra compute wake each is nothing next to polling every minute to catch them.
 *
 * Purely a latency optimisation: it can only make a start earlier than the regular pass would,
 * never skip one. If the query fails, the timer never fires, or the process restarts before it
 * does, the next pass still picks the event up.
 */
async function armNextSponsoredStart(): Promise<void> {
  if (armedSponsoredStart) {
    clearTimeout(armedSponsoredStart);
    armedSponsoredStart = null;
  }

  const dueAt = await nextSponsoredStartAt();
  if (!dueAt) return;

  // Anything further out than one pass is left alone — a later pass re-arms it, so a timer is
  // only ever held for a bounded, near-term window rather than across days of drift.
  const delayMs = dueAt.getTime() - Date.now();
  if (delayMs <= 0 || delayMs > FREQUENT_MAINTENANCE_INTERVAL_MS) return;

  armedSponsoredStart = setTimeout(() => {
    armedSponsoredStart = null;
    void runPass("sponsored-start", [["sponsoredEvents", () => processSponsuredEvents()]]);
  }, delayMs);
  armedSponsoredStart.unref?.();
}

/**
 * Backstops, hourly. Everything here is forced: it is the recovery path that re-derives every
 * Redis gate hint from DB truth, bounding drift from a lost key or a missed writer hook to at
 * most one hour. Each step is independently guarded so one failure cannot skip the rest.
 */
async function runCoalescedMaintenancePass(): Promise<void> {
  await runPass("hourly", [
    ["cleanupOverdueRaces", () => cleanupOverdueRaces({ force: true })],
    ["depositReconciliation", () => runDepositReconciliationTick(new Date(), { force: true })],
    ["scheduler", () => runSchedulerTick({ force: true })],
    ["walletLedgerReconciliation", () => runWalletLedgerReconciliationTick()],
    // Populates sponsored rooms 8 weekends out — nothing it creates is needed sooner than
    // days from now, so this cadence is generous rather than tight.
    ["sponsoredAutoFill", () => autoFillSchedule()],
  ]);
}

export async function startWorkerOwnedRecurringJobs(): Promise<void> {
  if (started) return;
  started = true;

  await recoverStaleRaces().catch((err) => {
    logger.error({ err }, "recoverStaleRaces bootstrap failed");
  });

  // Boot recovery: force one full scan to seed the durable active-race registry from DB
  // truth, so the gated 15s tick knows which races are live after a restart/deploy.
  await cleanupOverdueRaces({ force: true }).catch((err) => {
    logger.error({ err }, "cleanupOverdueRaces boot seed failed");
  });

  // Fast tick: gated by the registry — skips the Postgres scan when no races are active,
  // letting Neon compute suspend while idle.
  setInterval(() => {
    cleanupOverdueRaces().catch((err) => {
      logger.error({ err }, "cleanupOverdueRaces tick failed");
    });
  }, 15_000);

  setInterval(() => {
    runDepositReconciliationTick().catch((err) => {
      logger.error({ err }, "deposit reconciliation tick failed");
    });
  }, 60_000);

  runWalletLedgerReconciliationTick().catch((err) => {
    logger.error({ err }, "wallet ledger reconciliation bootstrap failed");
  });

  // Two coalesced maintenance wakes — deliberately TWO timers total, not one per job.
  //
  // Every gated tick above skips Postgres while idle, so these passes are the only things
  // still able to wake a suspended Neon compute. Neon restarts its inactivity timer on *any*
  // activity, so each separate timer costs a full autosuspend tail (~5 min by default):
  // N independent timers firing at different offsets bill ~N× the idle compute of one.
  //
  // If you add another periodic DB job, add it to one of these two passes — do not add a
  // timer. Prefer the hourly pass; use the frequent one only if users can perceive the delay.
  void runFrequentMaintenancePass();
  setInterval(() => {
    void runFrequentMaintenancePass();
  }, FREQUENT_MAINTENANCE_INTERVAL_MS);

  setInterval(() => {
    void runCoalescedMaintenancePass();
  }, 60 * 60_000);

  // Flush buffered session lastSeen telemetry in batches. DB-silent when no sessions are
  // dirty, so it never wakes Neon during idle periods.
  setInterval(() => {
    flushSessionLastSeen().catch((err) => {
      logger.error({ err }, "session lastSeen flush tick failed");
    });
  }, 5 * 60_000);

  // Redis-live checkpointer (Phase 2). Self-gates on redis-live being configured + active
  // races; DB-silent when idle so it never wakes Neon.
  setInterval(() => {
    checkpointRedisRaces().catch((err) => {
      logger.error({ err }, "redis-live checkpoint tick failed");
    });
  }, 45_000);

  // Recover finishes accepted in Redis but not yet persisted to Postgres (crash between
  // accept and durable write). Boot-run once + periodic. Idempotent.
  void recoverPendingRedisFinishes().catch((err) => {
    logger.error({ err }, "redis pending-finish recovery bootstrap failed");
  });
  setInterval(() => {
    recoverPendingRedisFinishes().catch((err) => {
      logger.error({ err }, "redis pending-finish recovery tick failed");
    });
  }, 30_000);

  startScheduler();

  // Boot seed: the hourly pass is otherwise the first autofill, an hour after deploy. Cheap
  // one-off, and it is what bootstraps the schedule on a freshly migrated database.
  void autoFillSchedule().catch((err) => {
    logger.error({ err }, "sponsored autoFill boot seed failed");
  });
}
