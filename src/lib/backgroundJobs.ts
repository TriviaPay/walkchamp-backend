import { logger } from "./logger.js";
import { recoverStaleRaces, cleanupOverdueRaces, recoverPendingRedisFinishes } from "../routes/races.js";
import { startScheduler } from "./scheduler.js";
import { startSponsoredEventsJob } from "../routes/sponsoredEvents.js";
import { runDepositReconciliationTick } from "./depositSettlement.js";
import { runWalletLedgerReconciliationTick } from "./walletLedgerReconciliation.js";
import { flushSessionLastSeen } from "./sessionService.js";
import { checkpointRedisRaces } from "./raceLiveHydration.js";

let started = false;

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

  // Hourly backstop: one unconditional full scan that also re-seeds/reconciles the
  // registry, bounding any drift from a missed start-hook to at most one hour.
  setInterval(() => {
    cleanupOverdueRaces({ force: true }).catch((err) => {
      logger.error({ err }, "cleanupOverdueRaces hourly backstop failed");
    });
  }, 60 * 60_000);

  setInterval(() => {
    runDepositReconciliationTick().catch((err) => {
      logger.error({ err }, "deposit reconciliation tick failed");
    });
  }, 60_000);

  runWalletLedgerReconciliationTick().catch((err) => {
    logger.error({ err }, "wallet ledger reconciliation bootstrap failed");
  });

  setInterval(() => {
    runWalletLedgerReconciliationTick().catch((err) => {
      logger.error({ err }, "wallet ledger reconciliation tick failed");
    });
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
