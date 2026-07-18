import { integer, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { profilesTable } from "./profiles.js";
import { walletTransactionsTable } from "./wallets.js";

export const referralBonusAwardsTable = pgTable(
  "referral_bonus_awards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referrerUserId: text("referrer_user_id")
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    referredUserId: text("referred_user_id")
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    referralCode: text("referral_code"),
    triggerRaceRoomId: uuid("trigger_race_room_id").notNull(),
    referrerTransactionId: uuid("referrer_transaction_id")
      .references(() => walletTransactionsTable.id),
    referredTransactionId: uuid("referred_transaction_id")
      .references(() => walletTransactionsTable.id),
    amountCents: integer("amount_cents").notNull().default(300),
    currency: text("currency").notNull().default("usd"),
    status: text("status").notNull().default("completed"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    creditedAt: timestamp("credited_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("referral_bonus_awards_referred_user_unique_idx").on(t.referredUserId),
    index("referral_bonus_awards_referrer_idx").on(t.referrerUserId),
    index("referral_bonus_awards_trigger_race_idx").on(t.triggerRaceRoomId),
  ],
);

export type ReferralBonusAward = typeof referralBonusAwardsTable.$inferSelect;
