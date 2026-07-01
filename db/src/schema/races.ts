import { pgTable, text, integer, bigint, timestamp, pgEnum, uuid, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { profilesTable } from "./profiles.js";

export const raceTypeEnum = pgEnum("race_type", [
  "quick",
  "endurance",
  "country_battle",
  "friends",
  "sponsored",
]);

export const entryTypeEnum = pgEnum("entry_type", [
  "free",
  "paid_1",
  "paid_3",
  "paid_5",
  "paid_usd",
  "coins_battle",
]);

export const raceStatusEnum = pgEnum("race_status", [
  "open",
  "full",
  "in_progress",
  "completed",
  "cancelled",
  "scheduled",
]);

export const participantStatusEnum = pgEnum("participant_status", [
  "joined",
  "active",
  "completed",
  "disqualified",
  "left",
  "forfeited",
]);

// ── Race Rooms ────────────────────────────────────────────────────────────────
export const raceRoomsTable = pgTable("race_rooms", {
  id: uuid("id").primaryKey().defaultRandom(),
  creatorId: text("creator_id")
    .notNull()
    .references(() => profilesTable.id, { onDelete: "restrict" }),
  title: text("title").notNull(),
  type: raceTypeEnum("type").notNull().default("quick"),
  entryType: entryTypeEnum("entry_type").notNull().default("free"),
  entryAmountCents: integer("entry_amount_cents").notNull().default(0),
  targetSteps: integer("target_steps").notNull().default(5000),
  maxPlayers: integer("max_players").notNull().default(10),
  currentPlayers: integer("current_players").notNull().default(0),
  status: raceStatusEnum("status").notNull().default("open"),
  countryCode: text("country_code"),
  teamACountry: text("team_a_country"),
  teamACountryCode: text("team_a_country_code"),
  teamBCountry: text("team_b_country"),
  teamBCountryCode: text("team_b_country_code"),
  inviteCode: text("invite_code").unique(),
  isPrivate: boolean("is_private").notNull().default(false),
  prizePoolCents: integer("prize_pool_cents").notNull().default(0),
  winnersPoolCents: integer("winners_pool_cents").notNull().default(0),
  platformFeeCents: integer("platform_fee_cents").notNull().default(0),
  coinEntryAmount: integer("coin_entry_amount").notNull().default(0),
  coinPrizePool: integer("coin_prize_pool").notNull().default(0),
  coinWinnersPool: integer("coin_winners_pool").notNull().default(0),
  coinPlatformFee: integer("coin_platform_fee").notNull().default(0),
  rewardsProcessed: boolean("rewards_processed").notNull().default(false),
  spectatorCount: integer("spectator_count").notNull().default(0),
  goalType: text("goal_type").notNull().default("daily"),
  trackLayout: text("track_layout").notNull().default("bg"),
  rewardSplitJson: jsonb("reward_split_json"),
  winnerCount: integer("winner_count").notNull().default(0),
  unawardedAmountCents: integer("unawarded_amount_cents").notNull().default(0),
  payoutFinalizedAt: timestamp("payout_finalized_at"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  // ── Scheduling ──────────────────────────────────────────────────────────────
  scheduleType: text("schedule_type").notNull().default("now"),
  scheduledStartAt: timestamp("scheduled_start_at"),
  challengeDurationDays: integer("challenge_duration_days").notNull().default(0),
  challengeEndAt: timestamp("challenge_end_at"),
  registeredCount: integer("registered_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ── Race Participants ─────────────────────────────────────────────────────────
export const raceParticipantsTable = pgTable("race_participants", {
  id: uuid("id").primaryKey().defaultRandom(),
  raceRoomId: uuid("race_room_id")
    .notNull()
    .references(() => raceRoomsTable.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => profilesTable.id, { onDelete: "restrict" }),
  status: participantStatusEnum("status").notNull().default("joined"),
  currentSteps: integer("current_steps").notNull().default(0),
  finalSteps: integer("final_steps"),
  rank: integer("rank"),
  prizeAmountCents: integer("prize_amount_cents").notNull().default(0),
  paymentId: uuid("payment_id"),
  finishedGoal: boolean("finished_goal").notNull().default(false),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  finishedAtMs: bigint("finished_at_ms", { mode: "number" }),
  finishRank: integer("finish_rank"),
  joinedAt: timestamp("joined_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  // ── Step-sync deduplication & baseline ──────────────────────────────────────
  // raceBaselineSteps: device-total steps captured at the moment this race started.
  // Lets the backend validate raceSteps = deviceTotalSteps - raceBaselineSteps.
  raceBaselineSteps: integer("race_baseline_steps").notNull().default(0),
  // latestDeviceSteps: the most recent device-total reported by this participant.
  // Useful for anti-cheat: if it ever decreases significantly, something is wrong.
  latestDeviceSteps: integer("latest_device_steps"),
  // lastStepSyncAt / lastStepSequenceId: prevent duplicate or out-of-order writes.
  // A sync is rejected (skipped) when its sequenceId ≤ lastStepSequenceId.
  lastStepSyncAt: timestamp("last_step_sync_at"),
  lastStepSequenceId: integer("last_step_sequence_id").notNull().default(0),
});

export const insertRaceRoomSchema = createInsertSchema(raceRoomsTable).omit({
  id: true,
  currentPlayers: true,
  prizePoolCents: true,
  winnersPoolCents: true,
  platformFeeCents: true,
  spectatorCount: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
});
export const selectRaceRoomSchema = createSelectSchema(raceRoomsTable);

export const insertRaceParticipantSchema = createInsertSchema(raceParticipantsTable).omit({
  id: true,
  finishedGoal: true,
  finishedAt: true,
  finishRank: true,
  joinedAt: true,
  completedAt: true,
});
export const selectRaceParticipantSchema = createSelectSchema(raceParticipantsTable);

export type RaceRoom = typeof raceRoomsTable.$inferSelect;
export type RaceParticipant = typeof raceParticipantsTable.$inferSelect;
export type InsertRaceRoom = z.infer<typeof insertRaceRoomSchema>;
export type InsertRaceParticipant = z.infer<typeof insertRaceParticipantSchema>;

// ── Room Invites ──────────────────────────────────────────────────────────────
export const roomInviteStatusEnum = pgEnum("room_invite_status", [
  "pending",
  "accepted",
  "declined",
  "expired",
]);

export const roomInvitesTable = pgTable("room_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  raceRoomId: uuid("race_room_id")
    .notNull()
    .references(() => raceRoomsTable.id, { onDelete: "cascade" }),
  inviterId: text("inviter_id").notNull(),
  inviteeId: text("invitee_id").notNull(),
  status: roomInviteStatusEnum("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type RoomInvite = typeof roomInvitesTable.$inferSelect;

// ── Scheduled Room Registrations ──────────────────────────────────────────────
export const scheduledRoomRegistrationsTable = pgTable("scheduled_room_registrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  raceRoomId: uuid("race_room_id")
    .notNull()
    .references(() => raceRoomsTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  status: text("status").notNull().default("registered"),
  registeredAt: timestamp("registered_at").notNull().defaultNow(),
  activatedAt: timestamp("activated_at"),
  cancelledAt: timestamp("cancelled_at"),
});

export type ScheduledRoomRegistration = typeof scheduledRoomRegistrationsTable.$inferSelect;

// ── Race Step Sync Logs ───────────────────────────────────────────────────────
// Audit table: every POST /races/:id/progress call writes one row.
// Used for anti-cheat review, debugging, and scheduled-race verification.
export const raceStepSyncLogsTable = pgTable("race_step_sync_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  raceId: uuid("race_id").notNull(),
  userId: text("user_id").notNull(),
  // Step source reported by the client ("healthkit", "health_connect", "simulation").
  stepSource: text("step_source"),
  // Server's record of when the race started (copied from race_rooms.started_at).
  raceStartedAt: timestamp("race_started_at"),
  // Baseline device-total at race start (race_participants.race_baseline_steps).
  baselineSteps: integer("baseline_steps"),
  // Raw device-total reported by the client this sync.
  latestDeviceSteps: integer("latest_device_steps"),
  // backend-derived race progress = latestDeviceSteps - baselineSteps (or clientSteps if higher).
  calculatedProgress: integer("calculated_progress"),
  // What was ultimately written to race_participants.current_steps.
  storedProgress: integer("stored_progress"),
  // True when progress jumped implausibly fast (early-jump or device-reset guard).
  suspicious: boolean("suspicious").notNull().default(false),
  reason: text("reason"),
  // Device-reported UTC timestamp from the sync payload (may be null if omitted).
  deviceTime: timestamp("device_time"),
  serverTime: timestamp("server_time").notNull().defaultNow(),
});

export type RaceStepSyncLog = typeof raceStepSyncLogsTable.$inferSelect;
