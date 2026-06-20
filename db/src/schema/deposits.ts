import { pgTable, text, integer, timestamp, uuid, jsonb, boolean, uniqueIndex } from "drizzle-orm/pg-core";

export const depositTransactionsTable = pgTable("deposit_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(),
  status: text("status").notNull().default("pending"),
  amountMinorUnits: integer("amount_minor_units").notNull(),
  currency: text("currency").notNull(),
  walletCreditCents: integer("wallet_credit_cents"),
  providerOrderId: text("provider_order_id"),
  providerPaymentId: text("provider_payment_id"),
  providerSignature: text("provider_signature"),
  idempotencyKey: text("idempotency_key").unique(),
  failureReason: text("failure_reason"),
  metadata: jsonb("metadata"),
  creditedAt: timestamp("credited_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const depositWebhookEventsTable = pgTable("deposit_webhook_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(),
  providerEventId: text("provider_event_id").notNull(),
  eventType: text("event_type").notNull(),
  processed: boolean("processed").notNull().default(false),
  processingStatus: text("processing_status").notNull().default("pending"),
  processingAttemptCount: integer("processing_attempt_count").notNull().default(0),
  failureReason: text("failure_reason"),
  payload: jsonb("payload"),
  payloadReference: text("payload_reference"),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
  processedAt: timestamp("processed_at"),
}, (table) => [
  uniqueIndex("deposit_webhook_events_provider_event_unique_idx").on(table.provider, table.providerEventId),
]);

export type DepositTransaction = typeof depositTransactionsTable.$inferSelect;
export type DepositWebhookEvent = typeof depositWebhookEventsTable.$inferSelect;
