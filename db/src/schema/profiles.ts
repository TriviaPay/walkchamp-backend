import { pgTable, text, boolean, integer, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const accountStatusEnum = pgEnum("account_status", [
  "active",
  "pending_verification",
  "suspended",
  "banned",
  "deleted",
]);

export const kycStatusEnum = pgEnum("kyc_status", [
  "not_required",
  "required",
  "pending",
  "approved",
  "rejected",
]);

export const profilesTable = pgTable("profiles", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  fullName: text("full_name").notNull(),
  username: text("username").notNull().unique(),
  dateOfBirth: text("date_of_birth"),
  // NOTE: `age`/`is_adult` are derived from dateOfBirth — `age` was dropped
  // (never read) and adulthood is computed at read time via computeIsAdult().
  country: text("country"),
  countryCode: text("country_code"),
  countryFlag: text("country_flag"),
  region: text("region"),
  phoneNumber: text("phone_number"),
  referralCode: text("referral_code"),
  referredBy: text("referred_by"),
  authProvider: text("auth_provider").notNull().default("email"),
  emailVerified: boolean("email_verified").notNull().default(false),
  termsAccepted: boolean("terms_accepted").notNull().default(false),
  privacyAccepted: boolean("privacy_accepted").notNull().default(false),
  rewardDisclaimerAccepted: boolean("reward_disclaimer_accepted").notNull().default(false),
  fairPlayAccepted: boolean("fair_play_accepted").notNull().default(false),
  marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
  isAdult: boolean("is_adult").notNull().default(false),
  paidRaceEnabled: boolean("paid_race_enabled").notNull().default(false),
  withdrawalsEnabled: boolean("withdrawals_enabled").notNull().default(false),
  kycStatus: kycStatusEnum("kyc_status").notNull().default("not_required"),
  accountStatus: accountStatusEnum("account_status").notNull().default("pending_verification"),
  fraudScore: integer("fraud_score").notNull().default(0),
  avatarColor: text("avatar_color").notNull().default("#00E676"),
  avatarUrl: text("avatar_url"),
  bio: text("bio"),
  profileCompleted: boolean("profile_completed").notNull().default(false),
  stripeCustomerId: text("stripe_customer_id"),
  // Cash balance lives in the `wallets` table (availableBalanceCents). The old
  // `wallet_balance` column here was unused/legacy and has been dropped.
  totalSteps: integer("total_steps").notNull().default(0),
  currentStreak: integer("current_streak").notNull().default(0),
  currentRank: integer("current_rank").notNull().default(9999),
  level: integer("level").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at"),
  lastSeenAt: timestamp("last_seen_at"),
});

export const insertProfileSchema = createInsertSchema(profilesTable).omit({
  createdAt: true,
  updatedAt: true,
  lastLoginAt: true,
  lastSeenAt: true,
  fraudScore: true,
  totalSteps: true,
  currentStreak: true,
  currentRank: true,
  level: true,
});

export const selectProfileSchema = createSelectSchema(profilesTable);

export type InsertProfile = z.infer<typeof insertProfileSchema>;
export type Profile = typeof profilesTable.$inferSelect;
