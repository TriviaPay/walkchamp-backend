import { pgTable, text, integer, timestamp, date, uniqueIndex, boolean, jsonb, index } from "drizzle-orm/pg-core";

// ── Coin Balances ─────────────────────────────────────────────────────────────
// One row per user. userId is the PK.
export const coinBalancesTable = pgTable("coin_balances", {
  userId: text("user_id").primaryKey(),
  currentBalance: integer("current_balance").notNull().default(0),
  lifetimeEarned: integer("lifetime_earned").notNull().default(0),
  lifetimeSpent: integer("lifetime_spent").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Coin Transactions ─────────────────────────────────────────────────────────
export const coinTransactionsTable = pgTable("coin_transactions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull(),
  amount: integer("amount").notNull(),
  transactionType: text("transaction_type").notNull(), // earn | spend | refund | adjustment
  source: text("source").notNull(), // daily_walk | daily_goal | streak | race | achievement | theme_purchase | admin
  sourceId: text("source_id"),
  rewardCode: text("reward_code"),
  reasonCode: text("reason_code").notNull().default("unspecified"),
  idempotencyKey: text("idempotency_key").notNull(),
  description: text("description").notNull(),
  balanceAfter: integer("balance_after"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("coin_transactions_user_idempotency_idx").on(t.userId, t.idempotencyKey),
  index("coin_transactions_source_idx").on(t.source, t.sourceId),
]);

// ── Daily Coin Rewards (idempotency) ──────────────────────────────────────────
// Prevents duplicate awards for the same reward on the same day.
export const dailyCoinRewardsTable = pgTable(
  "daily_coin_rewards",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    rewardDate: date("reward_date").notNull(),
    rewardCode: text("reward_code").notNull(),
    coinsAwarded: integer("coins_awarded").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("daily_coin_rewards_unique").on(t.userId, t.rewardDate, t.rewardCode)],
);

// ── Coin Reward Grants (non-daily deduplication) ──────────────────────────────
// One row per (userId, rewardCode, sourceId) — prevents double-claiming race,
// friend-accept, and spectate rewards across server restarts.
export const coinRewardGrantsTable = pgTable(
  "coin_reward_grants",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    rewardCode: text("reward_code").notNull(),
    sourceId: text("source_id").notNull(),
    coinsAwarded: integer("coins_awarded").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("coin_reward_grants_unique").on(t.userId, t.rewardCode, t.sourceId)],
);

export const adRewardClaimsTable = pgTable(
  "ad_reward_claims",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    claimId: text("claim_id").notNull(),
    rewardDate: date("reward_date").notNull(),
    network: text("network"),
    placement: text("placement"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ad_reward_claims_claim_idx").on(t.claimId),
    index("ad_reward_claims_user_date_idx").on(t.userId, t.rewardDate),
  ],
);

// ── Spectate Sessions ─────────────────────────────────────────────────────────
// Tracks per-user spectate start/end times to validate the 60s minimum before
// granting the spectate match coin reward.
export const spectateSessionsTable = pgTable("spectate_sessions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull(),
  raceRoomId: text("race_room_id").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  rewardGranted: boolean("reward_granted").notNull().default(false),
});

// ── Race Track Themes catalog ─────────────────────────────────────────────────
// code matches the assetKey used for local images in the frontend.
export const raceTrackThemesTable = pgTable("race_track_themes", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  priceCoins: integer("price_coins").notNull().default(0),
  assetKey: text("asset_key"), // matches TRACK_LAYOUT_OPTIONS id in frontend
  sortOrder: integer("sort_order").notNull().default(0),
  isDefault: boolean("is_default").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── User-owned Track Themes ───────────────────────────────────────────────────
export const userTrackThemesTable = pgTable(
  "user_track_themes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    themeCode: text("theme_code").notNull(),
    purchasedAt: timestamp("purchased_at", { withTimezone: true }).notNull().defaultNow(),
    purchasePriceCoins: integer("purchase_price_coins").notNull().default(0),
    isEquipped: boolean("is_equipped").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("user_track_themes_unique").on(t.userId, t.themeCode)],
);
