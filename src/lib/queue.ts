import { Queue, Worker, type JobsOptions, type Processor } from "bullmq";
import { logger } from "./logger.js";
import { config } from "./config.js";
import { shouldPauseNoncriticalQueueEnqueue } from "./redisRuntimeValidation.js";

export type QueueJobSpec = {
  name: string;
  handler: () => Promise<void>;
};

export type AppQueueName =
  | "notifications"
  | "media-cleanup"
  | "webhook-processing"
  | "scheduled-jobs"
  | "coin-reconciliation"
  | "race-finalization"
  | "achievement-evaluation"
  | "refund-processing";

const queues = new Map<AppQueueName, Queue>();
const workers: Worker[] = [];

type QueueConnectionRole = "producer" | "worker";

export function queueConnectionOptions(
  role: QueueConnectionRole = "producer",
  urlOverride?: string,
) {
  const url = urlOverride ?? config.redis.queueUrl;
  if (!url) {
    throw new Error("REDIS_QUEUE_URL or REDIS_URL is not configured.");
  }
  const parsed = new URL(url);
  const db = parsed.pathname && parsed.pathname !== "/"
    ? Number(parsed.pathname.slice(1))
    : undefined;
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: Number.isFinite(db) ? db : undefined,
    tls: parsed.protocol === "rediss:" ? {} : undefined,
    enableOfflineQueue: role === "worker",
    maxRetriesPerRequest: role === "worker" ? null : 1,
    connectTimeout: config.runtime.redisCommandTimeoutMs,
    commandTimeout: role === "worker" ? undefined : config.runtime.queueEnqueueTimeoutMs,
  };
}

export function getQueueRetryPolicy() {
  return {
    attempts: 5,
    backoff: {
      type: "exponential" as const,
      delay: 1_000,
    },
  };
}

export function getQueueRetentionPolicy() {
  return {
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: { age: 604_800, count: 10_000 },
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export function getAppQueue(name: AppQueueName): Queue {
  const existing = queues.get(name);
  if (existing) return existing;

  const queue = new Queue(name, {
    connection: queueConnectionOptions("producer"),
    defaultJobOptions: {
      ...getQueueRetryPolicy(),
      ...getQueueRetentionPolicy(),
    },
  });
  queues.set(name, queue);
  return queue;
}

export async function enqueueJob(
  queueName: AppQueueName,
  jobName: string,
  data: Record<string, unknown>,
  options?: JobsOptions & { critical?: boolean },
) {
  if (!options?.critical && await shouldPauseNoncriticalQueueEnqueue()) {
    throw new Error("redis-queue memory gate is active; noncritical enqueue paused");
  }

  const queue = getAppQueue(queueName);
  const { critical: _critical, ...jobOptions } = options ?? {};
  return withTimeout(
    queue.add(jobName, data, {
      ...getQueueRetryPolicy(),
      ...getQueueRetentionPolicy(),
      ...jobOptions,
    }),
    config.runtime.queueEnqueueTimeoutMs,
    "BullMQ enqueue timed out",
  );
}

export function startQueueWorker<T = Record<string, unknown>>(
  queueName: AppQueueName,
  processor: Processor<T>,
  options?: { concurrency?: number },
): Worker<T> {
  const worker = new Worker<T>(queueName, processor, {
    connection: queueConnectionOptions("worker"),
    concurrency: options?.concurrency ?? 2,
  });

  worker.on("failed", (job, err) => {
    logger.error({ err, queueName, jobId: job?.id, jobName: job?.name }, "[Queue] job failed");
  });
  worker.on("stalled", (jobId) => {
    logger.warn({ queueName, jobId }, "[Queue] job stalled");
  });

  workers.push(worker);
  return worker;
}

export async function closeQueues(): Promise<void> {
  await Promise.all(workers.map((worker) => worker.close()));
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  workers.length = 0;
  queues.clear();
}

export async function runIdempotentJob(job: QueueJobSpec) {
  try {
    await job.handler();
  } catch (err) {
    logger.error({ err, job: job.name }, "[Queue] job failed");
    throw err;
  }
}
