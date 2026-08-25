import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { profilesTable } from "./profiles.js";
import { raceParticipantsTable, raceRoomsTable } from "./races.js";

export const raceVerificationSessionsTable = pgTable("race_verification_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  raceId: uuid("race_id").notNull().references(() => raceRoomsTable.id, { onDelete: "cascade" }),
  participantId: uuid("participant_id").notNull().references(() => raceParticipantsTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => profilesTable.id, { onDelete: "restrict" }),
  authSessionId: text("auth_session_id").notNull(),
  registeredDeviceId: text("registered_device_id").notNull(),
  platform: text("platform").notNull(),
  approvedHealthPlatform: text("approved_health_platform").notNull(),
  approvedSource: text("approved_source").notNull(),
  serverStartAt: timestamp("server_start_at", { withTimezone: true }),
  serverEndAt: timestamp("server_end_at", { withTimezone: true }),
  appVersion: text("app_version"),
  buildNumber: text("build_number"),
  integrityStatus: text("integrity_status").notNull().default("pending"),
  continuityStatus: text("continuity_status").notNull().default("HEALTHY"),
  reviewReasons: jsonb("review_reasons").$type<string[]>().notNull().default([]),
  lastContactAt: timestamp("last_contact_at", { withTimezone: true }).notNull().defaultNow(),
  offlineSince: timestamp("offline_since", { withTimezone: true }),
  cumulativeOfflineSeconds: integer("cumulative_offline_seconds").notNull().default(0),
  maxContinuousOfflineSeconds: integer("max_continuous_offline_seconds").notNull().default(0),
  permissionStatus: text("permission_status").notNull().default("unknown"),
  sourceStable: boolean("source_stable").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("race_verification_sessions_race_user_uniq").on(t.raceId, t.userId),
  uniqueIndex("race_verification_sessions_race_participant_uniq").on(t.raceId, t.participantId),
  index("race_verification_sessions_status_idx").on(t.raceId, t.integrityStatus, t.continuityStatus),
  index("race_verification_sessions_device_idx").on(t.registeredDeviceId),
]);

export const integrityChallengesTable = pgTable("integrity_challenges", {
  id: uuid("id").primaryKey().defaultRandom(),
  verificationSessionId: uuid("verification_session_id").notNull()
    .references(() => raceVerificationSessionsTable.id, { onDelete: "cascade" }),
  raceId: uuid("race_id").notNull().references(() => raceRoomsTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => profilesTable.id, { onDelete: "restrict" }),
  registeredDeviceId: text("registered_device_id").notNull(),
  purpose: text("purpose").notNull(),
  challengeHash: text("challenge_hash").notNull(),
  expectedRequestHash: text("expected_request_hash"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("integrity_challenges_hash_uniq").on(t.challengeHash),
  index("integrity_challenges_session_lookup_idx").on(t.verificationSessionId, t.purpose, t.expiresAt),
  index("integrity_challenges_unconsumed_idx").on(t.expiresAt)
    .where(sql`${t.consumedAt} IS NULL`),
]);

export const raceResultEvidenceTable = pgTable("race_result_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  raceId: uuid("race_id").notNull().references(() => raceRoomsTable.id, { onDelete: "cascade" }),
  participantId: uuid("participant_id").notNull().references(() => raceParticipantsTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => profilesTable.id, { onDelete: "restrict" }),
  verificationSessionId: uuid("verification_session_id").notNull()
    .references(() => raceVerificationSessionsTable.id, { onDelete: "restrict" }),
  challengeId: uuid("challenge_id").notNull().references(() => integrityChallengesTable.id, { onDelete: "restrict" }),
  platform: text("platform").notNull(),
  appVersion: text("app_version"),
  registeredDeviceId: text("registered_device_id").notNull(),
  serverStartAt: timestamp("server_start_at", { withTimezone: true }).notNull(),
  serverEndAt: timestamp("server_end_at", { withTimezone: true }).notNull(),
  approvedSource: text("approved_source").notNull(),
  qualifyingSteps: integer("qualifying_steps").notNull(),
  provisionalSteps: integer("provisional_steps").notNull(),
  verificationReadAt: timestamp("verification_read_at", { withTimezone: true }).notNull(),
  sourceVerdict: text("source_verdict").notNull(),
  integrityVerdict: text("integrity_verdict").notNull(),
  continuityVerdict: text("continuity_verdict").notNull(),
  reconciliationVerdict: text("reconciliation_verdict").notNull(),
  fraudRiskVerdict: text("fraud_risk_verdict").notNull(),
  offlineVerdict: text("offline_verdict").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  canonicalRequestHash: text("canonical_request_hash").notNull(),
  integrityProvider: text("integrity_provider").notNull(),
  integrityReference: text("integrity_reference"),
  riskSignals: jsonb("risk_signals").$type<string[]>().notNull().default([]),
  sourceEvidenceSummary: jsonb("source_evidence_summary").$type<{
    automaticRecordCount: number;
    manualEntryCount: number;
    sourceIdHashes: string[];
    recordingMethods: string[];
  }>(),
  winningMargin: integer("winning_margin"),
  closeResultThreshold: integer("close_result_threshold"),
  closeResultFlag: boolean("close_result_flag").notNull().default(false),
  closeResultGroup: text("close_result_group"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("race_result_evidence_session_hash_uniq").on(t.verificationSessionId, t.evidenceHash),
  uniqueIndex("race_result_evidence_race_participant_uniq").on(t.raceId, t.participantId),
  uniqueIndex("race_result_evidence_challenge_uniq").on(t.challengeId),
  index("race_result_evidence_race_idx").on(t.raceId),
  index("race_result_evidence_participant_idx").on(t.participantId),
]);

export const raceAdjudicationEventsTable = pgTable("race_adjudication_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  raceId: uuid("race_id").notNull().references(() => raceRoomsTable.id, { onDelete: "cascade" }),
  participantId: uuid("participant_id").references(() => raceParticipantsTable.id, { onDelete: "set null" }),
  verificationSessionId: uuid("verification_session_id")
    .references(() => raceVerificationSessionsTable.id, { onDelete: "set null" }),
  eventType: text("event_type").notNull(),
  oldDecision: text("old_decision"),
  newDecision: text("new_decision").notNull(),
  reasonCode: text("reason_code").notNull(),
  actorType: text("actor_type").notNull().default("system"),
  actorUserId: text("actor_user_id"),
  evidenceReference: text("evidence_reference"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("race_adjudication_events_race_idx").on(t.raceId, t.createdAt),
  index("race_adjudication_events_participant_idx").on(t.participantId, t.createdAt),
]);

export type RaceVerificationSession = typeof raceVerificationSessionsTable.$inferSelect;
export type RaceResultEvidence = typeof raceResultEvidenceTable.$inferSelect;
