import { and, eq, ne, inArray, sql } from "drizzle-orm";
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
  areAllRequiredDaysTerminal,
  evaluateParticipantEligibility,
  markResultsReady,
  persistEligibility,
  refreshUnlimitedResultsStatus,
} from "./unlimitedResults.js";
import { emitUnlimitedRealtime } from "./unlimitedRealtime.js";
import { sendNotification } from "../routes/notifications.js";
import { writeAuditLog } from "./auditLog.js";
import { logger } from "./logger.js";

/**
 * Settle an Unlimited Challenge: equal split of the prize pool among qualified finishers (everyone
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
  if (pre.status === "completed" || pre.status === "cancelled_by_platform") return;
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

  // ── Gate 2 (§8, §22): every required day must be terminal (passed/failed) ──
  // Verification/reconciliation completeness on top of the clock check. Provisional sensor steps
  // never satisfy this — only the Health Connect / HealthKit authoritative value finalizes a day.
  const validation = await areAllRequiredDaysTerminal(challengeId);
  if (!validation.allDaysTerminal) {
    logger.info(
      { challengeId, pendingDays: validation.pendingDayCount, participants: validation.participantsAwaitingValidation },
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

  const participants = eligibility.map((e) => ({ id: e.participantId, userId: e.userId }));
  const qualified = eligibility.filter((e) => e.status === "eligible");

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
          updatedAt: new Date(),
        }).where(eq(unlimitedChallengesTable.id, challengeId));
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
      await markResultsReady(challengeId, {
        qualifiedParticipantCount: 0,
        prizePoolCents: pre.prizePoolCents,
        settlementStatus: "refunded",
      });
      emitUnlimitedRealtime(
        challengeId,
        "challenge_completed",
        { challengeId, winners: 0, settlementStatus: "refunded" },
        {
          event: "race:completed",
          payload: { raceId: challengeId, challengeType: "unlimited_goal", winners: 0 },
        },
      );
      return;
    }

    // manual_review (default, safe) or rollover_prize_pool (target undefined → held for ops).
    // NEVER auto-credit the platform or invent a redistribution rule.
    await db.update(unlimitedChallengesTable).set({
      status: "completed",
      settlementStatus: policy === "manual_review" ? "manual_review" : policy,
      qualifiedParticipantCount: 0,
      settledAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(unlimitedChallengesTable.id, challengeId));
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
    await markResultsReady(challengeId, {
      qualifiedParticipantCount: 0,
      prizePoolCents: pre.prizePoolCents,
      settlementStatus: policy === "manual_review" ? "manual_review" : policy,
    });
    emitUnlimitedRealtime(
      challengeId,
      "challenge_completed",
      { challengeId, winners: 0, settlementStatus: policy },
      {
        event: "race:completed",
        payload: { raceId: challengeId, challengeType: "unlimited_goal", winners: 0 },
      },
    );
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
      updatedAt: new Date(),
    }).where(eq(unlimitedChallengesTable.id, challengeId));
  });

  logger.info({ challengeId, winners: qualified.length, prizePoolCents: pre.prizePoolCents }, "[Unlimited] settled — equal split credited");
  // §9 — only now is the result publishable: every window closed, every day terminal, eligibility
  // recorded for every membership, the split persisted and the wallets credited.
  await markResultsReady(challengeId, {
    qualifiedParticipantCount: qualified.length,
    prizePoolCents: pre.prizePoolCents,
    settlementStatus: "completed",
  });
  emitUnlimitedRealtime(
    challengeId,
    "challenge_completed",
    { challengeId, winners: qualified.length },
    {
      event: "race:completed",
      payload: { raceId: challengeId, challengeType: "unlimited_goal", winners: qualified.length },
    },
  );
  for (const a of allocations) {
    const uid = userIdByParticipant.get(a.participantId)!;
    void sendNotification(uid, "race_won", "You won!", `You qualified and won $${(a.payoutCents / 100).toFixed(2)}.`, {
      challengeId,
      payoutCents: a.payoutCents,
      dedupeKey: `unlimited_payout:${challengeId}:${uid}`,
    }).catch(() => {});
  }
}
