import { pgTable, text, integer, timestamp, pgEnum, uuid, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { profilesTable } from "./profiles.js";

export const payoutMethodEnum = pgEnum("payout_method", [
  "paypal",
  "bank_transfer",
  "upi",
  "gift_card",
]);

export const withdrawalStatusEnum = pgEnum("withdrawal_status", [
  "pending",
  "approved",
  "rejected",
  "paid",
  "cancelled",
]);

// ── Withdrawals ───────────────────────────────────────────────────────────────
// Admin-reviewed withdrawal requests. Amounts stored in cents.
// payoutDetails stored as jsonb (email, bank info, UPI ID, etc.) — do NOT log.
export const withdrawalsTable = pgTable("withdrawals", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => profilesTable.id, { onDelete: "restrict" }),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("usd"),
  payoutMethod: payoutMethodEnum("payout_method").notNull(),
  payoutDetails: jsonb("payout_details").notNull(),
  status: withdrawalStatusEnum("status").notNull().default("pending"),
  adminNotes: text("admin_notes"),
  reviewNotes: text("review_notes"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at"),
  suspiciousReason: text("suspicious_reason"),
  requestedAt: timestamp("requested_at").notNull().defaultNow(),
  approvedAt: timestamp("approved_at"),
  paidAt: timestamp("paid_at"),
  rejectedAt: timestamp("rejected_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertWithdrawalSchema = createInsertSchema(withdrawalsTable).omit({
  id: true,
  status: true,
  adminNotes: true,
  requestedAt: true,
  approvedAt: true,
  paidAt: true,
  rejectedAt: true,
  createdAt: true,
  updatedAt: true,
});
export const selectWithdrawalSchema = createSelectSchema(withdrawalsTable);

export type Withdrawal = typeof withdrawalsTable.$inferSelect;
export type InsertWithdrawal = z.infer<typeof insertWithdrawalSchema>;
