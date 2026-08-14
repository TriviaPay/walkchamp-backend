import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import { profilesTable } from "../../db/src/schema/profiles.js";
import { walletsTable } from "../../db/src/schema/index.js";
import { userPreferencesTable } from "../../db/src/schema/userPreferences.js";
import {
  unlimitedChallengesTable,
  unlimitedChallengeParticipantsTable,
  type UnlimitedChallenge,
} from "../../db/src/schema/unlimitedChallenge.js";
import { debitWalletForCashChallenge, createRefundForRaceParticipantTx } from "./refundService.js";
import { creditEntryRefunds } from "./cashChallengePayments.js";
import { computeIsAdult } from "./dateOfBirth.js";
import { isCashChallengeUnsupportedForUser } from "./cashChallengeFees.js";
import { allocateChallengeCode } from "./uniqueCodes.js";
import { validateUnlimitedSchedule } from "./challengeDayWindow.js";
import { UNLIMITED_LEFT_STATUSES } from "./unlimitedChallengeStatuses.js";
import {
  materializeParticipantSchedule,
  participantScheduleFor,
  resolveLockableTimezone,
} from "./unlimitedParticipantSchedule.js";
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
import { emitUnlimitedRealtime } from "./unlimitedRealtime.js";
import { sendNotification } from "../routes/notifications.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { invalidateSchedulerGate } from "./idleGate.js";

/** Non-terminal challenge statuses that still block membership / appear as "open". */
export const UNLIMITED_OPEN_STATUSES = ["waiting", "starting", "active", "settling"] as const;

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
      // The entry is a USD wallet debit, so the wallet's currency — not the registration
      // country — decides whether this user can pay. See isCashChallengeUnsupportedForUser.
      walletCurrency: walletsTable.currency,
    })
    .from(profilesTable)
    .leftJoin(walletsTable, eq(walletsTable.userId, profilesTable.id))
    .where(eq(profilesTable.id, userId))
    .limit(1);
  if (!p) return { ok: false, httpStatus: 403, body: { error: "Paid challenges are not available for your account." } };
  if (!computeIsAdult(p.dateOfBirth, p.isAdult)) return { ok: false, httpStatus: 403, body: { error: "You must be 18 or older to join paid challenges." } };
  if (!p.paidRaceEnabled) return { ok: false, httpStatus: 403, body: { error: "Paid challenges are not available for your account." } };
  if (p.accountStatus !== "active") return { ok: false, httpStatus: 403, body: { error: "Your account is under review." } };
  if (isCashChallengeUnsupportedForUser({ countryCode: p.countryCode, walletCurrency: p.walletCurrency })) {
    return { ok: false, httpStatus: 403, body: { error: "Cash challenges are not yet supported in your region.", code: "region_unsupported" } };
  }
  if (isCreate && !p.profileCompleted) return { ok: false, httpStatus: 403, body: { error: "Complete your profile to host paid challenges." } };
  if (isCreate && (p.fraudScore ?? 0) >= 70) return { ok: false, httpStatus: 403, body: { error: "Your account is under review." } };
  return { ok: true, data: { countryCode: p.countryCode } };
}

/** The IANA timezone to lock onto a new membership, from the user's saved preference. */
async function lockUserTimezone(userId: string): Promise<string> {
  const [pref] = await db
    .select({ timezone: userPreferencesTable.timezone })
    .from(userPreferencesTable)
    .where(eq(userPreferencesTable.userId, userId))
    .limit(1);
  return resolveLockableTimezone(pref?.timezone);
}

export interface CreateInput {
  title?: string;
  visibility: "public" | "private";
  entryFeeCents: number;
  dailyGoalSteps: number;
  durationDays: number;
  /**
   * PREFERRED: the calendar date every participant starts on, `YYYY-MM-DD`. Timezone-free by
   * design — each participant resolves it against their own locked zone.
   */
  startLocalDate?: string;
  /** LEGACY: an instant that must be local midnight in the challenge timezone. Reduced to its
   *  calendar date on the way in; kept so existing clients keep working. */
  startAtIso?: string;
  /** IANA timezone the HOST picked the date in. Audit + host display only — never another
   *  participant's day boundaries. Falls back to the host's saved timezone. */
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
    startLocalDate: input.startLocalDate,
    startAtIso: input.startAtIso,
    durationDays: input.durationDays,
    timezone,
    nowMs: Date.now(),
  });
  if (!schedule.ok) return { ok: false, httpStatus: 400, body: { error: schedule.error } };
  const { startLocalDate, startAtUtc, challengeEndAtUtc } = schedule;

  const elig = await checkPaidEligibility(userId, true);
  if (!elig.ok) return elig;

  // First settlement ATTEMPT timer only — settleUnlimitedChallenge re-checks the authoritative
  // gate (every eligible participant's own local end has passed AND every day is finalized).
  // +26h is the exact worst-case spread between the earliest local midnight (UTC+14) and the
  // latest (UTC-12) for the same calendar date, so the timer can never fire before the last
  // participant on earth could still be walking.
  const settlementNotBeforeUtc = new Date(challengeEndAtUtc.getTime() + config.unlimitedGoal.graceMs + 26 * 60 * 60_000);
  // 6-char code, allocated against the unique index (see allocateChallengeCode).
  const inviteCode = input.visibility === "private" ? await allocateChallengeCode() : null;

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
        // The semantic schedule. Every participant's midnight is resolved from THIS, in their own
        // zone — challengeTimezone/startAtUtc describe only the host's view of the same date.
        startLocalDate,
        startLocalTime: "00:00",
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
      metadata: { entryFeeCents: input.entryFeeCents, platformFeeCents: UNLIMITED_PLATFORM_FEE_CENTS, refundableAmountCents: input.entryFeeCents },
    });
    if (!charge.ok) return { ok: false as const, kind: "charge" as const, error: charge.error };

    // The host is an ordinary participant for scheduling: their days come from THEIR locked
    // timezone applied to the challenge date, exactly like everyone else. There is no separate
    // host day model. (The Walk Champ Admin ghost host is not a participant and never lands here.)
    const [hostParticipant] = await tx
      .insert(unlimitedChallengeParticipantsTable)
      .values({
        challengeId: challenge.id,
        userId,
        participantTimezone: hostTz,
        qualificationStatus: "active",
        entryContributionCents: input.entryFeeCents,
        platformFeeCents: UNLIMITED_PLATFORM_FEE_CENTS,
        paymentReference: `unlimited_entry:${challenge.id}:${userId}`,
      })
      .returning({ id: unlimitedChallengeParticipantsTable.id });
    await materializeParticipantSchedule(tx, {
      challenge: { ...challenge, startLocalDate },
      participantId: hostParticipant.id,
      userId,
      timezone: hostTz,
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

  // This challenge's startAtUtc may now be the earliest due work — clear the scheduler idle
  // gate so the reconciler tick re-derives it instead of sleeping on a stale "nothing due".
  void invalidateSchedulerGate();

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

    // ── Join cutoff: THIS joiner's own local start, not the host's ────────────
    // "No joining after the challenge starts" is a per-participant rule under per-participant
    // starts. A Chicago user is still eligible until 00:00 Chicago on the challenge date, even
    // though India already began ~10.5h earlier — they get the same full first day everyone else
    // gets, which is what the rule protects. Registration never opens a shorter run: the cutoff
    // IS their day-1 boundary, so nobody can buy in mid-run.
    const joinerSchedule = participantScheduleFor(
      { ...challenge, startLocalDate: challenge.startLocalDate ?? null },
      tz,
    );
    if (Date.now() >= joinerSchedule.startAtUtc.getTime()) {
      return {
        ok: false as const,
        httpStatus: 409,
        body: {
          error: "Registration has closed for this challenge.",
          code: "registration_closed",
          participantStartAtUtc: joinerSchedule.startAtUtc.toISOString(),
          participantTimezone: tz,
        },
      };
    }
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
      metadata: { entryFeeCents: challenge.entryFeeCents, platformFeeCents: UNLIMITED_PLATFORM_FEE_CENTS, refundableAmountCents: challenge.entryFeeCents },
    });
    if (!charge.ok) return { ok: false as const, httpStatus: 402, body: { error: charge.error ?? "Entry fee could not be charged.", code: "entry_charge_failed" } };

    const [participant] = await tx
      .insert(unlimitedChallengeParticipantsTable)
      .values({
        challengeId,
        userId,
        // Locked here and never recomputed: not on relogin, not on a device swap, not when the
        // user travels. DST inside the zone is handled by IANA rules under the same identifier.
        participantTimezone: tz,
        qualificationStatus: "active",
        entryContributionCents: challenge.entryFeeCents,
        platformFeeCents: UNLIMITED_PLATFORM_FEE_CENTS,
        paymentReference: `unlimited_entry:${challengeId}:${userId}`,
      })
      .returning({ id: unlimitedChallengeParticipantsTable.id });
    // Windows exist from the moment they pay, so a waiting challenge can already show this
    // viewer their own dates.
    await materializeParticipantSchedule(tx, {
      challenge,
      participantId: participant.id,
      userId,
      timezone: tz,
    });
    const nextCount = challenge.paidParticipantCount + 1;
    await tx
      .update(unlimitedChallengesTable)
      .set({
        prizePoolCents: sql`${unlimitedChallengesTable.prizePoolCents} + ${challenge.entryFeeCents}`,
        paidParticipantCount: nextCount,
        updatedAt: new Date(),
      })
      .where(eq(unlimitedChallengesTable.id, challengeId));

    return { ok: true as const, fresh: true, participantCount: nextCount };
  });

  if (!result.ok) return { ok: false, httpStatus: result.httpStatus, body: result.body };
  if (result.fresh) {
    const count = result.participantCount;
    const joinPayload = {
      challengeId,
      userId,
      room_id: challengeId,
      raceId: challengeId,
      current_players: count,
      registered_count: count,
      participantCount: count,
    };
    emitUnlimitedRealtime(
      challengeId,
      "participant_joined",
      joinPayload,
      {
        event: "race:player-joined",
        payload: joinPayload,
      },
    );
    // Waiting Room + Available bind room:participant_joined on live-race + rooms channels.
    void triggerEvent(`public-live-race-${challengeId}`, "room:participant_joined", joinPayload);
    void triggerEvent("public-rooms-available", "room:participant_joined", joinPayload);
    // Upcoming cards listen for room:registered — keep Unlimited join counts in sync.
    void triggerEvent("public-rooms-available", "room:registered", {
      room_id: challengeId,
      raceId: challengeId,
      registered_count: count,
      current_players: count,
    });
  }
  return { ok: true, data: { challengeId } };
}

/**
 * Leave a challenge. Host and regular participants may leave; leaving NEVER cancels the challenge
 * and NEVER reassigns the host (hostUserId is preserved so the original creator name still shows).
 * Server-authoritative refund boundary: leaveRequestedAt < startAtUtc → pre-start refund (entry fee
 * per policy, pool + count decremented); at/after start → no refund, contribution stays in the pool.
 * Idempotent: a repeated leave is a no-op and the refund idempotency key prevents a double refund.
 */
export async function leaveUnlimitedChallenge(userId: string, challengeId: string): Promise<ServiceResult<{ challengeId: string; participantStatus: string; refundIssued: boolean; refundAmountCents: number }>> {
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
    // Idempotent for every already-gone status, not just "left". A participant who forfeited (or
    // withdrew/quit) is out of the challenge by the same rules; treating only "left" as terminal
    // meant a retry on a forfeited row fell through and re-ran the leave path — rewriting
    // qualificationStatus and, pre-start, attempting a second refund.
    if ((UNLIMITED_LEFT_STATUSES as readonly string[]).includes(participant.qualificationStatus)) {
      return { ok: true as const, refundIssued: false, refundAmountCents: 0 }; // idempotent
    }

    // Pre-start iff still waiting AND server time is before the authoritative start instant.
    const preStart = challenge.status === "waiting" && Date.now() < challenge.startAtUtc.getTime();
    const now = new Date();

    await tx
      .update(unlimitedChallengeParticipantsTable)
      .set({
        qualificationStatus: "left",
        leftAt: now,
        // Leaving at/after start also removes prize eligibility (disqualified for payout).
        disqualifiedAt: preStart ? null : now,
        disqualificationReason: preStart ? null : "left_after_start",
        updatedAt: now,
      })
      .where(eq(unlimitedChallengeParticipantsTable.id, participant.id));

    if (!preStart) {
      // Post-start: contribution stays in the pool (no refund); pool/count unchanged.
      return {
        ok: true as const,
        refundIssued: false,
        refundAmountCents: 0,
        participantCount: challenge.paidParticipantCount,
      };
    }

    // Pre-start refund: refund the entry fee per policy (refundableAmountCents), remove the user's
    // contribution from the pool, and decrement the paid count. Idempotency key guards double refunds.
    await createRefundForRaceParticipantTx(tx, {
      raceId: challengeId,
      userId,
      reasonCode: "unlimited_leave",
      requestSource: "unlimited_leave",
      idempotencyKey: `unlimited_leave:${challengeId}:${userId}`,
      sourceType: "unlimited_challenge",
    });
    const nextCount = Math.max(challenge.paidParticipantCount - 1, 0);
    await tx
      .update(unlimitedChallengesTable)
      .set({
        prizePoolCents: sql`GREATEST(${unlimitedChallengesTable.prizePoolCents} - ${participant.entryContributionCents}, 0)`,
        paidParticipantCount: nextCount,
        updatedAt: now,
      })
      .where(eq(unlimitedChallengesTable.id, challengeId));
    return {
      ok: true as const,
      refundIssued: true,
      refundAmountCents: participant.entryContributionCents,
      participantCount: nextCount,
    };
  });

  if (!result.ok) return { ok: false, httpStatus: result.httpStatus, body: result.body };
  const leaveCount =
    "participantCount" in result && typeof result.participantCount === "number"
      ? result.participantCount
      : undefined;
  const leavePayload = {
    challengeId,
    userId,
    room_id: challengeId,
    raceId: challengeId,
    ...(leaveCount != null
      ? {
          current_players: leaveCount,
          registered_count: leaveCount,
          participantCount: leaveCount,
        }
      : {}),
  };
  emitUnlimitedRealtime(
    challengeId,
    "participant_left",
    leavePayload,
    {
      event: "race:player-left",
      payload: leavePayload,
    },
  );
  void triggerEvent(`public-live-race-${challengeId}`, "room:participant_left", leavePayload);
  void triggerEvent("public-rooms-available", "room:participant_left", leavePayload);
  if (leaveCount != null) {
    void triggerEvent("public-rooms-available", "room:registration_cancelled", {
      room_id: challengeId,
      raceId: challengeId,
      registered_count: leaveCount,
      current_players: leaveCount,
    });
  }
  const msg = result.refundIssued
    ? "You left the challenge. Your entry fee has been refunded."
    : "You left the challenge. Entry fees are non-refundable after it starts.";
  void sendNotification(userId, "race_cancelled", "You left the challenge", msg, {
    challengeId,
    dedupeKey: `unlimited_left:${challengeId}:${userId}`,
  }).catch(() => {});
  return { ok: true, data: { challengeId, participantStatus: "left", refundIssued: result.refundIssued, refundAmountCents: result.refundAmountCents } };
}

/**
 * Platform cancel for a single Unlimited Challenge: mark cancelled_by_platform, refund entry
 * contributions for every non-left participant (platform fee kept), release memberships.
 * Idempotent when already cancelled/completed.
 *
 * Refunds use the same wallet credit path as zero-winner settlement (fast, idempotent per user)
 * so large challenges don't hold a mega refund-item transaction open.
 */
export async function cancelUnlimitedChallengeByPlatform(
  challengeId: string,
  opts?: { reason?: string; actorUserId?: string | null },
): Promise<{
  ok: boolean;
  challengeId: string;
  alreadyTerminal?: boolean;
  refundedUserIds: string[];
  failedRefundUserIds: string[];
}> {
  const reason = opts?.reason?.trim() || "platform_cancelled";

  const [pre] = await db
    .select()
    .from(unlimitedChallengesTable)
    .where(eq(unlimitedChallengesTable.id, challengeId))
    .limit(1);
  if (!pre) {
    return { ok: false, challengeId, refundedUserIds: [], failedRefundUserIds: [] };
  }
  if (pre.status === "cancelled_by_platform" || pre.status === "completed") {
    return {
      ok: true,
      challengeId,
      alreadyTerminal: true,
      refundedUserIds: [],
      failedRefundUserIds: [],
    };
  }

  const participants = await db
    .select({
      userId: unlimitedChallengeParticipantsTable.userId,
      status: unlimitedChallengeParticipantsTable.qualificationStatus,
      entryContributionCents: unlimitedChallengeParticipantsTable.entryContributionCents,
    })
    .from(unlimitedChallengeParticipantsTable)
    .where(eq(unlimitedChallengeParticipantsTable.challengeId, challengeId));

  const refundTargets = participants.filter((p) => p.status !== "left");
  const refundedUserIds: string[] = [];
  const failedRefundUserIds: string[] = [];
  const now = new Date();

  // 1) Claim terminal status + release memberships (short transaction).
  const [claimed] = await db
    .update(unlimitedChallengesTable)
    .set({
      status: "cancelled_by_platform",
      settlementStatus: "refunded",
      prizePoolCents: 0,
      paidParticipantCount: 0,
      settledAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(unlimitedChallengesTable.id, challengeId),
        inArray(unlimitedChallengesTable.status, [...UNLIMITED_OPEN_STATUSES]),
      ),
    )
    .returning({ id: unlimitedChallengesTable.id });

  if (!claimed) {
    return {
      ok: true,
      challengeId,
      alreadyTerminal: true,
      refundedUserIds: [],
      failedRefundUserIds: [],
    };
  }

  if (refundTargets.length > 0) {
    await db
      .update(unlimitedChallengeParticipantsTable)
      .set({
        qualificationStatus: "left",
        leftAt: now,
        disqualificationReason: reason,
        updatedAt: now,
      })
      .where(
        and(
          eq(unlimitedChallengeParticipantsTable.challengeId, challengeId),
          ne(unlimitedChallengeParticipantsTable.qualificationStatus, "left"),
        ),
      );

    // 2) Wallet refunds in a dedicated transaction (idempotent keys).
    try {
      await db.transaction(async (tx) => {
        await creditEntryRefunds(tx, {
          sourceId: challengeId,
          refunds: refundTargets.map((p) => ({
            userId: p.userId,
            amountCents: p.entryContributionCents,
          })),
        });
      });
      refundedUserIds.push(...refundTargets.map((p) => p.userId));
    } catch (err) {
      failedRefundUserIds.push(...refundTargets.map((p) => p.userId));
      logger.error({ err, challengeId }, "[Unlimited] platform cancel bulk refund failed");
    }
  }

  emitUnlimitedRealtime(
    challengeId,
    "challenge_cancelled",
    { challengeId, reason },
    {
      event: "race:cancelled",
      payload: { raceId: challengeId, reason, challengeType: "unlimited_goal" },
    },
  );

  for (const userId of refundTargets.map((p) => p.userId)) {
    void sendNotification(
      userId,
      "race_cancelled",
      "Challenge cancelled",
      "This Unlimited Challenge was cancelled by the platform. Your entry fee has been refunded.",
      {
        challengeId,
        dedupeKey: `unlimited_platform_cancel_notify:${challengeId}:${userId}`,
      },
    ).catch(() => {});
  }

  logger.info(
    {
      challengeId,
      reason,
      actorUserId: opts?.actorUserId ?? null,
      refunded: refundedUserIds.length,
      failed: failedRefundUserIds.length,
    },
    "[Unlimited] platform cancelled challenge",
  );

  return { ok: true, challengeId, refundedUserIds, failedRefundUserIds };
}

/** Cancel every open Unlimited Challenge (waiting/starting/active/settling) with refunds. */
export async function cancelAllOpenUnlimitedChallenges(opts?: {
  reason?: string;
  actorUserId?: string | null;
}): Promise<{
  cancelled: number;
  skippedTerminal: number;
  results: Array<Awaited<ReturnType<typeof cancelUnlimitedChallengeByPlatform>>>;
}> {
  const open = await db
    .select({ id: unlimitedChallengesTable.id })
    .from(unlimitedChallengesTable)
    .where(inArray(unlimitedChallengesTable.status, [...UNLIMITED_OPEN_STATUSES]));

  const results: Array<Awaited<ReturnType<typeof cancelUnlimitedChallengeByPlatform>>> = [];
  let cancelled = 0;
  let skippedTerminal = 0;

  for (const row of open) {
    const result = await cancelUnlimitedChallengeByPlatform(row.id, opts);
    results.push(result);
    if (result.alreadyTerminal) skippedTerminal += 1;
    else if (result.ok) cancelled += 1;
  }

  logger.info(
    { cancelled, skippedTerminal, scanned: open.length },
    "[Unlimited] cancel-all open challenges finished",
  );
  return { cancelled, skippedTerminal, results };
}
