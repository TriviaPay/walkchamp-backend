import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  date,
  jsonb,
  numeric,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ── Walking Groups ─────────────────────────────────────────────────────────────
export const walkingGroupsTable = pgTable(
  "walking_groups",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    groupName: text("group_name").notNull(),
    groupType: text("group_type").notNull(), // friends | family | office | custom
    customGroupType: text("custom_group_type"),
    adminUserId: text("admin_user_id").notNull(),
    dailyGoalSteps: integer("daily_goal_steps").notNull().default(10000),
    maxMembers: integer("max_members").notNull().default(10),
    privacy: text("privacy").notNull().default("public"),
    inviteCode: text("invite_code").unique(),
    themeKey: text("theme_key"),
    groupImageUrl: text("group_image_url"),
    status: text("status").notNull().default("active"), // active | archived | deleted
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("walking_groups_admin_idx").on(t.adminUserId),
    index("walking_groups_status_idx").on(t.status),
  ],
);

// ── Group Members ──────────────────────────────────────────────────────────────
export const walkingGroupMembersTable = pgTable(
  "walking_group_members",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("member"), // admin | member
    status: text("status").notNull().default("active"), // active | invited | declined | removed | left
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("walking_group_members_pair_idx").on(t.groupId, t.userId),
    index("walking_group_members_user_idx").on(t.userId),
    index("walking_group_members_group_idx").on(t.groupId),
  ],
);

// ── Group Invites ──────────────────────────────────────────────────────────────
export const walkingGroupInvitesTable = pgTable(
  "walking_group_invites",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id").notNull(),
    invitedUserId: text("invited_user_id").notNull(),
    invitedByUserId: text("invited_by_user_id").notNull(),
    inviteCode: text("invite_code"),
    status: text("status").notNull().default("pending"), // pending | accepted | declined | expired
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
  },
  (t) => [
    index("walking_group_invites_user_idx").on(t.invitedUserId),
    index("walking_group_invites_group_idx").on(t.groupId),
  ],
);

// ── Group Daily Steps ──────────────────────────────────────────────────────────
export const walkingGroupDailyStepsTable = pgTable(
  "walking_group_daily_steps",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id").notNull(),
    userId: text("user_id").notNull(),
    stepDate: date("step_date").notNull(),
    dailySteps: integer("daily_steps").notNull().default(0),
    verifiedSteps: integer("verified_steps").notNull().default(0),
    calories: numeric("calories"),
    distanceMeters: numeric("distance_meters"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("walking_group_daily_steps_unique_idx").on(t.groupId, t.userId, t.stepDate),
    index("walking_group_daily_steps_group_date_idx").on(t.groupId, t.stepDate),
    index("walking_group_daily_steps_user_idx").on(t.userId),
  ],
);

// ── Group Join Requests ────────────────────────────────────────────────────────
export const walkingGroupJoinRequestsTable = pgTable(
  "walking_group_join_requests",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id").notNull(),
    userId: text("user_id").notNull(),
    status: text("status").notNull().default("pending"), // pending | accepted | rejected | cancelled
    message: text("message"),
    respondedByUserId: text("responded_by_user_id"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("walking_group_join_requests_group_idx").on(t.groupId),
    index("walking_group_join_requests_user_idx").on(t.userId),
    index("walking_group_join_requests_status_idx").on(t.status),
  ],
);

// ── Group Daily Results ────────────────────────────────────────────────────────
export const walkingGroupDailyResultsTable = pgTable(
  "walking_group_daily_results",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id").notNull(),
    resultDate: date("result_date").notNull(),
    groupTotalSteps: integer("group_total_steps").notNull().default(0),
    dailyGoalSteps: integer("daily_goal_steps").notNull(),
    goalCompleted: boolean("goal_completed").notNull().default(false),
    topUserId: text("top_user_id"),
    rankings: jsonb("rankings"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("walking_group_daily_results_unique_idx").on(t.groupId, t.resultDate),
    index("walking_group_daily_results_group_idx").on(t.groupId),
  ],
);
