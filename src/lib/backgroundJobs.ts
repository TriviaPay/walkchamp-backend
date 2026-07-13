import { logger } from "./logger.js";
import { recoverStaleRaces, cleanupOverdueRaces } from "../routes/races.js";
import { startScheduler } from "./scheduler.js";
import { startSponsoredEventsJob } from "../routes/sponsoredEvents.js";
import { runDepositReconciliationTick } from "./depositSettlement.js";
import { runWalletLedgerReconciliationTick } from "./walletLedgerReconciliation.js";

let started = false;

export async function startWorkerOwnedRecurringJobs(): Promise<void> {
  if (started) return;
  started = true;

  await recoverStaleRaces().catch((err) => {
    logger.error({ err }, "recoverStaleRaces bootstrap failed");
  });

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

  setInterval(() => {
    runWalletLedgerReconciliationTick().catch((err) => {
      logger.error({ err }, "wallet ledger reconciliation tick failed");
    });
  }, 60 * 60_000);

  startScheduler();
  startSponsoredEventsJob();
}
