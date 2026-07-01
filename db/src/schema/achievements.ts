import { pgTable, text, integer, boolean, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { profilesTable } from "./profiles.js";

// ── Achievement definitions (global catalogue) ────────────────────────────────
export const achievementDefinitionsTable = pgTable(
  "achievement_definitions",
  {
    id:               text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    code:             text("code").notNull().unique(),
    title:            text("title").notNull(),
    description:      text("description").notNull(),
    category:         text("category").notNull(),
    difficulty:       text("difficulty").notNull(),
    unlockType:       text("unlock_type").notNull(),
    targetValue:      integer("target_value"),
    leaderboardScope: text("leaderboard_scope"),
    timePeriod:       text("time_period"),
    icon:             text("icon"),
    badgeColor:       text("badge_color"),
    xpReward:         integer("xp_reward").notNull().default(0),
    sortOrder:        integer("sort_order").notNull().default(0),
    isActive:         boolean("is_active").notNull().default(true),
    createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ach_def_difficulty_idx").on(t.difficulty),
    index("ach_def_category_idx").on(t.category),
  ],
);

// ── Per-user achievement progress ─────────────────────────────────────────────
export const userAchievementsTable = pgTable(
  "user_achievements",
  {
    id:              text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId:          text("user_id").notNull().references(() => profilesTable.id),
    achievementCode: text("achievement_code").notNull().references(() => achievementDefinitionsTable.code),
    progressValue:   integer("progress_value").notNull().default(0),
    targetValue:     integer("target_value"),
    unlocked:        boolean("unlocked").notNull().default(false),
    unlockedAt:      timestamp("unlocked_at", { withTimezone: true }),
    metadata:        jsonb("metadata"),
    createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:       timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("user_achievements_unique").on(t.userId, t.achievementCode),
    index("user_achievements_user_idx").on(t.userId),
  ],
);

// ── Per-user owned & equipped titles ─────────────────────────────────────────
export const userTitlesTable = pgTable(
  "user_titles",
  {
    id:              text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId:          text("user_id").notNull().references(() => profilesTable.id),
    achievementCode: text("achievement_code").notNull().references(() => achievementDefinitionsTable.code),
    isActive:        boolean("is_active").notNull().default(false),
    equippedAt:      timestamp("equipped_at", { withTimezone: true }),
    createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:       timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("user_titles_unique").on(t.userId, t.achievementCode),
    index("user_titles_user_idx").on(t.userId),
  ],
);

export type AchievementDefinition = typeof achievementDefinitionsTable.$inferSelect;
export type UserAchievement      = typeof userAchievementsTable.$inferSelect;
export type UserTitle            = typeof userTitlesTable.$inferSelect;
