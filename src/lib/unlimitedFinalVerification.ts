import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import {
  unlimitedChallengesTable,
  unlimitedChallengeDaysTable,
  unlimitedChallengeParticipantsTable,
} from "../../db/src/schema/unlimitedChallenge.js";
import { config } from "./config.js";
import { emitUnlimitedRealtime } from "./unlimitedRealtime.js";
import {
  areAllParticipantWindowsClosed,
  requestFinalParticipantVerifications,
} from "./unlimitedResults.js";
import { isRaceVerificationSource, normalizeSource } from "./stepSources.js";
import { UNLIMITED_LEFT_STATUSES } from "./unlimitedChallengeStatuses.js";

export class UnlimitedFinalVerificationError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export type FinalVerificationSubmission = {
  challengeId: string;
  userId: string;
  source: string;
  dayNumber: number;
  intervalStartUtc: string;
  intervalEndUtc: string;
  verifiedSteps: number;
  measuredAtUtc: string;
};

/**
 * Process the viewer's exact final-day HealthKit/Health Connect range after the race-wide latest
 * end. In production/manual mode this records the provider read and holds the day for authenticated
 * review; client-source mode finalizes it immediately. Either way settlement waits for the durable
 * participant finalVerificationStatus to become completed.
 */
export async function submitUnlimitedFinalVerification(input: FinalVerificationSubmission) {
  const now = new Date();
  const source = normalizeSource(input.source);
  if (!isRaceVerificationSource(source)) {
    throw new UnlimitedFinalVerificationError(400, "invalid_verification_source", "Health Connect or HealthKit verification is required.");
  }
  const measuredAt = new Date(input.measuredAtUtc);
  if (Number.isNaN(measuredAt.getTime()) || measuredAt.getTime() > now.getTime() + 5 * 60_000) {
    throw new UnlimitedFinalVerificationError(400, "invalid_measured_at", "Invalid verification measurement time.");
  }

  const closure = await areAllParticipantWindowsClosed(input.challengeId, now);
  if (!closure.allClosed || !closure.latestParticipantEndAtUtc) {
    throw new UnlimitedFinalVerificationError(409, "participant_days_still_open", "Final verification starts after every participant's final day has ended.");
  }
  if (measuredAt.getTime() < closure.latestParticipantEndAtUtc.getTime()) {
    throw new UnlimitedFinalVerificationError(409, "verification_before_race_boundary", "The final provider read must occur after the race-wide verification boundary.");
  }
  await requestFinalParticipantVerifications(input.challengeId, now);

  const result = await db.transaction(async (tx) => {
    const [challenge] = await tx
      .select({ durationDays: unlimitedChallengesTable.durationDays, status: unlimitedChallengesTable.status })
      .from(unlimitedChallengesTable)
      .where(eq(unlimitedChallengesTable.id, input.challengeId))
      .limit(1)
      .for("update");
    if (!challenge) throw new UnlimitedFinalVerificationError(404, "challenge_not_found", "Challenge not found.");
    if (challenge.status !== "active" && challenge.status !== "settling") {
      throw new UnlimitedFinalVerificationError(409, "challenge_not_verifying", "Challenge is not awaiting final verification.");
    }

    const [participant] = await tx
      .select({
        id: unlimitedChallengeParticipantsTable.id,
        qualificationStatus: unlimitedChallengeParticipantsTable.qualificationStatus,
        inPopulation: unlimitedChallengeParticipantsTable.inSettlementPopulation,
        finalStatus: unlimitedChallengeParticipantsTable.finalVerificationStatus,
      })
      .from(unlimitedChallengeParticipantsTable)
      .where(and(
        eq(unlimitedChallengeParticipantsTable.challengeId, input.challengeId),
        eq(unlimitedChallengeParticipantsTable.userId, input.userId),
      ))
      .limit(1)
      .for("update");
    if (!participant || !participant.inPopulation) {
      throw new UnlimitedFinalVerificationError(403, "not_settlement_participant", "This membership is not part of final settlement.");
    }
    if ((UNLIMITED_LEFT_STATUSES as readonly string[]).includes(participant.qualificationStatus)) {
      throw new UnlimitedFinalVerificationError(403, "participant_forfeited", "A forfeited participant cannot submit prize verification.");
    }
    if (participant.finalStatus === "completed") {
      return { accepted: true as const, alreadyCompleted: true, status: "completed" };
    }
    if (input.dayNumber !== challenge.durationDays) {
      throw new UnlimitedFinalVerificationError(400, "not_final_day", "Final verification must cover the participant's final challenge day.");
    }

    const [day] = await tx
      .select({
        id: unlimitedChallengeDaysTable.id,
        windowStartUtc: unlimitedChallengeDaysTable.windowStartUtc,
        windowEndUtc: unlimitedChallengeDaysTable.windowEndUtc,
        goalSteps: unlimitedChallengeDaysTable.goalSteps,
      })
      .from(unlimitedChallengeDaysTable)
      .where(and(
        eq(unlimitedChallengeDaysTable.challengeId, input.challengeId),
        eq(unlimitedChallengeDaysTable.participantId, participant.id),
        eq(unlimitedChallengeDaysTable.dayNumber, challenge.durationDays),
      ))
      .limit(1)
      .for("update");
    if (!day) throw new UnlimitedFinalVerificationError(409, "final_day_missing", "The participant's final challenge day is missing.");

    const submittedStart = new Date(input.intervalStartUtc);
    const submittedEnd = new Date(input.intervalEndUtc);
    if (
      Number.isNaN(submittedStart.getTime())
      || Number.isNaN(submittedEnd.getTime())
      || submittedStart.getTime() !== day.windowStartUtc.getTime()
      || submittedEnd.getTime() !== day.windowEndUtc.getTime()
    ) {
      throw new UnlimitedFinalVerificationError(400, "verification_window_mismatch", "Verification must use the server-provided final-day window.");
    }

    const passed = input.verifiedSteps >= day.goalSteps;
    const manual = config.streakChallenge.verificationMode === "manual";
    await tx
      .update(unlimitedChallengeDaysTable)
      .set({
        verifiedSteps: input.verifiedSteps,
        status: manual ? "pending_verification" : (passed ? "passed" : "failed"),
        passedAt: !manual && passed ? now : null,
        finalizedAt: manual ? null : now,
        updatedAt: now,
      })
      .where(eq(unlimitedChallengeDaysTable.id, day.id));

    await tx
      .update(unlimitedChallengeParticipantsTable)
      .set({
        finalVerificationStatus: manual ? "submitted" : "completed",
        finalVerificationSubmittedAt: now,
        finalVerificationCompletedAt: manual ? null : now,
        finalVerificationSource: source,
        ...(!manual && !passed
          ? {
              prizePoolEligibilityStatus: "not_eligible",
              eligibilityReasonCode: "daily_goal_missed",
              eligibilityFinalizedAt: now,
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(unlimitedChallengeParticipantsTable.id, participant.id));

    return {
      accepted: true as const,
      alreadyCompleted: false,
      status: manual ? "submitted" : "completed",
      verificationStatus: manual ? "awaiting_review" : (passed ? "passed" : "failed"),
      verifiedSteps: input.verifiedSteps,
    };
  });

  emitUnlimitedRealtime(input.challengeId, "final_verification_updated", {
    challengeId: input.challengeId,
    userId: input.userId,
    finalVerificationStatus: result.status,
  }, {
    event: "race:final-verification-updated",
    payload: { raceId: input.challengeId, userId: input.userId, finalVerificationStatus: result.status },
  });
  return result;
}

/** Called after an authenticated manual decision to complete the participant handshake. */
export async function completeParticipantFinalVerificationAfterReview(input: {
  challengeId: string;
  participantId: string;
  dayNumber: number;
  now: Date;
  source?: "health_connect" | "healthkit";
}): Promise<boolean> {
  const [challenge] = await db
    .select({ durationDays: unlimitedChallengesTable.durationDays })
    .from(unlimitedChallengesTable)
    .where(eq(unlimitedChallengesTable.id, input.challengeId))
    .limit(1);
  if (!challenge || input.dayNumber !== challenge.durationDays) return false;
  const closure = await areAllParticipantWindowsClosed(input.challengeId, input.now);
  if (!closure.allClosed) return false;
  const eligibleStatuses = input.source ? ["requested", "submitted"] : ["submitted"];
  const updated = await db
    .update(unlimitedChallengeParticipantsTable)
    .set({
      finalVerificationStatus: "completed",
      finalVerificationSubmittedAt: input.source ? input.now : undefined,
      finalVerificationCompletedAt: input.now,
      finalVerificationSource: input.source,
      updatedAt: input.now,
    })
    .where(and(
      eq(unlimitedChallengeParticipantsTable.id, input.participantId),
      inArray(unlimitedChallengeParticipantsTable.finalVerificationStatus, eligibleStatuses),
    ))
    .returning({ id: unlimitedChallengeParticipantsTable.id });
  return updated.length > 0;
}
