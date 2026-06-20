import { pgTable, text, integer, timestamp, pgEnum, uuid, jsonb, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { profilesTable } from "./profiles";

export const paymentStatusEnum = pgEnum("payment_status", [
  "pending",
  "requires_payment_method",
  "processing",
  "succeeded",
  "failed",
  "cancelled",
  "refunded",
]);

export const paymentTypeEnum = pgEnum("payment_type", [
  "race_entry",
  "wallet_topup",
  "sponsored_event",
  "other",
]);

export const discountTypeEnum = pgEnum("discount_type", [
  "fixed",
  "percent",
]);

// ── Payments ──────────────────────────────────────────────────────────────────
export const paymentsTable = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => profilesTable.id, { onDelete: "restrict" }),
  stripePaymentIntentId: text("stripe_payment_intent_id").unique(),
  stripeCustomerId: text("stripe_customer_id"),
  challengeId: uuid("challenge_id"),
  raceRoomId: uuid("race_room_id"),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("usd"),
  status: paymentStatusEnum("status").notNull().default("pending"),
  paymentType: paymentTypeEnum("payment_type").notNull().default("race_entry"),
  idempotencyKey: text("idempotency_key").unique(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ── Payment Events (Stripe webhook idempotency) ───────────────────────────────
export const paymentEventsTable = pgTable("payment_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  paymentId: uuid("payment_id").references(() => paymentsTable.id, { onDelete: "set null" }),
  provider: text("provider").notNull().default("stripe"),
  providerEventId: text("provider_event_id").notNull(),
  stripeEventId: text("stripe_event_id"),
  eventType: text("event_type").notNull(),
  rawPayload: jsonb("raw_payload"),
  payloadReference: text("payload_reference"),
  processed: boolean("processed").notNull().default(false),
  processingStatus: text("processing_status").notNull().default("pending"),
  processingAttemptCount: integer("processing_attempt_count").notNull().default(0),
  failureReason: text("failure_reason"),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
  processedAt: timestamp("processed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("payment_events_provider_event_unique_idx").on(table.provider, table.providerEventId),
]);

// ── Promo Codes ───────────────────────────────────────────────────────────────
export const promoCodesTable = pgTable("promo_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  discountType: discountTypeEnum("discount_type").notNull(),
  discountValue: integer("discount_value").notNull(),
  maxUses: integer("max_uses"),
  usedCount: integer("used_count").notNull().default(0),
  active: boolean("active").notNull().default(true),
  startsAt: timestamp("starts_at"),
  endsAt: timestamp("ends_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ── Promo Redemptions ─────────────────────────────────────────────────────────
export const promoRedemptionsTable = pgTable("promo_redemptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  promoCodeId: uuid("promo_code_id")
    .notNull()
    .references(() => promoCodesTable.id, { onDelete: "restrict" }),
  userId: text("user_id")
    .notNull()
    .references(() => profilesTable.id, { onDelete: "restrict" }),
  paymentId: uuid("payment_id").references(() => paymentsTable.id, { onDelete: "set null" }),
  discountAmountCents: integer("discount_amount_cents").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertPaymentSchema = createInsertSchema(paymentsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const selectPaymentSchema = createSelectSchema(paymentsTable);

export type Payment = typeof paymentsTable.$inferSelect;
export type PaymentEvent = typeof paymentEventsTable.$inferSelect;
export type PromoCode = typeof promoCodesTable.$inferSelect;
export type InsertPayment = z.infer<typeof insertPaymentSchema>;
