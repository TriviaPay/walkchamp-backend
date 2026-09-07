/**
 * Unlimited Daily Goal Challenge — delayed global result processing.
 *
 * THE RULE: an Unlimited challenge produces no final result until every participant in the
 * settlement population has passed their OWN local challenge end, and every required day has a
 * terminal verification state. Participants hold different effective day timezones, so "the host
 * finished", "the first participant finished" and "the viewer finished" are all meaningless as
 * finalization triggers — only the LAST local end matters.
 *
 * This module owns the result lifecycle. Money still moves in unlimitedChallengeSettlement.ts;
 * nothing here credits a wallet.
 */

import { and, eq, ne, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import {
  unlimitedChallengesTable,
  unlimitedChallengeParticipantsTable,
  unlimitedChallengeDaysTable,
  type UnlimitedChallenge,
} from "../../db/src/schema/unlimitedChallenge.js";
import { profilesTable } from "../../db/src/schema/profiles.js";
import { emitUnlimitedRealtime } from "./unlimitedRealtime.js";
import { logger } from "./logger.js";
import { sendNotification } from "../routes/notifications.js";
import { STREAK_CHALLENGE_KIND } from "./streakChallengeContract.js";
import { config } from "./config.js";
import { UNLIMITED_LEFT_STATUSES } from "./unlimitedChallengeStatuses.js";
import {
  isConfiguredParticipationExcludedUser,
  isReservedParticipationIdentity,
} from "./challengeParticipation.js";

// ── Status vocabularies ───────────────────────────────────────────────────────

export type UnlimitedChallengeResultsStatus =
  | "in_progress"
  | "waiting_for_participants"
  | "steps_validation_in_progress"
  | "results_ready";

export type PrizePoolEligibilityStatus = "pending" | "eligible" | "not_eligible";

export type EligibilityReasonCode =
  | "all_days_passed"
  | "daily_goal_missed"
  | "left_challenge"
  | "removed"
  | "verification_failed"
  | "manual_review"
  | "simulation";

/** Client-facing day status (§14). */
export type UnlimitedDayStatus =
  | "upcoming"
  | "in_progress"
  | "validation_pending"
  | "passed"
  | "failed";

/** A day is finished deciding once it is passed or failed — nothing else is terminal. */
export const TERMINAL_DAY_STATUSES = ["passed", "failed"] as const;
/** Stored statuses that still need work before a result can be published. */
export const NON_TERMINAL_DAY_STATUSES = ["pending", "in_progress", "pending_verification"] as const;

/**
 * Map the STORED day status onto the client-facing vocabulary.
 *
 * Storage keeps one `pending` state for "not yet credited"; the client needs to tell a day that
 * has not started (`upcoming`) from the one currently open (`in_progress`), which is a question
 * about the window, not the row. `pending_verification` surfaces as `validation_pending`.
 */
export function toDayStatus(
  stored: string,
  windowStartUtc: Date,
  windowEndUtc: Date,
  now: Date = new Date(),
): UnlimitedDayStatus {
  if (stored === "passed") return "passed";
  if (stored === "failed") return "failed";
  if (stored === "pending_verification") return "validation_pending";
  // Stored `pending` / `in_progress` — the window decides which it is.
  if (now.getTime() < windowStartUtc.getTime()) return "upcoming";
  if (now.getTime() >= windowEndUtc.getTime()) return "validation_pending";
  return "in_progress";
}

// ── §21 Wait condition ────────────────────────────────────────────────────────

export interface WindowClosureState {
  /** True only when every participant in the settlement population has passed their local end. */
  allClosed: boolean;
  registeredParticipantCount: number;
  participantsFinishedCount: number;
  participantsPendingCount: number;
  /** The last local end across the population — the earliest instant results may be processed. */
  latestParticipantEndAtUtc: Date | null;
}

/**
 * §21 — have ALL settlement participants reached their own local challenge end?
 *
 * Never consults the host's end or the challenge's own end timestamp. A participant with no
 * resolvable end counts as PENDING, not finished: an unknown end can never be evidence that a
 * challenge is over.
 */
export async function areAllParticipantWindowsClosed(
  challengeId: string,
  now: Date = new Date(),
): Promise<WindowClosureState> {
  const [row] = await db
    .select({
      registered: sql<number>`count(*)::int`,
      finished: sql<number>`count(*) filter (
        where ${unlimitedChallengeParticipantsTable.participantEndAtUtc} is not null
          and ${unlimitedChallengeParticipantsTable.participantEndAtUtc} <= ${now}
      )::int`,
      latestEnd: sql<Date | null>`max(${unlimitedChallengeParticipantsTable.participantEndAtUtc})`,
      unresolved: sql<number>`count(*) filter (
        where ${unlimitedChallengeParticipantsTable.participantEndAtUtc} is null
      )::int`,
    })
    .from(unlimitedChallengeParticipantsTable)
    .where(and(
      eq(unlimitedChallengeParticipantsTable.challengeId, challengeId),
      eq(unlimitedChallengeParticipantsTable.inSettlementPopulation, true),
    ));

  const registered = row?.registered ?? 0;
  const finished = row?.finished ?? 0;
  const unresolved = row?.unresolved ?? 0;
  const latestEnd = row?.latestEnd ?? null;

  return {
    // An empty population is not "all closed" — there is nothing to settle and no proof of an end.
    allClosed: registered > 0 && unresolved === 0 && finished === registered,
    registeredParticipantCount: registered,
    participantsFinishedCount: finished,
    participantsPendingCount: Math.max(0, registered - finished),
    latestParticipantEndAtUtc: latestEnd ? (latestEnd instanceof Date ? latestEnd : new Date(latestEnd)) : null,
  };
}

// ── §22 Validation completion ────────────────────────────────────────────────

export interface ValidationState {
  /** True when every required day of every settlement participant is passed or failed. */
  allDaysTerminal: boolean;
  pendingDayCount: number;
  /** Participants who still hold at least one non-terminal day. */
  participantsAwaitingValidation: number;
  /** Required rows absent (or extra) across the frozen population. */
  incompleteParticipantCount: number;
  missingDayCount: number;
}

/**
 * §22 — is every required day of every settlement participant terminal?
 *
 * Days belonging to participants outside the settlement population or participants who forfeited
 * after start are ignored here: they cannot qualify, so their unverified days must not hold every
 * eligible participant's result. They remain in areAllParticipantWindowsClosed for timing.
 */
export async function areAllRequiredDaysTerminal(challengeId: string): Promise<ValidationState> {
  const [challenge] = await db
    .select({
      durationDays: unlimitedChallengesTable.durationDays,
      settlementPopulationSize: unlimitedChallengesTable.settlementPopulationSize,
    })
    .from(unlimitedChallengesTable)
    .where(eq(unlimitedChallengesTable.id, challengeId))
    .limit(1);
  if (!challenge) {
    return {
      allDaysTerminal: false,
      pendingDayCount: 0,
      participantsAwaitingValidation: 0,
      incompleteParticipantCount: 0,
      missingDayCount: 0,
    };
  }

  const rows = await db
    .select({
      participantId: unlimitedChallengeParticipantsTable.id,
      total: sql<number>`count(${unlimitedChallengeDaysTable.id})::int`,
      terminal: sql<number>`count(${unlimitedChallengeDaysTable.id}) filter (
        where ${unlimitedChallengeDaysTable.status} in ('passed', 'failed')
      )::int`,
      pending: sql<number>`count(${unlimitedChallengeDaysTable.id}) filter (
        where ${unlimitedChallengeDaysTable.status} in ('pending', 'in_progress', 'pending_verification')
      )::int`,
    })
    .from(unlimitedChallengeParticipantsTable)
    .leftJoin(
      unlimitedChallengeDaysTable,
      eq(unlimitedChallengeParticipantsTable.id, unlimitedChallengeDaysTable.participantId),
    )
    .where(and(
      eq(unlimitedChallengeParticipantsTable.challengeId, challengeId),
      eq(unlimitedChallengeParticipantsTable.inSettlementPopulation, true),
      // Forfeits remain in the frozen timing population above, but they no longer owe prize
      // verification or terminal day evidence because they can never receive a payout.
      notInArray(unlimitedChallengeParticipantsTable.qualificationStatus, [...UNLIMITED_LEFT_STATUSES]),
    ))
    .groupBy(unlimitedChallengeParticipantsTable.id);

  const pendingDayCount = rows.reduce((sum, r) => sum + r.pending, 0);
  const incomplete = rows.filter((r) => r.total !== challenge.durationDays);
  const missingDayCount = incomplete.reduce(
    (sum, r) => sum + Math.max(0, challenge.durationDays - r.total),
    0,
  );
  return {
    allDaysTerminal:
      (rows.length > 0 || (challenge.settlementPopulationSize ?? 0) > 0)
      && incomplete.length === 0
      && rows.every((r) => r.terminal === challenge.durationDays),
    pendingDayCount,
    participantsAwaitingValidation: rows.filter((r) => r.pending > 0 || r.terminal !== challenge.durationDays).length,
    incompleteParticipantCount: incomplete.length,
    missingDayCount,
  };
}

export interface FinalVerificationState {
  allCompleted: boolean;
  participantCount: number;
  pendingParticipantCount: number;
  submittedParticipantCount: number;
  completedParticipantCount: number;
}

/** Request one post-boundary provider reconciliation from every frozen participant. */
export async function requestFinalParticipantVerifications(
  challengeId: string,
  now: Date = new Date(),
): Promise<FinalVerificationState> {
  const closure = await areAllParticipantWindowsClosed(challengeId, now);
  if (!closure.allClosed) {
    return {
      allCompleted: false,
      participantCount: closure.registeredParticipantCount,
      pendingParticipantCount: closure.registeredParticipantCount,
      submittedParticipantCount: 0,
      completedParticipantCount: 0,
    };
  }

  // The four-hour verification clock is anchored to the ACTUAL latest valid participant end,
  // not the host-zone placeholder created before the participant population was known. Keeping
  // the stored scheduler timestamp in sync makes the minute reconciler attempt settlement at the
  // correct instant; settleUnlimitedChallenge independently re-checks the same boundary.
  if (closure.latestParticipantEndAtUtc) {
    const settlementEligibleAt = new Date(
      closure.latestParticipantEndAtUtc.getTime() + config.streakChallenge.graceMs,
    );
    await db
      .update(unlimitedChallengesTable)
      .set({ settlementNotBeforeUtc: settlementEligibleAt, updatedAt: now })
      .where(and(
        eq(unlimitedChallengesTable.id, challengeId),
        sql`${unlimitedChallengesTable.settlementNotBeforeUtc} is distinct from ${settlementEligibleAt}`,
      ));
  }

  const requested = await db
    .update(unlimitedChallengeParticipantsTable)
    .set({
      finalVerificationStatus: "requested",
      finalVerificationRequestedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(unlimitedChallengeParticipantsTable.challengeId, challengeId),
      eq(unlimitedChallengeParticipantsTable.inSettlementPopulation, true),
      notInArray(unlimitedChallengeParticipantsTable.qualificationStatus, [...UNLIMITED_LEFT_STATUSES]),
      eq(unlimitedChallengeParticipantsTable.finalVerificationStatus, "pending"),
    ))
    .returning({
      id: unlimitedChallengeParticipantsTable.id,
      userId: unlimitedChallengeParticipantsTable.userId,
    });

  if (requested.length > 0) {
    emitUnlimitedRealtime(challengeId, "final_verification_requested", {
      challengeId,
      participantCount: closure.registeredParticipantCount,
      requestedAt: now.toISOString(),
    }, {
      event: "race:final-verification-requested",
      payload: { raceId: challengeId, challengeType: "unlimited_goal", challengeKind: STREAK_CHALLENGE_KIND },
    });
    for (const participant of requested) {
      void sendNotification(
        participant.userId,
        "race_verification_pending",
        "Final results are being verified",
        "Open WalkChamp so we can confirm your final challenge day with your health app.",
        { challengeId, dedupeKey: `unlimited_final_verification:${challengeId}:${participant.userId}` },
      ).catch(() => {});
    }
  }
  return areAllFinalParticipantVerificationsComplete(challengeId);
}

export async function areAllFinalParticipantVerificationsComplete(
  challengeId: string,
): Promise<FinalVerificationState> {
  const [row] = await db
    .select({
      participants: sql<number>`count(*)::int`,
      pending: sql<number>`count(*) filter (
        where ${unlimitedChallengeParticipantsTable.finalVerificationStatus} <> 'completed'
      )::int`,
      submitted: sql<number>`count(*) filter (
        where ${unlimitedChallengeParticipantsTable.finalVerificationStatus} = 'submitted'
      )::int`,
      completed: sql<number>`count(*) filter (
        where ${unlimitedChallengeParticipantsTable.finalVerificationStatus} = 'completed'
      )::int`,
    })
    .from(unlimitedChallengeParticipantsTable)
    .where(and(
      eq(unlimitedChallengeParticipantsTable.challengeId, challengeId),
      eq(unlimitedChallengeParticipantsTable.inSettlementPopulation, true),
      notInArray(unlimitedChallengeParticipantsTable.qualificationStatus, [...UNLIMITED_LEFT_STATUSES]),
    ));
  const participantCount = row?.participants ?? 0;
  const pendingParticipantCount = row?.pending ?? participantCount;
  const submittedParticipantCount = row?.submitted ?? 0;
  const completedParticipantCount = row?.completed ?? 0;
  return {
    // A challenge whose entire frozen population forfeited has nobody left to verify. The frozen
    // window boundary still gates settlement, so zero here is a completed verification set.
    allCompleted: pendingParticipantCount === 0,
    participantCount,
    pendingParticipantCount,
    submittedParticipantCount,
    completedParticipantCount,
  };
}

// ── §5–§9 Results status ─────────────────────────────────────────────────────

export interface ResultsState extends WindowClosureState {
  resultsStatus: UnlimitedChallengeResultsStatus;
  pendingDayCount: number;
  participantsAwaitingValidation: number;
}

/**
 * Derive (without writing) the result status of a challenge.
 *
 *   in_progress                  — nobody has finished yet
 *   waiting_for_participants     — some finished, at least one still inside their local window
 *   steps_validation_in_progress — every window closed, at least one day not yet verified
 *   results_ready                — settlement committed (the settled flag is the authority)
 *
 * results_ready is NOT inferred from the clock: it is only true once settlement has actually
 * persisted payouts, which is what makes it safe for a client to render a final board.
 */
export async function deriveResultsState(
  challenge: Pick<UnlimitedChallenge, "id" | "status" | "settlementStatus" | "resultsStatus">,
  now: Date = new Date(),
): Promise<ResultsState> {
  const closure = await areAllParticipantWindowsClosed(challenge.id, now);

  // Terminal challenges are done, whatever the clock says.
  if (challenge.status === "completed" || challenge.status === "cancelled_by_platform") {
    return { ...closure, resultsStatus: "results_ready", pendingDayCount: 0, participantsAwaitingValidation: 0 };
  }

  if (!closure.allClosed) {
    return {
      ...closure,
      // Once ANY participant has crossed their own end, the honest message is that we are waiting
      // on the others — not that the challenge is still generically "in progress".
      resultsStatus: closure.participantsFinishedCount > 0 ? "waiting_for_participants" : "in_progress",
      pendingDayCount: 0,
      participantsAwaitingValidation: 0,
    };
  }

  const validation = await areAllRequiredDaysTerminal(challenge.id);
  return {
    ...closure,
    // Every window is closed. Until settlement commits, the result is still being computed —
    // reporting results_ready here would show a board that can still change.
    resultsStatus: "steps_validation_in_progress",
    pendingDayCount: validation.pendingDayCount,
    participantsAwaitingValidation: validation.participantsAwaitingValidation,
  };
}

/**
 * Recompute and persist a challenge's results status, emitting on every transition.
 *
 * Idempotent: the UPDATE is a compare-and-set on the previous value, so concurrent reconciler
 * ticks cannot emit the same transition twice. results_ready is written only by the settlement
 * transaction after all gates pass — this function never promotes into it.
 */
export async function refreshUnlimitedResultsStatus(
  challengeId: string,
  now: Date = new Date(),
): Promise<ResultsState | null> {
  const [challenge] = await db
    .select({
      id: unlimitedChallengesTable.id,
      status: unlimitedChallengesTable.status,
      settlementStatus: unlimitedChallengesTable.settlementStatus,
      resultsStatus: unlimitedChallengesTable.resultsStatus,
    })
    .from(unlimitedChallengesTable)
    .where(eq(unlimitedChallengesTable.id, challengeId))
    .limit(1);
  if (!challenge) return null;
  // Never walk a published result backwards.
  if (challenge.resultsStatus === "results_ready") return null;

  const state = await deriveResultsState(challenge, now);
  if (state.resultsStatus === challenge.resultsStatus) return state;
  if (state.resultsStatus === "results_ready") return state; // owned by settlement

  const [changed] = await db
    .update(unlimitedChallengesTable)
    .set({ resultsStatus: state.resultsStatus, updatedAt: now })
    .where(and(
      eq(unlimitedChallengesTable.id, challengeId),
      eq(unlimitedChallengesTable.resultsStatus, challenge.resultsStatus),
    ))
    .returning({ id: unlimitedChallengesTable.id });
  if (!changed) return state; // another worker transitioned it first

  logger.info(
    {
      challengeId,
      from: challenge.resultsStatus,
      to: state.resultsStatus,
      registered: state.registeredParticipantCount,
      finished: state.participantsFinishedCount,
      pending: state.participantsPendingCount,
      pendingDays: state.pendingDayCount,
    },
    "[Unlimited] results status changed",
  );
  emitUnlimitedRealtime(challengeId, "results_status_changed", {
    challengeId,
    resultsStatus: state.resultsStatus,
    registeredParticipantCount: state.registeredParticipantCount,
    participantsFinishedCount: state.participantsFinishedCount,
    participantsPendingCount: state.participantsPendingCount,
    latestParticipantEndAtUtc: state.latestParticipantEndAtUtc,
    updatedAt: now.toISOString(),
  });
  return state;
}

// ── §2 Settlement population ─────────────────────────────────────────────────

/**
 * Freeze the settlement population at challenge start.
 *
 * Everyone still holding a live membership when the challenge begins is in; anyone who left
 * before the start is out (they were refunded and hold no claim). Ghost hosts never appear here —
 * Walk Champ Admin is not a participant row, so it has no membership to include, no local window
 * to wait for, and no day records.
 *
 * The size is stored on the challenge so the result denominator is fixed at the same instant.
 */
export async function captureSettlementPopulation(challengeId: string): Promise<number> {
  const [challenge] = await db
    .select({
      settlementPopulationSize: unlimitedChallengesTable.settlementPopulationSize,
      startedAtUtc: unlimitedChallengesTable.startedAtUtc,
    })
    .from(unlimitedChallengesTable)
    .where(eq(unlimitedChallengesTable.id, challengeId))
    .limit(1);
  if (!challenge) return 0;
  // Once captured, never recompute from later membership status changes.
  if (challenge.settlementPopulationSize != null) return challenge.settlementPopulationSize;

  const identities = await db
    .select({
      participantId: unlimitedChallengeParticipantsTable.id,
      userId: unlimitedChallengeParticipantsTable.userId,
      username: profilesTable.username,
      email: profilesTable.email,
      qualificationStatus: unlimitedChallengeParticipantsTable.qualificationStatus,
      leftAt: unlimitedChallengeParticipantsTable.leftAt,
    })
    .from(unlimitedChallengeParticipantsTable)
    .leftJoin(profilesTable, eq(profilesTable.id, unlimitedChallengeParticipantsTable.userId))
    .where(eq(unlimitedChallengeParticipantsTable.challengeId, challengeId));
  const excludedIds = identities
    .filter((row) => {
      const inactive = ["left", "forfeited", "withdrawn", "quit"].includes(row.qualificationStatus);
      const departedBeforeStart = inactive && (
        !challenge.startedAtUtc
        || !row.leftAt
        || row.leftAt.getTime() < challenge.startedAtUtc.getTime()
      );
      return departedBeforeStart
        || isConfiguredParticipationExcludedUser(row.userId)
        || isReservedParticipationIdentity({ username: row.username, email: row.email });
    })
    .map((row) => row.participantId);
  if (excludedIds.length > 0) {
    await db
      .update(unlimitedChallengeParticipantsTable)
      .set({ inSettlementPopulation: false, updatedAt: new Date() })
      .where(inArray(unlimitedChallengeParticipantsTable.id, excludedIds));
  }

  const [row] = await db
    .select({ population: sql<number>`count(*)::int` })
    .from(unlimitedChallengeParticipantsTable)
    .where(and(
      eq(unlimitedChallengeParticipantsTable.challengeId, challengeId),
      eq(unlimitedChallengeParticipantsTable.inSettlementPopulation, true),
    ));
  const population = row?.population ?? 0;

  await db
    .update(unlimitedChallengesTable)
    .set({ settlementPopulationSize: population, updatedAt: new Date() })
    .where(eq(unlimitedChallengesTable.id, challengeId));

  logger.info({ challengeId, population }, "[Unlimited] settlement population captured");
  return population;
}

// ── §10, §11, §18 Eligibility ────────────────────────────────────────────────

export interface ParticipantEligibility {
  participantId: string;
  userId: string;
  status: PrizePoolEligibilityStatus;
  reasonCode: EligibilityReasonCode | null;
  passedDays: number;
  failedDays: number;
  pendingDays: number;
}

/**
 * §11/§18 — eligibility is "passed EVERY required day", never a step total.
 *
 * A participant who walks 100,000 steps across a 7-day challenge but records 8,000 on one day is
 * not eligible; a later 15,000-step day cannot repay an earlier miss. Requires the participant to
 * hold exactly durationDays terminal days, all passed.
 */
export async function evaluateParticipantEligibility(
  challengeId: string,
  durationDays: number,
): Promise<ParticipantEligibility[]> {
  const participants = await db
    .select({
      participantId: unlimitedChallengeParticipantsTable.id,
      userId: unlimitedChallengeParticipantsTable.userId,
      qualificationStatus: unlimitedChallengeParticipantsTable.qualificationStatus,
      disqualificationReason: unlimitedChallengeParticipantsTable.disqualificationReason,
      inPopulation: unlimitedChallengeParticipantsTable.inSettlementPopulation,
    })
    .from(unlimitedChallengeParticipantsTable)
    .where(eq(unlimitedChallengeParticipantsTable.challengeId, challengeId));

  const dayAgg = await db
    .select({
      participantId: unlimitedChallengeDaysTable.participantId,
      passed: sql<number>`count(*) filter (where ${unlimitedChallengeDaysTable.status} = 'passed')::int`,
      failed: sql<number>`count(*) filter (where ${unlimitedChallengeDaysTable.status} = 'failed')::int`,
      pending: sql<number>`count(*) filter (where ${unlimitedChallengeDaysTable.status} in ('pending', 'in_progress', 'pending_verification'))::int`,
    })
    .from(unlimitedChallengeDaysTable)
    .where(eq(unlimitedChallengeDaysTable.challengeId, challengeId))
    .groupBy(unlimitedChallengeDaysTable.participantId);
  const byParticipant = new Map(dayAgg.map((d) => [d.participantId, d]));

  return participants.map((p) => {
    const agg = byParticipant.get(p.participantId);
    const passedDays = agg?.passed ?? 0;
    const failedDays = agg?.failed ?? 0;
    const pendingDays = agg?.pending ?? 0;

    // Terminal membership states decide on their own.
    if ((UNLIMITED_LEFT_STATUSES as readonly string[]).includes(p.qualificationStatus) || !p.inPopulation) {
      return { ...p, status: "not_eligible" as const, reasonCode: "left_challenge" as const, passedDays, failedDays, pendingDays };
    }
    if (p.qualificationStatus === "disqualified") {
      const reason = (p.disqualificationReason ?? "daily_goal_missed") as EligibilityReasonCode;
      return { ...p, status: "not_eligible" as const, reasonCode: reason, passedDays, failedDays, pendingDays };
    }
    // A single failed day is terminal — no later day can repay it.
    if (failedDays > 0) {
      return { ...p, status: "not_eligible" as const, reasonCode: "daily_goal_missed" as const, passedDays, failedDays, pendingDays };
    }
    // Still verifying: not yet decidable in either direction.
    if (pendingDays > 0) {
      return { ...p, status: "pending" as const, reasonCode: null, passedDays, failedDays, pendingDays };
    }
    // Every required day present AND passed. A short record (a day row never materialized) is
    // not eligible — an unproven day is not a passed day.
    if (passedDays === durationDays) {
      return { ...p, status: "eligible" as const, reasonCode: "all_days_passed" as const, passedDays, failedDays, pendingDays };
    }
    return { ...p, status: "not_eligible" as const, reasonCode: "verification_failed" as const, passedDays, failedDays, pendingDays };
  });
}

/** Persist computed eligibility. Only writes rows whose status actually changed. */
export async function persistEligibility(
  rows: ParticipantEligibility[],
  now: Date = new Date(),
): Promise<void> {
  for (const r of rows) {
    await db
      .update(unlimitedChallengeParticipantsTable)
      .set({
        prizePoolEligibilityStatus: r.status,
        eligibilityReasonCode: r.reasonCode,
        // `pending` is not a decision, so it does not stamp a finalization time.
        eligibilityFinalizedAt: r.status === "pending" ? null : now,
        updatedAt: now,
      })
      .where(and(
        eq(unlimitedChallengeParticipantsTable.id, r.participantId),
        ne(unlimitedChallengeParticipantsTable.prizePoolEligibilityStatus, r.status),
      ));
  }
}
