import { pgTable, text, integer, timestamp, uuid, jsonb, uniqueIndex, index, boolean } from "drizzle-orm/pg-core";
import { raceRoomsTable } from "./races.js";
import { profilesTable } from "./profiles.js";

export const outboxEventsTable = pgTable("outbox_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  topic: text("topic").notNull(),
  eventType: text("event_type").notNull(),
  aggregateType: text("aggregate_type"),
  aggregateId: text("aggregate_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  payload: jsonb("payload").notNull().default({}),
  status: text("status").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  availableAt: timestamp("available_at").notNull().defaultNow(),
  lockedAt: timestamp("locked_at"),
  lockedBy: text("locked_by"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  dispatchedAt: timestamp("dispatched_at"),
}, (table) => [
  uniqueIndex("outbox_events_idempotency_key_unique_idx").on(table.idempotencyKey),
  index("outbox_events_pending_idx").on(table.status, table.availableAt),
]);

export const notificationDeliveryTable = pgTable("notification_delivery", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => profilesTable.id, { onDelete: "cascade" }),
  template: text("template").notNull(),
  entityId: text("entity_id").notNull(),
  status: text("status").notNull().default("pending"),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at"),
}, (table) => [
  uniqueIndex("notification_delivery_user_template_entity_unique_idx")
    .on(table.userId, table.template, table.entityId),
]);

export const raceFinalizationLocksTable = pgTable("race_finalization_locks", {
  id: uuid("id").primaryKey().defaultRandom(),
  raceId: uuid("race_id").notNull().references(() => raceRoomsTable.id, { onDelete: "cascade" }),
  lockOwner: text("lock_owner").notNull(),
  finalStateVersion: integer("final_state_version").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  releasedAt: timestamp("released_at"),
}, (table) => [
  uniqueIndex("race_finalization_locks_race_unique_idx").on(table.raceId),
]);

export const finalizationAttemptsTable = pgTable("finalization_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  raceId: uuid("race_id").notNull().references(() => raceRoomsTable.id, { onDelete: "cascade" }),
  finalStateVersion: integer("final_state_version").notNull().default(1),
  status: text("status").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
}, (table) => [
  uniqueIndex("finalization_attempts_race_version_unique_idx")
    .on(table.raceId, table.finalStateVersion),
]);

export const operationalLocksTable = pgTable("operational_locks", {
  key: text("key").primaryKey(),
  locked: boolean("locked").notNull().default(false),
  reason: text("reason"),
  metadata: jsonb("metadata"),
  lockedAt: timestamp("locked_at"),
  resolvedAt: timestamp("resolved_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("operational_locks_locked_idx").on(table.locked),
]);

export type OutboxEvent = typeof outboxEventsTable.$inferSelect;
export type NotificationDelivery = typeof notificationDeliveryTable.$inferSelect;
export type RaceFinalizationLock = typeof raceFinalizationLocksTable.$inferSelect;
export type FinalizationAttempt = typeof finalizationAttemptsTable.$inferSelect;
export type OperationalLock = typeof operationalLocksTable.$inferSelect;
