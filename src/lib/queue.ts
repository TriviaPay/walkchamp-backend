import { logger } from "./logger.js";

export type QueueJobSpec = {
  name: string;
  handler: () => Promise<void>;
};

// Queue scaffolding for the BullMQ migration. The actual worker intentionally
// stays fail-safe until Redis credentials are configured in deployment.
export function getQueueRetryPolicy() {
  return {
    attempts: 5,
    backoff: {
      type: "exponential" as const,
      delay: 1_000,
    },
  };
}

export async function runIdempotentJob(job: QueueJobSpec) {
  try {
    await job.handler();
  } catch (err) {
    logger.error({ err, job: job.name }, "[Queue] job failed");
    throw err;
  }
}
