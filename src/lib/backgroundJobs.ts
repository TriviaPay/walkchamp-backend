import { logger } from "./logger.js";
import { recoverStaleRaces, cleanupOverdueRaces, recoverPendingRedisFinishes } from "../routes/races.js";
import { startScheduler, runSchedulerTick } from "./scheduler.js";
import { startSponsoredEventsJob } from "../routes/sponsoredEvents.js";
import { runDepositReconciliationTick } from "./depositSettlement.js";
import { runWalletLedgerReconciliationTick } from "./walletLedgerReconciliation.js";
import { flushSessionLastSeen } from "./sessionService.js";
import { checkpointRedisRaces } from "./raceLiveHydration.js";

let started = false;

/**
 * Runs every backstop sequentially inside one compute wake. Each step is independently
 * guarded so a single failure cannot skip the rest of the pass.
 */
async function runCoalescedMaintenancePass(): Promise<void> {
  const steps: [string, () => Promise<unknown>][] = [
    ["cleanupOverdueRaces", () => cleanupOverdueRaces({ force: true })],
    ["depositReconciliation", () => runDepositReconciliationTick(new Date(), { force: true })],
    ["scheduler", () => runSchedulerTick({ force: true })],
    ["walletLedgerReconciliation", () => runWalletLedgerReconciliationTick()],
  ];

  for (const [name, run] of steps) {
    try {
      await run();
    } catch (err) {
      logger.error({ err, step: name }, "maintenance pass step failed");
    }
  }
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

  // Single coalesced maintenance wake — deliberately ONE timer, not one per job.
  //
  // Every gated tick above skips Postgres while idle, so the only thing still able to wake a
  // suspended Neon compute is this backstop. Neon restarts its inactivity timer on *any*
  // activity, so each separate hourly timer would cost a full autosuspend tail (~5 min by
  // default): four independent hourly backstops firing at different offsets bill ~4× the idle
  // compute of one. Running them back-to-back in a single wake pays that tail once an hour.
  //
  // Everything here is forced: it is the recovery path that re-derives every Redis hint from
  // DB truth, bounding drift from a lost key or a missed writer hook to at most one hour.
  // If you add another periodic DB job, add it to this pass — do not add a timer.
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
  startSponsoredEventsJob();
}
