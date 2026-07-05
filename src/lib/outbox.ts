import { and, asc, eq, lte, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import { outboxEventsTable } from "../../db/src/schema/index.js";
import { enqueueJob, type AppQueueName } from "./queue.js";
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

export type OutboxEventInput = {
  topic: AppQueueName;
  eventType: string;
  aggregateType?: string | null;
  aggregateId?: string | null;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  availableAt?: Date;
};

export async function recordOutboxEvent(input: OutboxEventInput): Promise<void> {
  await db
    .insert(outboxEventsTable)
    .values({
      topic: input.topic,
      eventType: input.eventType,
      aggregateType: input.aggregateType ?? null,
      aggregateId: input.aggregateId ?? null,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      availableAt: input.availableAt ?? new Date(),
    })
    .onConflictDoNothing();
}

export async function dispatchOutboxBatch(opts?: { batchSize?: number; workerId?: string }): Promise<number> {
  const batchSize = opts?.batchSize ?? 25;
  const workerId = opts?.workerId ?? `outbox-${process.pid}`;
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
    if (!APP_QUEUE_NAMES.has(event.topic as AppQueueName)) {
      await db
        .update(outboxEventsTable)
        .set({
          status: "failed",
          lastError: `Unknown outbox topic: ${event.topic}`,
          attemptCount: sql`${outboxEventsTable.attemptCount} + 1`,
        })
        .where(eq(outboxEventsTable.id, event.id));
      continue;
    }

    const locked = await db
      .update(outboxEventsTable)
      .set({
        status: "dispatching",
        lockedAt: new Date(),
        lockedBy: workerId,
        attemptCount: sql`${outboxEventsTable.attemptCount} + 1`,
      })
      .where(and(
        eq(outboxEventsTable.id, event.id),
        eq(outboxEventsTable.status, "pending"),
      ))
      .returning({ id: outboxEventsTable.id });

    if (locked.length === 0) continue;

    try {
      await enqueueJob(event.topic as AppQueueName, event.eventType, {
        outboxEventId: event.id,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        payload: event.payload,
      }, {
        jobId: event.idempotencyKey,
      });

      await db
        .update(outboxEventsTable)
        .set({
          status: "dispatched",
          dispatchedAt: new Date(),
          lastError: null,
        })
        .where(eq(outboxEventsTable.id, event.id));
      dispatched += 1;
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
    }
  }

  return dispatched;
}

export function startOutboxDispatcher(): void {
  const interval = setInterval(() => {
    dispatchOutboxBatch().catch((err) => {
      logger.error({ err }, "[Outbox] dispatcher tick failed");
    });
  }, 5_000);
  interval.unref?.();
}
