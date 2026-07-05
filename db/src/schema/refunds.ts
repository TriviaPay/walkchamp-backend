import { pgTable, text, integer, timestamp, uuid, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { profilesTable } from "./profiles.js";

export const refundsTable = pgTable("refunds", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => profilesTable.id, { onDelete: "restrict" }),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  requestSource: text("request_source").notNull(),
  reasonCode: text("reason_code").notNull(),
  status: text("status").notNull().default("requested"),
  idempotencyKey: text("idempotency_key").notNull(),
  requestedCashCents: integer("requested_cash_cents").notNull().default(0),
  approvedCashCents: integer("approved_cash_cents").notNull().default(0),
  succeededCashCents: integer("succeeded_cash_cents").notNull().default(0),
  requestedCoinAmount: integer("requested_coin_amount").notNull().default(0),
  succeededCoinAmount: integer("succeeded_coin_amount").notNull().default(0),
  createdByUserId: text("created_by_user_id").references(() => profilesTable.id, { onDelete: "set null" }),
  reviewedByUserId: text("reviewed_by_user_id").references(() => profilesTable.id, { onDelete: "set null" }),
  failureCode: text("failure_code"),
  failureMessage: text("failure_message"),
  metadata: jsonb("metadata"),
  requestedAt: timestamp("requested_at").notNull().defaultNow(),
  approvedAt: timestamp("approved_at"),
  rejectedAt: timestamp("rejected_at"),
  queuedAt: timestamp("queued_at"),
  processingAt: timestamp("processing_at"),
  succeededAt: timestamp("succeeded_at"),
  failedAt: timestamp("failed_at"),
  canceledAt: timestamp("canceled_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("refunds_idempotency_key_unique_idx").on(table.idempotencyKey),
  index("refunds_user_created_idx").on(table.userId, table.createdAt),
  index("refunds_status_created_idx").on(table.status, table.createdAt),
  index("refunds_source_idx").on(table.sourceType, table.sourceId),
]);

export const refundItemsTable = pgTable("refund_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  refundId: uuid("refund_id").notNull().references(() => refundsTable.id, { onDelete: "cascade" }),
  originalComponentType: text("original_component_type").notNull(),
  originalComponentId: text("original_component_id").notNull(),
  refundActionKey: text("refund_action_key").notNull(),
  assetType: text("asset_type").notNull(),
  currency: text("currency").notNull().default("usd"),
  destination: text("destination").notNull(),
  provider: text("provider"),
  providerPaymentId: text("provider_payment_id"),
  providerChargeId: text("provider_charge_id"),
  providerRefundId: text("provider_refund_id"),
  providerRefundStatus: text("provider_refund_status"),
  providerRequestBody: jsonb("provider_request_body"),
  providerIdempotencyKey: text("provider_idempotency_key"),
  walletTransactionId: uuid("wallet_transaction_id"),
  coinTransactionId: text("coin_transaction_id"),
  requestedAmount: integer("requested_amount").notNull().default(0),
  approvedAmount: integer("approved_amount").notNull().default(0),
  succeededAmount: integer("succeeded_amount").notNull().default(0),
  status: text("status").notNull().default("requested"),
  failureCode: text("failure_code"),
  failureMessage: text("failure_message"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("refund_items_component_action_unique_idx")
    .on(table.originalComponentType, table.originalComponentId, table.refundActionKey),
  uniqueIndex("refund_items_provider_refund_unique_idx").on(table.provider, table.providerRefundId),
  uniqueIndex("refund_items_provider_idempotency_unique_idx").on(table.providerIdempotencyKey),
  uniqueIndex("refund_items_wallet_tx_unique_idx").on(table.walletTransactionId),
  uniqueIndex("refund_items_coin_tx_unique_idx").on(table.coinTransactionId),
  index("refund_items_refund_idx").on(table.refundId),
  index("refund_items_status_idx").on(table.status),
]);

export const refundAttemptsTable = pgTable("refund_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  refundItemId: uuid("refund_item_id").notNull().references(() => refundItemsTable.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  providerIdempotencyKey: text("provider_idempotency_key").notNull(),
  requestBody: jsonb("request_body").notNull().default({}),
  responseBody: jsonb("response_body"),
  httpStatus: integer("http_status"),
  attemptStatus: text("attempt_status").notNull().default("started"),
  failureCode: text("failure_code"),
  failureMessage: text("failure_message"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("refund_attempts_item_created_idx").on(table.refundItemId, table.createdAt),
]);

export const refundBatchesTable = pgTable("refund_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceType: text("source_type").notNull(),
  raceRoomId: uuid("race_room_id"),
  status: text("status").notNull().default("requested"),
  totalItems: integer("total_items").notNull().default(0),
  succeededItems: integer("succeeded_items").notNull().default(0),
  failedItems: integer("failed_items").notNull().default(0),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("refund_batches_race_idx").on(table.raceRoomId),
  index("refund_batches_status_idx").on(table.status),
]);

export const providerWebhookEventsTable = pgTable("provider_webhook_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(),
  providerEventId: text("provider_event_id").notNull(),
  eventType: text("event_type").notNull(),
  providerRefundId: text("provider_refund_id"),
  payload: jsonb("payload").notNull().default({}),
  processed: integer("processed").notNull().default(0),
  processingStatus: text("processing_status").notNull().default("pending"),
  processingError: text("processing_error"),
  unresolved: integer("unresolved").notNull().default(0),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
  processedAt: timestamp("processed_at"),
}, (table) => [
  uniqueIndex("provider_webhook_events_provider_event_unique_idx").on(table.provider, table.providerEventId),
  index("provider_webhook_events_refund_idx").on(table.provider, table.providerRefundId),
  index("provider_webhook_events_unresolved_idx").on(table.unresolved, table.receivedAt),
]);

export type Refund = typeof refundsTable.$inferSelect;
export type RefundItem = typeof refundItemsTable.$inferSelect;
export type RefundAttempt = typeof refundAttemptsTable.$inferSelect;
export type RefundBatch = typeof refundBatchesTable.$inferSelect;
export type ProviderWebhookEvent = typeof providerWebhookEventsTable.$inferSelect;
