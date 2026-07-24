import { and, asc, eq, lte, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import { outboxEventsTable } from "../../db/src/schema/index.js";
import { enqueueJob, type AppQueueName } from "./queue.js";
import { type DbTx } from "./raceIntegrity.js";
import { logger } from "./logger.js";

const APP_QUEUE_NAMES = new Set<AppQueueName>([
  "notifications",
  "media-cleanup",
  "webhook-processing",
  "scheduled-jobs",
  "coin-reconciliation",
  "race-finalization",
  "achievement-evaluation",
  "refund-processing",
]);

/**
 * Hourly repair-scan cadence. The outbox is delivered OPPORTUNISTICALLY right after
 * the originating transaction commits (see enqueueOutboxEvent); this scan only recovers
 * events whose opportunistic enqueue never happened (e.g. a crash between commit and
 * enqueue). Polling Postgres frequently would keep Neon compute awake 24/7 even with
 * zero users, so the safety-net scan runs infrequently.
 */
const OUTBOX_REPAIR_INTERVAL_MS = 60 * 60_000;

export type OutboxEventInput = {
  topic: AppQueueName;
  eventType: string;
  aggregateType?: string | null;
  aggregateId?: string | null;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  availableAt?: Date;
};

type OutboxRow = typeof outboxEventsTable.$inferSelect;

/** Executor accepted by the tx-aware insert — the base db or a transaction handle. */
type DbExecutor = typeof db | DbTx;

function outboxValues(input: OutboxEventInput) {
  return {
    topic: input.topic,
    eventType: input.eventType,
    aggregateType: input.aggregateType ?? null,
    aggregateId: input.aggregateId ?? null,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    availableAt: input.availableAt ?? new Date(),
  };
}

/**
 * Insert an outbox row inside the CALLER'S transaction and return it. Does NOT enqueue —
 * the row is not durable until the surrounding transaction commits. The caller MUST call
 * enqueueOutboxEvent(row) only after `db.transaction(...)` has resolved successfully.
 * Returns null on idempotency-key conflict (already recorded).
 */
export async function insertOutboxEventTx(
  tx: DbExecutor,
  input: OutboxEventInput,
): Promise<OutboxRow | null> {
  const [row] = await tx
    .insert(outboxEventsTable)
    .values(outboxValues(input))
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/**
 * Non-transactional convenience: insert the outbox row (auto-committed) and then
 * opportunistically enqueue it. Safe because the insert has committed before enqueue.
 * Backwards-compatible with existing callers that are not inside an explicit transaction.
 */
export async function recordOutboxEvent(input: OutboxEventInput): Promise<void> {
  const row = await insertOutboxEventTx(db, input);
  if (row) {
    // Fire-and-forget: on failure the hourly repair scan re-delivers.
    void enqueueOutboxEvent(row);
  }
}

/**
 * Deterministic, BullMQ-safe job id derived from the outbox row UUID. Never use the
 * business idempotency key (it can contain ":" and other separators, and completed-job
 * removal could let it be re-added). The business key travels in the job payload so
 * consumers stay idempotent even on double delivery.
 */
function outboxJobId(event: OutboxRow): string {
  return `outbox-${event.id}`;
}

/**
 * Lock a pending row, enqueue it with a safe deterministic job id, and finalize its
 * status. Shared by the opportunistic post-commit path and the hourly repair scan, so a
 * concurrent double-delivery is impossible: the pending→dispatching compare-and-set means
 * only one caller wins, and the deterministic job id de-dupes at the queue level anyway.
 * Returns true when this call delivered the event.
 */
async function deliverOutboxEvent(event: OutboxRow): Promise<boolean> {
  if (!APP_QUEUE_NAMES.has(event.topic as AppQueueName)) {
    await db
      .update(outboxEventsTable)
      .set({
        status: "failed",
        lastError: `Unknown outbox topic: ${event.topic}`,
        attemptCount: sql`${outboxEventsTable.attemptCount} + 1`,
      })
      .where(eq(outboxEventsTable.id, event.id));
    return false;
  }

  const locked = await db
    .update(outboxEventsTable)
    .set({
      status: "dispatching",
      lockedAt: new Date(),
      lockedBy: `outbox-${process.pid}`,
      attemptCount: sql`${outboxEventsTable.attemptCount} + 1`,
    })
    .where(and(
      eq(outboxEventsTable.id, event.id),
      eq(outboxEventsTable.status, "pending"),
    ))
    .returning({ id: outboxEventsTable.id });

  if (locked.length === 0) return false; // already delivered / claimed elsewhere

  try {
    await enqueueJob(event.topic as AppQueueName, event.eventType, {
      outboxEventId: event.id,
      idempotencyKey: event.idempotencyKey,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload,
    }, {
      jobId: outboxJobId(event),
    });

    await db
      .update(outboxEventsTable)
      .set({ status: "dispatched", dispatchedAt: new Date(), lastError: null })
      .where(eq(outboxEventsTable.id, event.id));
    return true;
  } catch (err) {
    const retryAt = new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(event.attemptCount + 1, 6)));
    await db
      .update(outboxEventsTable)
      .set({
        status: "pending",
        availableAt: retryAt,
        lockedAt: null,
        lockedBy: null,
        lastError: err instanceof Error ? err.message : String(err),
      })
      .where(eq(outboxEventsTable.id, event.id));
    logger.error({ err, outboxEventId: event.id, topic: event.topic }, "[Outbox] dispatch failed");
    return false;
  }
}

/**
 * Opportunistically deliver a single freshly-committed outbox row. Best-effort: any error
 * is swallowed because the hourly repair scan is the durable safety net. Call ONLY after
 * the row's transaction has committed.
 */
export async function enqueueOutboxEvent(event: OutboxRow): Promise<void> {
  try {
    await deliverOutboxEvent(event);
  } catch (err) {
    logger.error({ err, outboxEventId: event.id }, "[Outbox] opportunistic enqueue failed");
  }
}

/** Repair scan: pick up pending rows the opportunistic path missed and deliver them. */
export async function dispatchOutboxBatch(opts?: { batchSize?: number }): Promise<number> {
  const batchSize = opts?.batchSize ?? 100;
  const now = new Date();

  const events = await db
    .select()
    .from(outboxEventsTable)
    .where(and(
      eq(outboxEventsTable.status, "pending"),
      lte(outboxEventsTable.availableAt, now),
    ))
    .orderBy(asc(outboxEventsTable.availableAt), asc(outboxEventsTable.createdAt))
    .limit(batchSize);

  let dispatched = 0;
  for (const event of events) {
    if (await deliverOutboxEvent(event)) dispatched += 1;
  }
  return dispatched;
}

export function startOutboxDispatcher(): void {
  const interval = setInterval(() => {
    dispatchOutboxBatch().catch((err) => {
      logger.error({ err }, "[Outbox] repair scan failed");
    });
  }, OUTBOX_REPAIR_INTERVAL_MS);
  interval.unref?.();
}
