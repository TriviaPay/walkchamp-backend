/**
 * Unlimited Daily Goal Challenge — delayed global result processing.
 *
 * THE RULE: an Unlimited challenge produces no final result until every participant in the
 * settlement population has passed their OWN local challenge end, and every required day has a
 * terminal verification state. Participants hold different locked timezones, so "the host
 * finished", "the first participant finished" and "the viewer finished" are all meaningless as
 * finalization triggers — only the LAST local end matters.
 *
 * This module owns the result lifecycle. Money still moves in unlimitedChallengeSettlement.ts;
 * nothing here credits a wallet.
 */

import { and, eq, ne, inArray, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import {
  unlimitedChallengesTable,
  unlimitedChallengeParticipantsTable,
  unlimitedChallengeDaysTable,
  type UnlimitedChallenge,
} from "../../db/src/schema/unlimitedChallenge.js";
import { emitUnlimitedRealtime } from "./unlimitedRealtime.js";
import { logger } from "./logger.js";

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
}

/**
 * §22 — is every required day of every settlement participant terminal?
 *
 * Days belonging to participants outside the settlement population (those who left) are ignored:
 * they cannot qualify, so an unverified day of theirs must not hold everyone else's result.
 */
export async function areAllRequiredDaysTerminal(challengeId: string): Promise<ValidationState> {
  const rows = await db
    .select({
      participantId: unlimitedChallengeDaysTable.participantId,
      pending: sql<number>`count(*)::int`,
    })
    .from(unlimitedChallengeDaysTable)
    .innerJoin(
      unlimitedChallengeParticipantsTable,
      eq(unlimitedChallengeParticipantsTable.id, unlimitedChallengeDaysTable.participantId),
    )
    .where(and(
      eq(unlimitedChallengeDaysTable.challengeId, challengeId),
      eq(unlimitedChallengeParticipantsTable.inSettlementPopulation, true),
      inArray(unlimitedChallengeDaysTable.status, [...NON_TERMINAL_DAY_STATUSES]),
    ))
    .groupBy(unlimitedChallengeDaysTable.participantId);

  const pendingDayCount = rows.reduce((sum, r) => sum + r.pending, 0);
  return {
    allDaysTerminal: pendingDayCount === 0,
    pendingDayCount,
    participantsAwaitingValidation: rows.length,
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
 * ticks cannot emit the same transition twice. results_ready is written only by
 * markResultsReady() after settlement commits — this function never promotes into it.
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
  if (state.resultsStatus === "results_ready") return state; // owned by markResultsReady

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

/**
 * §9 — publish the final result. Called by settlement AFTER payouts are committed, so every
 * precondition (windows closed, days terminal, eligibility computed, split persisted) already
 * holds by construction.
 */
export async function markResultsReady(
  challengeId: string,
  summary: { qualifiedParticipantCount: number; prizePoolCents: number; settlementStatus: string | null },
  now: Date = new Date(),
): Promise<boolean> {
  const [changed] = await db
    .update(unlimitedChallengesTable)
    .set({ resultsStatus: "results_ready", resultsReadyAt: now, updatedAt: now })
    .where(and(
      eq(unlimitedChallengesTable.id, challengeId),
      ne(unlimitedChallengesTable.resultsStatus, "results_ready"),
    ))
    .returning({ id: unlimitedChallengesTable.id });
  if (!changed) return false; // already published — do not double-emit

  logger.info({ challengeId, ...summary }, "[Unlimited] results ready");
  emitUnlimitedRealtime(
    challengeId,
    "results_ready",
    { challengeId, resultsStatus: "results_ready", ...summary, readyAt: now.toISOString() },
    { event: "race:results_ready", payload: { raceId: challengeId, challengeType: "unlimited_goal", ...summary } },
  );
  return true;
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
  await db
    .update(unlimitedChallengeParticipantsTable)
    .set({ inSettlementPopulation: false, updatedAt: new Date() })
    .where(and(
      eq(unlimitedChallengeParticipantsTable.challengeId, challengeId),
      eq(unlimitedChallengeParticipantsTable.qualificationStatus, "left"),
    ));

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
    if (p.qualificationStatus === "left" || !p.inPopulation) {
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
