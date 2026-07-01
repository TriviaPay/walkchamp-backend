import { logger } from "./logger.js";
import { recoverStaleRaces, cleanupOverdueRaces } from "../routes/races.js";
import { startScheduler } from "./scheduler.js";
import { startSponsoredEventsJob } from "../routes/sponsoredEvents.js";

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

  startScheduler();
  startSponsoredEventsJob();
}
