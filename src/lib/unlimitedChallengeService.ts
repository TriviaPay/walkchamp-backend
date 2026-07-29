import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import { profilesTable } from "../../db/src/schema/profiles.js";
import { userPreferencesTable } from "../../db/src/schema/userPreferences.js";
import {
  unlimitedChallengesTable,
  unlimitedChallengeParticipantsTable,
  type UnlimitedChallenge,
} from "../../db/src/schema/unlimitedChallenge.js";
import { debitWalletForCashChallenge } from "./refundService.js";
import { computeIsAdult } from "./dateOfBirth.js";
import { isCashChallengeUnsupportedForCountry } from "./cashChallengeFees.js";
import { generateInviteCode } from "./inviteCodes.js";
import { isValidTimezone, validateUnlimitedSchedule } from "./challengeDayWindow.js";
import {
  UNLIMITED_PLATFORM_FEE_CENTS,
  computeTotalChargeCents,
  validateEntryFeeCents,
  validateDailyGoalSteps,
  isAllowedDuration,
} from "./unlimitedChallengeMoney.js";
import { acquireOneChallengeLock, getBlockingMembership } from "./challengeMembership.js";
import { enqueueJob } from "./queue.js";
import { triggerEvent } from "./pusher.js";
import { sendNotification } from "../routes/notifications.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

export type ServiceResult<T> = { ok: true; data: T } | { ok: false; httpStatus: number; body: Record<string, unknown> };

/** Eligibility for paid challenges — mirrors the cash-challenge gates (adult/paid/active/country/fraud). */
async function checkPaidEligibility(userId: string, isCreate: boolean): Promise<ServiceResult<{ countryCode: string | null }>> {
  const [p] = await db
    .select({
      dateOfBirth: profilesTable.dateOfBirth,
      isAdult: profilesTable.isAdult,
      paidRaceEnabled: profilesTable.paidRaceEnabled,
      accountStatus: profilesTable.accountStatus,
      profileCompleted: profilesTable.profileCompleted,
      fraudScore: profilesTable.fraudScore,
      countryCode: profilesTable.countryCode,
    })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);
  if (!p) return { ok: false, httpStatus: 403, body: { error: "Paid challenges are not available for your account." } };
  if (!computeIsAdult(p.dateOfBirth, p.isAdult)) return { ok: false, httpStatus: 403, body: { error: "You must be 18 or older to join paid challenges." } };
  if (!p.paidRaceEnabled) return { ok: false, httpStatus: 403, body: { error: "Paid challenges are not available for your account." } };
  if (p.accountStatus !== "active") return { ok: false, httpStatus: 403, body: { error: "Your account is under review." } };
  if (isCashChallengeUnsupportedForCountry(p.countryCode)) return { ok: false, httpStatus: 403, body: { error: "Cash challenges are not yet supported in your region.", code: "region_unsupported" } };
  if (isCreate && !p.profileCompleted) return { ok: false, httpStatus: 403, body: { error: "Complete your profile to host paid challenges." } };
  if (isCreate && (p.fraudScore ?? 0) >= 70) return { ok: false, httpStatus: 403, body: { error: "Your account is under review." } };
  return { ok: true, data: { countryCode: p.countryCode } };
}

async function lockUserTimezone(userId: string): Promise<string> {
  const [pref] = await db
    .select({ timezone: userPreferencesTable.timezone })
    .from(userPreferencesTable)
    .where(eq(userPreferencesTable.userId, userId))
    .limit(1);
  const tz = pref?.timezone ?? "UTC";
  return isValidTimezone(tz) ? tz : "UTC";
}

export interface CreateInput {
  title?: string;
  visibility: "public" | "private";
  entryFeeCents: number;
  dailyGoalSteps: number;
  durationDays: number;
  startAtIso: string;
  /** IANA timezone the schedule is anchored to. Optional — falls back to the host's saved timezone. */
  challengeTimezone?: string;
}

/**
 * Create an Unlimited Challenge. The host is charged and auto-joined as a paid participant in the
 * same transaction (no host is created without paying). Schedule is backend-authoritative.
 */
export async function createUnlimitedChallenge(userId: string, input: CreateInput): Promise<ServiceResult<UnlimitedChallenge>> {
  const entryCheck = validateEntryFeeCents(input.entryFeeCents);
  if (!entryCheck.ok) return { ok: false, httpStatus: 400, body: { error: entryCheck.error } };
  const goalCheck = validateDailyGoalSteps(input.dailyGoalSteps);
  if (!goalCheck.ok) return { ok: false, httpStatus: 400, body: { error: goalCheck.error } };
  if (!isAllowedDuration(input.durationDays)) return { ok: false, httpStatus: 400, body: { error: "Duration must be one of 7, 10, 30, 60, or 90 days." } };

  // Resolve the challenge timezone: an explicit request value wins; otherwise fall back to the
  // host's saved timezone. The schedule is validated + normalized in this zone. hostTz stays the
  // host participant's own locked timezone (daily-window behavior unchanged).
  const hostTz = await lockUserTimezone(userId);
  const requestedTz = input.challengeTimezone?.trim();
  const timezone = requestedTz ? requestedTz : hostTz;

  // Strict USD-Unlimited schedule validation (public + private parity): start must be local midnight
  // in the challenge timezone, tomorrow-or-later, with a supported duration; end is backend-computed
  // as start-local-date + duration at local midnight (DST-correct). Supersedes the old ≥1h lead check.
  const schedule = validateUnlimitedSchedule({
    startAtIso: input.startAtIso,
    durationDays: input.durationDays,
    timezone,
    nowMs: Date.now(),
  });
  if (!schedule.ok) return { ok: false, httpStatus: 400, body: { error: schedule.error } };
  const { startAtUtc, challengeEndAtUtc } = schedule;

  const elig = await checkPaidEligibility(userId, true);
  if (!elig.ok) return elig;

  // Settlement waits until all days are finalized; the timer just needs to be past the last window +
  // grace. Add a timezone safety margin so far-east/west participants' last days are covered.
  const settlementNotBeforeUtc = new Date(challengeEndAtUtc.getTime() + config.unlimitedGoal.graceMs + 26 * 60 * 60_000);
  const inviteCode = input.visibility === "private" ? generateInviteCode() : null;

  const result = await db.transaction(async (tx) => {
    await acquireOneChallengeLock(tx, userId);
    const blocking = await getBlockingMembership(tx, userId);
    if (blocking) return { ok: false as const, kind: "conflict" as const, blocking };

    const [challenge] = await tx
      .insert(unlimitedChallengesTable)
      .values({
        hostUserId: userId,
        title: input.title?.trim() || "Unlimited Challenge",
        visibility: input.visibility,
        inviteCode,
        status: "waiting",
        entryFeeCents: input.entryFeeCents,
        platformFeeCents: UNLIMITED_PLATFORM_FEE_CENTS,
        dailyGoalSteps: input.dailyGoalSteps,
        durationDays: input.durationDays,
        challengeTimezone: timezone,
        startAtUtc,
        registrationClosesAtUtc: startAtUtc,
        challengeEndAtUtc,
        settlementNotBeforeUtc,
        zeroWinnerPolicy: config.unlimitedGoal.zeroWinnerPolicy,
      })
      .returning();

    // Host auto-joins: charge entry + $0.50, create participant, seed the pool.
    const charge = await debitWalletForCashChallenge(tx, {
      userId,
      raceRoomId: challenge.id,
      entryFeeCents: input.entryFeeCents,
      debitAmountCents: computeTotalChargeCents(input.entryFeeCents),
      idempotencyKey: `unlimited_entry:${challenge.id}:${userId}`,
      description: `Unlimited Challenge entry: ${challenge.title}`,
      metadata: { entryFeeCents: input.entryFeeCents, platformFeeCents: UNLIMITED_PLATFORM_FEE_CENTS, refundableAmountCents: 0 },
    });
    if (!charge.ok) return { ok: false as const, kind: "charge" as const, error: charge.error };

    await tx.insert(unlimitedChallengeParticipantsTable).values({
      challengeId: challenge.id,
      userId,
      participantTimezone: hostTz,
      qualificationStatus: "active",
      entryContributionCents: input.entryFeeCents,
      platformFeeCents: UNLIMITED_PLATFORM_FEE_CENTS,
      paymentReference: `unlimited_entry:${challenge.id}:${userId}`,
    });
    await tx
      .update(unlimitedChallengesTable)
      .set({ prizePoolCents: input.entryFeeCents, paidParticipantCount: 1, updatedAt: new Date() })
      .where(eq(unlimitedChallengesTable.id, challenge.id));

    return { ok: true as const, challenge };
  });

  if (!result.ok && result.kind === "conflict") {
    return { ok: false, httpStatus: 409, body: { error: "You already have an active challenge.", code: "one_challenge_at_a_time", blocking: result.blocking } };
  }
  if (!result.ok) {
    return { ok: false, httpStatus: 402, body: { error: result.error ?? "Entry fee could not be charged.", code: "entry_charge_failed" } };
  }

  // Durable start job (reconciler is the safety net).
  await enqueueJob("scheduled-jobs", "unlimited.start", { challengeId: result.challenge.id }, {
    jobId: `ult-start:${result.challenge.id}`,
    delay: Math.max(0, startAtUtc.getTime() - Date.now()),
  }).catch((err) => logger.warn({ err, challengeId: result.challenge.id }, "[Unlimited] start-job enqueue failed (reconciler covers)"));

  logger.info({ challengeId: result.challenge.id, userId, startAtUtc }, "[Unlimited] challenge created");
  return { ok: true, data: result.challenge };
}

/** Join an open Unlimited Challenge before its start. Transactional + idempotent (no double charge/pool). */
export async function joinUnlimitedChallenge(userId: string, challengeId: string, opts: { inviteCode?: string }): Promise<ServiceResult<{ challengeId: string }>> {
  const elig = await checkPaidEligibility(userId, false);
  if (!elig.ok) return elig;
  const tz = await lockUserTimezone(userId);

  const result = await db.transaction(async (tx) => {
    await acquireOneChallengeLock(tx, userId);
    const [challenge] = await tx
      .select()
      .from(unlimitedChallengesTable)
      .where(eq(unlimitedChallengesTable.id, challengeId))
      .limit(1)
      .for("update");
    if (!challenge) return { ok: false as const, httpStatus: 404, body: { error: "Challenge not found." } };

    // Idempotent: if already a participant, succeed without re-charging.
    const [existing] = await tx
      .select({ id: unlimitedChallengeParticipantsTable.id, status: unlimitedChallengeParticipantsTable.qualificationStatus })
      .from(unlimitedChallengeParticipantsTable)
      .where(and(eq(unlimitedChallengeParticipantsTable.challengeId, challengeId), eq(unlimitedChallengeParticipantsTable.userId, userId)))
      .limit(1);
    if (existing) {
      if (existing.status === "left") return { ok: false as const, httpStatus: 409, body: { error: "You cannot rejoin a challenge you left." } };
      return { ok: true as const, fresh: false }; // already joined — idempotent
    }

    if (challenge.status !== "waiting") return { ok: false as const, httpStatus: 409, body: { error: "This challenge is no longer open to join." } };
    if (Date.now() >= challenge.startAtUtc.getTime()) return { ok: false as const, httpStatus: 409, body: { error: "Registration has closed for this challenge." } };
    if (challenge.visibility === "private" && challenge.inviteCode && opts.inviteCode !== challenge.inviteCode) {
      return { ok: false as const, httpStatus: 403, body: { error: "A valid invite code is required to join this private challenge." } };
    }

    const blocking = await getBlockingMembership(tx, userId, { excludeChallengeId: challengeId });
    if (blocking) return { ok: false as const, httpStatus: 409, body: { error: "You already have an active challenge.", code: "one_challenge_at_a_time" } };

    const charge = await debitWalletForCashChallenge(tx, {
      userId,
      raceRoomId: challengeId,
      entryFeeCents: challenge.entryFeeCents,
      debitAmountCents: computeTotalChargeCents(challenge.entryFeeCents),
      idempotencyKey: `unlimited_entry:${challengeId}:${userId}`,
      description: `Unlimited Challenge entry: ${challenge.title}`,
      metadata: { entryFeeCents: challenge.entryFeeCents, platformFeeCents: UNLIMITED_PLATFORM_FEE_CENTS, refundableAmountCents: 0 },
    });
    if (!charge.ok) return { ok: false as const, httpStatus: 402, body: { error: charge.error ?? "Entry fee could not be charged.", code: "entry_charge_failed" } };

    await tx.insert(unlimitedChallengeParticipantsTable).values({
      challengeId,
      userId,
      participantTimezone: tz,
      qualificationStatus: "active",
      entryContributionCents: challenge.entryFeeCents,
      platformFeeCents: UNLIMITED_PLATFORM_FEE_CENTS,
      paymentReference: `unlimited_entry:${challengeId}:${userId}`,
    });
    await tx
      .update(unlimitedChallengesTable)
      .set({
        prizePoolCents: sql`${unlimitedChallengesTable.prizePoolCents} + ${challenge.entryFeeCents}`,
        paidParticipantCount: sql`${unlimitedChallengesTable.paidParticipantCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(unlimitedChallengesTable.id, challengeId));

    return { ok: true as const, fresh: true };
  });

  if (!result.ok) return { ok: false, httpStatus: result.httpStatus, body: result.body };
  if (result.fresh) {
    void triggerEvent(`unlimited-challenge-${challengeId}`, "participant_joined", { challengeId, userId });
  }
  return { ok: true, data: { challengeId } };
}

/** Leave a challenge. No refund ever. Before start → left; after start → left + disqualified. */
export async function leaveUnlimitedChallenge(userId: string, challengeId: string): Promise<ServiceResult<{ challengeId: string; participantStatus: string }>> {
  const result = await db.transaction(async (tx) => {
    const [challenge] = await tx.select().from(unlimitedChallengesTable).where(eq(unlimitedChallengesTable.id, challengeId)).limit(1).for("update");
    if (!challenge) return { ok: false as const, httpStatus: 404, body: { error: "Challenge not found." } };
    const [participant] = await tx
      .select()
      .from(unlimitedChallengeParticipantsTable)
      .where(and(eq(unlimitedChallengeParticipantsTable.challengeId, challengeId), eq(unlimitedChallengeParticipantsTable.userId, userId)))
      .limit(1)
      .for("update");
    if (!participant) return { ok: false as const, httpStatus: 404, body: { error: "You are not a participant in this challenge." } };
    if (participant.qualificationStatus === "left") return { ok: true as const }; // idempotent

    const started = challenge.status !== "waiting";
    const now = new Date();
    await tx
      .update(unlimitedChallengeParticipantsTable)
      .set({
        qualificationStatus: "left",
        leftAt: now,
        // Leaving after start also removes prize eligibility (disqualified for payout).
        disqualifiedAt: started ? now : null,
        disqualificationReason: started ? "left_after_start" : null,
        updatedAt: now,
      })
      .where(eq(unlimitedChallengeParticipantsTable.id, participant.id));
    // Contribution stays in the pool (no refund). paidParticipantCount is NOT decremented (pool basis).
    return { ok: true as const };
  });

  if (!result.ok) return { ok: false, httpStatus: result.httpStatus, body: result.body };
  void triggerEvent(`unlimited-challenge-${challengeId}`, "participant_left", { challengeId, userId });
  // No refund notification — leaving is explicitly no-refund.
  void sendNotification(userId, "race_cancelled", "You left the challenge", "You left the challenge. Entry fees are non-refundable.", {
    challengeId,
    dedupeKey: `unlimited_left:${challengeId}:${userId}`,
  }).catch(() => {});
  return { ok: true, data: { challengeId, participantStatus: "left" } };
}
