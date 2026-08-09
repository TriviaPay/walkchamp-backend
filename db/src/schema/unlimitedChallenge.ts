import { pgTable, text, integer, boolean, timestamp, date, index, uniqueIndex } from "drizzle-orm/pg-core";

// ══════════════════════════════════════════════════════════════════════════════
// Unlimited Challenge (`unlimited_goal`) — a multi-day, no-capacity, pooled
// real-money challenge where every participant must hit a daily step goal every
// required day (evaluated in their LOCKED IANA timezone). All qualified finishers
// split the prize pool equally. Fully additive + isolated: dedicated tables, gated
// behind FEATURE_UNLIMITED_GOAL. All money is stored as integer USD cents.
// ══════════════════════════════════════════════════════════════════════════════

// ── Challenge ─────────────────────────────────────────────────────────────────
export const unlimitedChallengesTable = pgTable(
  "unlimited_challenges",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    hostUserId: text("host_user_id").notNull(),
    title: text("title").notNull(),
    visibility: text("visibility").notNull().default("public"), // "public" | "private"
    inviteCode: text("invite_code").unique(),
    // waiting | starting | active | settling | completed | cancelled_by_platform
    status: text("status").notNull().default("waiting"),
    // ── Money (integer cents, USD) ──────────────────────────────────────────
    entryFeeCents: integer("entry_fee_cents").notNull(), // 1000–100000
    platformFeeCents: integer("platform_fee_cents").notNull().default(50), // fixed $0.50
    currency: text("currency").notNull().default("USD"),
    // ── Goal & schedule ─────────────────────────────────────────────────────
    dailyGoalSteps: integer("daily_goal_steps").notNull().default(10000), // 3000–15000
    durationDays: integer("duration_days").notNull(), // 7 | 10 | 30 | 60 | 90
    // ── THE semantic schedule ────────────────────────────────────────────────
    // The calendar date the host picked. EVERY participant starts at start_local_time on this
    // date in their OWN locked timezone, which are deliberately different UTC instants. This —
    // not start_at_utc — is the authority for participant day windows.
    // Nullable only for rows created before this column existed; backfilled in 0027.
    startLocalDate: date("start_local_date"),
    startLocalTime: text("start_local_time").notNull().default("00:00"),
    // IANA timezone the HOST chose the date in. Kept for audit, host display and historical
    // reconstruction. Must never be used to derive another participant's day boundaries.
    challengeTimezone: text("challenge_timezone"),
    // Host-zone anchor instant. Ordering, listings and legacy clients only.
    startAtUtc: timestamp("start_at_utc", { withTimezone: true }).notNull(),
    registrationClosesAtUtc: timestamp("registration_closes_at_utc", { withTimezone: true }).notNull(),
    challengeEndAtUtc: timestamp("challenge_end_at_utc", { withTimezone: true }).notNull(),
    settlementNotBeforeUtc: timestamp("settlement_not_before_utc", { withTimezone: true }).notNull(),
    startedAtUtc: timestamp("started_at_utc", { withTimezone: true }),
    // ── Pool & settlement bookkeeping ───────────────────────────────────────
    prizePoolCents: integer("prize_pool_cents").notNull().default(0),
    paidParticipantCount: integer("paid_participant_count").notNull().default(0),
    qualifiedParticipantCount: integer("qualified_participant_count"),
    zeroWinnerPolicy: text("zero_winner_policy").notNull().default("manual_review"),
    // ── Result processing ────────────────────────────────────────────────────
    // Client-facing lifecycle of the RESULT, separate from `status` (the challenge lifecycle) and
    // `settlementStatus` (the money lifecycle). Participants in different timezones finish at
    // different UTC instants, so "the host finished" is never "the challenge finished":
    //   in_progress                → at least one participant is still inside their local window
    //   waiting_for_participants   → some have finished, at least one has not
    //   steps_validation_in_progress → every window closed, some day still not verified
    //   results_ready              → settled and committed
    resultsStatus: text("results_status").notNull().default("in_progress"),
    resultsReadyAt: timestamp("results_ready_at", { withTimezone: true }),
    // Size of the settlement population captured at start, so the denominator of the result can
    // never drift as rows change afterwards.
    settlementPopulationSize: integer("settlement_population_size"),
    // pending | in_progress | completed | manual_review | rolled_over | refunded
    settlementStatus: text("settlement_status"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("unlimited_challenges_status_idx").on(t.status),
    index("unlimited_challenges_start_idx").on(t.startAtUtc),
    index("unlimited_challenges_end_idx").on(t.challengeEndAtUtc),
    index("unlimited_challenges_visibility_status_idx").on(t.visibility, t.status),
  ],
);

// ── Participant membership ────────────────────────────────────────────────────
export const unlimitedChallengeParticipantsTable = pgTable(
  "unlimited_challenge_participants",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    challengeId: text("challenge_id").notNull(),
    userId: text("user_id").notNull(),
    // Locked at join; used for ALL day-window calculations for the whole challenge. Belongs to the
    // MEMBERSHIP, not the device session — a later login, device swap, account switch or trip does
    // not change it. DST inside the zone is handled by IANA rules; the identifier stays put.
    participantTimezone: text("participant_timezone").notNull(),
    timezoneLockedAt: timestamp("timezone_locked_at", { withTimezone: true }).notNull().defaultNow(),
    // This participant's own schedule: 00:00 on the challenge's calendar date in participant_
    // timezone, and the exclusive local-midnight end durationDays later. Two participants in
    // different zones hold different instants here — that is the whole point.
    // Nullable for rows created before this column existed; backfilled in 0027.
    participantStartAtUtc: timestamp("participant_start_at_utc", { withTimezone: true }),
    participantEndAtUtc: timestamp("participant_end_at_utc", { withTimezone: true }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    // active | goal_completed_today | pending_verification | disqualified | left | qualified
    qualificationStatus: text("qualification_status").notNull().default("active"),
    disqualifiedAt: timestamp("disqualified_at", { withTimezone: true }),
    disqualificationReason: text("disqualification_reason"),
    // ── Prize-pool eligibility (explicit, never inferred by the client) ──────
    // pending | eligible | not_eligible. Separate from qualificationStatus, which mixes in live
    // day state ("goal_completed_today"); this answers only "does this membership take a share".
    prizePoolEligibilityStatus: text("prize_pool_eligibility_status").notNull().default("pending"),
    // daily_goal_missed | left_challenge | removed | verification_failed | manual_review |
    // simulation | all_days_passed. Audit/ops detail — the API exposes a coarsened form.
    eligibilityReasonCode: text("eligibility_reason_code"),
    eligibilityFinalizedAt: timestamp("eligibility_finalized_at", { withTimezone: true }),
    // Captured at challenge start: whether this membership counts toward "have all participants
    // finished?" and toward the settlement denominator. Never recomputed afterwards, so the
    // result population cannot change unpredictably mid-challenge.
    inSettlementPopulation: boolean("in_settlement_population").notNull().default(true),
    entryContributionCents: integer("entry_contribution_cents").notNull(),
    platformFeeCents: integer("platform_fee_cents").notNull().default(50),
    paymentReference: text("payment_reference"),
    payoutCents: integer("payout_cents"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("unlimited_participants_challenge_user_uniq").on(t.challengeId, t.userId),
    index("unlimited_participants_user_idx").on(t.userId),
    index("unlimited_participants_challenge_status_idx").on(t.challengeId, t.qualificationStatus),
    // Settlement asks "has every eligible participant's local run ended yet?" — see
    // maxParticipantEndAtUtc in unlimitedChallengeSettlement.ts.
    index("unlimited_participants_challenge_end_idx").on(t.challengeId, t.participantEndAtUtc),
  ],
);

// ── Per-participant per-day qualification record ──────────────────────────────
export const unlimitedChallengeDaysTable = pgTable(
  "unlimited_challenge_days",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    challengeId: text("challenge_id").notNull(),
    participantId: text("participant_id").notNull(),
    userId: text("user_id").notNull(),
    dayNumber: integer("day_number").notNull(), // 1..durationDays
    localDate: date("local_date").notNull(), // participant locked-tz calendar date
    timezone: text("timezone").notNull(),
    windowStartUtc: timestamp("window_start_utc", { withTimezone: true }).notNull(),
    windowEndUtc: timestamp("window_end_utc", { withTimezone: true }).notNull(),
    goalSteps: integer("goal_steps").notNull(),
    verifiedSteps: integer("verified_steps").notNull().default(0),
    // DISPLAY ONLY — never read by qualification or settlement, which always use the full daily
    // verified total. The verified count already on record for this local date when the window
    // opened, so the live board can show "steps during this challenge day" as
    // verifiedSteps - startBaselineSteps. Normally 0: the window opens at local midnight, which is
    // also when the daily bucket resets. Non-zero only when a day is activated after its window
    // already opened (a heal, or a participant whose device day is offset from their locked day).
    startBaselineSteps: integer("start_baseline_steps").notNull().default(0),
    baselineCapturedAt: timestamp("baseline_captured_at", { withTimezone: true }),
    // pending | in_progress | pending_verification | passed | failed
    status: text("status").notNull().default("pending"),
    passedAt: timestamp("passed_at", { withTimezone: true }),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("unlimited_days_participant_day_uniq").on(t.challengeId, t.participantId, t.dayNumber),
    index("unlimited_days_challenge_local_date_idx").on(t.challengeId, t.localDate),
    index("unlimited_days_finalize_idx").on(t.status, t.windowEndUtc),
  ],
);

// ── Immutable payout allocation (one per qualified participant per challenge) ──
export const unlimitedChallengePayoutsTable = pgTable(
  "unlimited_challenge_payouts",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    challengeId: text("challenge_id").notNull(),
    participantId: text("participant_id").notNull(),
    userId: text("user_id").notNull(),
    payoutCents: integer("payout_cents").notNull(),
    // Optional linkage note; the authoritative wallet row is found via
    // wallet_transactions.race_room_id = challengeId + userId (idempotency key).
    walletTxId: text("wallet_tx_id"),
    status: text("status").notNull().default("pending"), // pending | credited | failed
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One payout allocation per participant per challenge (settlement idempotency).
    uniqueIndex("unlimited_payouts_challenge_participant_uniq").on(t.challengeId, t.participantId),
    index("unlimited_payouts_challenge_idx").on(t.challengeId),
  ],
);

export type UnlimitedChallenge = typeof unlimitedChallengesTable.$inferSelect;
export type UnlimitedChallengeParticipant = typeof unlimitedChallengeParticipantsTable.$inferSelect;
export type UnlimitedChallengeDay = typeof unlimitedChallengeDaysTable.$inferSelect;
export type UnlimitedChallengePayout = typeof unlimitedChallengePayoutsTable.$inferSelect;
