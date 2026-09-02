import { and, eq } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import {
  unlimitedChallengesTable,
  unlimitedChallengeParticipantsTable,
  unlimitedChallengeDaysTable,
  unlimitedChallengePayoutsTable,
} from "../../db/src/schema/unlimitedChallenge.js";
import { creditCashChallengePrizes, creditEntryRefunds } from "./cashChallengePayments.js";
import { computeEqualSplit } from "./unlimitedChallengeMoney.js";
import {
  areAllParticipantWindowsClosed,
  areAllFinalParticipantVerificationsComplete,
  areAllRequiredDaysTerminal,
  evaluateParticipantEligibility,
  persistEligibility,
  refreshUnlimitedResultsStatus,
  requestFinalParticipantVerifications,
} from "./unlimitedResults.js";
import { emitUnlimitedRealtime } from "./unlimitedRealtime.js";
import { sendNotification } from "../routes/notifications.js";
import { writeAuditLog } from "./auditLog.js";
import { logger } from "./logger.js";
import { insertOutboxEventTx, enqueueOutboxEvent } from "./outbox.js";
import { outboxEventsTable } from "../../db/src/schema/index.js";
import { STREAK_CHALLENGE_KIND } from "./streakChallengeContract.js";
import { config } from "./config.js";

/**
 * Settle a Streak Challenge: equal split of the prize pool among qualified finishers (everyone
 * who passed every required day and did not leave). Atomic, idempotent, retry-safe:
 *  - `active → settling` is a compare-and-set claim (only one worker proceeds).
 *  - payout rows are unique per (challenge, participant); wallet credits are idempotent
 *    (`creditCashChallengePrizes` guards by prize idempotency key).
 *  - a challenge already `completed` is a no-op.
 *  - if any required day is still un-finalized, settlement defers (reconciler retries after finalize).
 */
export async function settleUnlimitedChallenge(challengeId: string): Promise<void> {
  const [pre] = await db.select().from(unlimitedChallengesTable).where(eq(unlimitedChallengesTable.id, challengeId)).limit(1);
  if (!pre) return;
  if (pre.status === "completed") {
    // Crash recovery for a transaction that committed payouts/results_ready before its outbox job
    // was delivered. The durable outbox normally drives this; this direct path is an extra repair.
    if (pre.resultsStatus !== "results_ready") {
      await db.update(unlimitedChallengesTable).set({
        resultsStatus: "results_ready",
        resultsReadyAt: pre.resultsReadyAt ?? pre.settledAt ?? new Date(),
        updatedAt: new Date(),
      }).where(eq(unlimitedChallengesTable.id, challengeId));
    }
    await announceUnlimitedChallengeResults(challengeId);
    return;
  }
  if (pre.status === "cancelled_by_platform") return;
  if (pre.status !== "active" && pre.status !== "settling") return;

  // ── Gate 1 (§1, §3, §4, §21): every settlement participant's OWN local run must be over ──
  // Participants in later timezones finish later in UTC — a Chicago participant is still walking
  // for ~10.5h after their India counterpart has finished the same calendar date. Neither the
  // host finishing, nor the first participant finishing, nor the challenge's own host-derived end
  // is sufficient; only the LAST local end is.
  const closure = await areAllParticipantWindowsClosed(challengeId);
  if (!closure.allClosed) {
    logger.info(
      {
        challengeId,
        registered: closure.registeredParticipantCount,
        finished: closure.participantsFinishedCount,
        pending: closure.participantsPendingCount,
        latestParticipantEnd: closure.latestParticipantEndAtUtc,
      },
      "[Unlimited] settlement deferred — a participant's local challenge window is still open",
    );
    await refreshUnlimitedResultsStatus(challengeId);
    return;
  }

  // ── Gate 2: every frozen participant completed a fresh post-boundary provider read ──
  await requestFinalParticipantVerifications(challengeId);
  const finalVerification = await areAllFinalParticipantVerificationsComplete(challengeId);
  if (!finalVerification.allCompleted) {
    logger.info(
      { challengeId, pendingParticipants: finalVerification.pendingParticipantCount },
      "[Unlimited] settlement deferred — final Health verification incomplete",
    );
    await refreshUnlimitedResultsStatus(challengeId);
    return;
  }

  // ── Gate 3: preserve the full backend-owned verification window ──────────
  // Even when every participant submits quickly, final results are not settled before four hours
  // (STREAK_CHALLENGE_GRACE_HOURS) from the ACTUAL last participant-local end. Conversely, this is
  // never a force-settlement deadline: the provider and day gates above/below may hold indefinitely.
  const lastParticipantEndAtUtc = closure.latestParticipantEndAtUtc;
  const settlementEligibleAt = lastParticipantEndAtUtc
    ? new Date(lastParticipantEndAtUtc.getTime() + config.streakChallenge.graceMs)
    : null;
  if (!settlementEligibleAt || Date.now() < settlementEligibleAt.getTime()) {
    logger.info(
      { challengeId, lastParticipantEndAtUtc, settlementEligibleAt },
      "[Unlimited] settlement deferred — final verification window is still open",
    );
    await refreshUnlimitedResultsStatus(challengeId);
    return;
  }

  // ── Gate 4 (§8, §22): every required day must exist and be terminal ──
  // Verification/reconciliation completeness on top of the clock check. Provisional sensor steps
  // never satisfy this — only the Health Connect / HealthKit authoritative value finalizes a day.
  const validation = await areAllRequiredDaysTerminal(challengeId);
  if (!validation.allDaysTerminal) {
    logger.info(
      {
        challengeId,
        pendingDays: validation.pendingDayCount,
        missingDays: validation.missingDayCount,
        incompleteParticipants: validation.incompleteParticipantCount,
        participants: validation.participantsAwaitingValidation,
      },
      "[Unlimited] settlement deferred — days not finalized",
    );
    await refreshUnlimitedResultsStatus(challengeId);
    return;
  }

  // Compare-and-set claim into "settling" (only one worker proceeds past here).
  if (pre.status === "active") {
    const [claimed] = await db
      .update(unlimitedChallengesTable)
      .set({ status: "settling", settlementStatus: "in_progress", updatedAt: new Date() })
      .where(and(eq(unlimitedChallengesTable.id, challengeId), eq(unlimitedChallengesTable.status, "active")))
      .returning({ id: unlimitedChallengesTable.id });
    if (!claimed) return; // another worker claimed it
  }

  // ── §10, §11, §18: explicit per-participant eligibility ───────────────────
  // "Passed EVERY required day", never a step total: 100,000 steps across a 7-day challenge with
  // one 8,000-step day is still not eligible, and a later 15,000-step day cannot repay the miss.
  // Every membership gets a recorded status and reason code, so the outcome is auditable rather
  // than inferred by the client.
  const eligibility = await evaluateParticipantEligibility(challengeId, pre.durationDays);
  await persistEligibility(eligibility);

  const qualified = eligibility.filter((e) => e.status === "eligible");
  let announcementOutbox: typeof outboxEventsTable.$inferSelect | null = null;

  // ── Zero-winner policy ────────────────────────────────────────────────────
  if (qualified.length === 0) {
    const policy = pre.zeroWinnerPolicy;

    if (policy === "refund_entry_contributions") {
      // Nobody completed → return each non-left participant's entry contribution (platform fee is
      // NOT refunded). Idempotent per (challenge, participant). Then complete as "refunded".
      // Everyone who did not leave — a failed run still gets its entry contribution back under
      // this policy; only a voluntary leave forfeits the claim.
      const refundables = eligibility.filter((e) => e.reasonCode !== "left_challenge");
      const contribByParticipant = await db
        .select({ userId: unlimitedChallengeParticipantsTable.userId, amount: unlimitedChallengeParticipantsTable.entryContributionCents })
        .from(unlimitedChallengeParticipantsTable)
        .where(eq(unlimitedChallengeParticipantsTable.challengeId, challengeId));
      const amountByUser = new Map(contribByParticipant.map((r) => [r.userId, r.amount]));
      const refundUserIds = new Set(refundables.map((p) => p.userId));
      await db.transaction(async (tx) => {
        await creditEntryRefunds(tx, {
          sourceId: challengeId,
          refunds: [...refundUserIds].map((userId) => ({ userId, amountCents: amountByUser.get(userId) ?? 0 })),
        });
        await tx.update(unlimitedChallengesTable).set({
          status: "completed",
          settlementStatus: "refunded",
          qualifiedParticipantCount: 0,
          settledAt: new Date(),
          resultsStatus: "results_ready",
          resultsReadyAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(unlimitedChallengesTable.id, challengeId));
        announcementOutbox = await insertOutboxEventTx(tx, {
          topic: "scheduled-jobs",
          eventType: "unlimited.announce",
          aggregateType: "unlimited_challenge",
          aggregateId: challengeId,
          idempotencyKey: `unlimited_announce:${challengeId}`,
          payload: { challengeId },
        });
      });
      await writeAuditLog({
        actorType: "system",
        action: "unlimited_challenge.zero_winner",
        entityType: "unlimited_challenge",
        entityId: challengeId,
        reason: policy,
        metadata: { prizePoolCents: pre.prizePoolCents, policy, refundedUsers: refundUserIds.size },
      });
      logger.warn({ challengeId, policy, refundedUsers: refundUserIds.size, prizePoolCents: pre.prizePoolCents }, "[Unlimited] zero winners — entry contributions refunded");
      if (announcementOutbox) await enqueueOutboxEvent(announcementOutbox);
      return;
    }

    // manual_review (default, safe) or rollover_prize_pool (target undefined → held for ops).
    // NEVER auto-credit the platform or invent a redistribution rule.
    await db.update(unlimitedChallengesTable).set({
      status: "completed",
      settlementStatus: policy === "manual_review" ? "manual_review" : policy,
      qualifiedParticipantCount: 0,
      settledAt: new Date(),
      resultsStatus: "results_ready",
      resultsReadyAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(unlimitedChallengesTable.id, challengeId));
    await insertOutboxEventTx(db, {
      topic: "scheduled-jobs",
      eventType: "unlimited.announce",
      aggregateType: "unlimited_challenge",
      aggregateId: challengeId,
      idempotencyKey: `unlimited_announce:${challengeId}`,
      payload: { challengeId },
    });
    await writeAuditLog({
      actorType: "system",
      action: "unlimited_challenge.zero_winner",
      entityType: "unlimited_challenge",
      entityId: challengeId,
      reason: policy,
      metadata: { prizePoolCents: pre.prizePoolCents, policy },
    });
    logger.warn({ challengeId, policy, prizePoolCents: pre.prizePoolCents }, "[Unlimited] zero winners — held for manual handling (no auto-credit)");
    // The RESULT is final (nobody qualified) even though the money is held for ops — clients must
    // stop showing "validating" for a challenge whose outcome is decided.
    await announceUnlimitedChallengeResults(challengeId);
    return;
  }

  const allocations = computeEqualSplit(pre.prizePoolCents, qualified.map((q) => q.participantId));
  const userIdByParticipant = new Map(qualified.map((q) => [q.participantId, q.userId]));

  await db.transaction(async (tx) => {
    // Persist immutable payout rows (idempotent) and credit wallets (idempotent).
    for (const a of allocations) {
      await tx
        .insert(unlimitedChallengePayoutsTable)
        .values({ challengeId, participantId: a.participantId, userId: userIdByParticipant.get(a.participantId)!, payoutCents: a.payoutCents, status: "credited" })
        .onConflictDoNothing();
      await tx
        .update(unlimitedChallengeParticipantsTable)
        .set({ qualificationStatus: "qualified", payoutCents: a.payoutCents, updatedAt: new Date() })
        .where(eq(unlimitedChallengeParticipantsTable.id, a.participantId));
    }
    await creditCashChallengePrizes(tx, {
      raceRoomId: challengeId,
      payouts: allocations.map((a) => ({ userId: userIdByParticipant.get(a.participantId)!, rank: 1, prizeCents: a.payoutCents })),
    });
    await tx.update(unlimitedChallengesTable).set({
      status: "completed",
      settlementStatus: "completed",
      qualifiedParticipantCount: qualified.length,
      settledAt: new Date(),
      resultsStatus: "results_ready",
      resultsReadyAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(unlimitedChallengesTable.id, challengeId));
    announcementOutbox = await insertOutboxEventTx(tx, {
      topic: "scheduled-jobs",
      eventType: "unlimited.announce",
      aggregateType: "unlimited_challenge",
      aggregateId: challengeId,
      idempotencyKey: `unlimited_announce:${challengeId}`,
      payload: { challengeId },
    });
  });

  logger.info({ challengeId, winners: qualified.length, prizePoolCents: pre.prizePoolCents }, "[Unlimited] settled — equal split credited");
  if (announcementOutbox) await enqueueOutboxEvent(announcementOutbox);
}

/** Durable outbox consumer: publishes result/reward notifications after the settlement commit. */
export async function announceUnlimitedChallengeResults(challengeId: string): Promise<void> {
  const [challenge] = await db
    .select()
    .from(unlimitedChallengesTable)
    .where(eq(unlimitedChallengesTable.id, challengeId))
    .limit(1);
  if (!challenge || challenge.resultsStatus !== "results_ready" || challenge.resultsAnnouncedAt) return;

  const payouts = await db
    .select({ userId: unlimitedChallengePayoutsTable.userId, payoutCents: unlimitedChallengePayoutsTable.payoutCents })
    .from(unlimitedChallengePayoutsTable)
    .where(eq(unlimitedChallengePayoutsTable.challengeId, challengeId));
  const winners = payouts.length;
  emitUnlimitedRealtime(
    challengeId,
    "results_ready",
    {
      challengeId,
      resultsStatus: "results_ready",
      qualifiedParticipantCount: challenge.qualifiedParticipantCount ?? winners,
      prizePoolCents: challenge.prizePoolCents,
      settlementStatus: challenge.settlementStatus,
      readyAt: challenge.resultsReadyAt?.toISOString() ?? new Date().toISOString(),
    },
    {
      event: "race:results_ready",
      payload: { raceId: challengeId, challengeType: "unlimited_goal", challengeKind: STREAK_CHALLENGE_KIND, winners },
    },
  );
  emitUnlimitedRealtime(
    challengeId,
    "challenge_completed",
    { challengeId, winners, settlementStatus: challenge.settlementStatus },
    {
      event: "race:completed",
      payload: { raceId: challengeId, challengeType: "unlimited_goal", challengeKind: STREAK_CHALLENGE_KIND, winners },
    },
  );
  for (const payout of payouts) {
    await sendNotification(payout.userId, "race_won", "You won!", `You qualified and won $${(payout.payoutCents / 100).toFixed(2)}.`, {
      challengeId,
      payoutCents: payout.payoutCents,
      dedupeKey: `unlimited_payout:${challengeId}:${payout.userId}`,
    });
  }
  await db
    .update(unlimitedChallengesTable)
    .set({ resultsAnnouncedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(unlimitedChallengesTable.id, challengeId),
      eq(unlimitedChallengesTable.resultsStatus, "results_ready"),
    ));
}
