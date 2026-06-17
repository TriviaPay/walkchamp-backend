import { pgTable, text, integer, boolean, timestamp, bigint, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

// ── Live race step progress snapshots ─────────────────────────────────────────
export const raceProgressTable = pgTable(
  "race_progress",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    raceRoomId: text("race_room_id").notNull(),
    participantId: text("participant_id").notNull(),
    userId: text("user_id").notNull(),
    steps: integer("steps").notNull().default(0),
    rank: integer("rank"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("race_progress_room_idx").on(t.raceRoomId),
    index("race_progress_participant_idx").on(t.participantId),
  ],
);

// ── Live race comments (spectator + participant comments) ──────────────────────
export const liveRaceCommentsTable = pgTable(
  "live_race_comments",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    raceRoomId: text("race_room_id").notNull(),
    userId: text("user_id").notNull(),
    username: text("username").notNull(),
    countryFlag: text("country_flag").notNull().default("🏳️"),
    avatarColor: text("avatar_color").notNull().default("#00E676"),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("live_race_comments_room_idx").on(t.raceRoomId),
    index("live_race_comments_created_idx").on(t.createdAt),
  ],
);

// ── Live race reactions (emoji reactions per race) ────────────────────────────
export const liveRaceReactionsTable = pgTable(
  "live_race_reactions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    raceRoomId: text("race_room_id").notNull(),
    userId: text("user_id").notNull(),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("live_race_reactions_room_idx").on(t.raceRoomId),
  ],
);

// ── Race results ──────────────────────────────────────────────────────────────
export const raceResultsTable = pgTable(
  "race_results",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    raceRoomId: text("race_room_id").notNull(),
    userId: text("user_id").notNull(),
    rank: integer("rank").notNull(),
    displayRank: integer("display_rank"),
    steps: integer("steps").notNull().default(0),
    prizeCents: integer("prize_cents").notNull().default(0),
    prizeCoins: integer("prize_coins").notNull().default(0),
    isTied: boolean("is_tied").notNull().default(false),
    tieGroupId: text("tie_group_id"),
    tieGroupSize: integer("tie_group_size").notNull().default(1),
    eligibleForPrize: boolean("eligible_for_prize").notNull().default(true),
    goalCompletedAt: timestamp("goal_completed_at", { withTimezone: true }),
    goalCompletedAtMs: bigint("goal_completed_at_ms", { mode: "number" }),
    status: text("status").notNull().default("pending_verification"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("race_results_room_idx").on(t.raceRoomId),
    index("race_results_user_idx").on(t.userId),
    uniqueIndex("race_results_room_user_uniq").on(t.raceRoomId, t.userId),
  ],
);
