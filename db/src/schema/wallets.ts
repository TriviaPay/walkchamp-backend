import { sql } from "drizzle-orm";
import { pgTable, text, integer, timestamp, pgEnum, uuid, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { profilesTable } from "./profiles.js";

export const walletTransactionTypeEnum = pgEnum("wallet_transaction_type", [
  "deposit_credit",
  "race_entry_payment",
  "race_entry_wallet_debit",
  "race_entry_refund",
  "race_prize_pending",
  "race_prize_approved",
  "race_prize_paid",
  "deposit_refund_debit",
  "chargeback_debit",
  "withdrawal_requested",
  "withdrawal_approved",
  "withdrawal_rejected",
  "promo_discount",
  "referral_credit",
  "sponsored_reward",
  "manual_adjustment",
]);

export const walletTransactionStatusEnum = pgEnum("wallet_transaction_status", [
  "pending",
  "completed",
  "failed",
  "cancelled",
]);

// ── Wallets ──────────────────────────────────────────────────────────────────
// One wallet per user. All monetary amounts stored in cents (USD).
// availableBalance = total spendable balance
// pendingBalance   = earned but under verification (not yet withdrawable)
// withdrawableBalance = can be requested for withdrawal
// totalEarned      = lifetime earnings counter
export const walletsTable = pgTable("wallets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => profilesTable.id, { onDelete: "cascade" }),
  availableBalanceCents: integer("available_balance_cents").notNull().default(0),
  pendingBalanceCents: integer("pending_balance_cents").notNull().default(0),
  withdrawableBalanceCents: integer("withdrawable_balance_cents").notNull().default(0),
  totalEarnedCents: integer("total_earned_cents").notNull().default(0),
  currency: text("currency").notNull().default("usd"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ── Wallet Transactions ───────────────────────────────────────────────────────
// Immutable ledger of all wallet changes. Never mutate rows, only insert new ones.
// amount is signed: positive = credit, negative = debit (in cents)
export const walletTransactionsTable = pgTable("wallet_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  walletId: uuid("wallet_id")
    .notNull()
    .references(() => walletsTable.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => profilesTable.id, { onDelete: "cascade" }),
  transactionType: walletTransactionTypeEnum("transaction_type").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("usd"),
  status: walletTransactionStatusEnum("status").notNull().default("pending"),
  description: text("description").notNull(),
  source: text("source"),
  idempotencyKey: text("idempotency_key"),
  depositTransactionId: uuid("deposit_transaction_id"),
  raceRoomId: uuid("race_room_id"),
  paymentId: uuid("payment_id"),
  withdrawalId: uuid("withdrawal_id"),
  refundId: uuid("refund_id"),
  refundItemId: uuid("refund_item_id"),
  balanceBeforeCents: integer("balance_before_cents"),
  balanceAfterCents: integer("balance_after_cents"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("wallet_transactions_idempotency_key_unique_idx")
    .on(table.idempotencyKey)
    .where(sql`${table.idempotencyKey} IS NOT NULL`),
  uniqueIndex("wallet_transactions_deposit_credit_unique_idx")
    .on(table.depositTransactionId)
    .where(sql`${table.depositTransactionId} IS NOT NULL AND ${table.transactionType} = 'deposit_credit'::wallet_transaction_type`),
]);

export const insertWalletSchema = createInsertSchema(walletsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const selectWalletSchema = createSelectSchema(walletsTable);

export const insertWalletTransactionSchema = createInsertSchema(walletTransactionsTable).omit({
  id: true,
  createdAt: true,
});
export const selectWalletTransactionSchema = createSelectSchema(walletTransactionsTable);

export type Wallet = typeof walletsTable.$inferSelect;
export type WalletTransaction = typeof walletTransactionsTable.$inferSelect;
export type InsertWallet = z.infer<typeof insertWalletSchema>;
export type InsertWalletTransaction = z.infer<typeof insertWalletTransactionSchema>;
