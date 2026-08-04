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

  // All required days for non-left participants must be finalized (passed/failed) before settling.
  const [{ unfinalized }] = await db
    .select({ unfinalized: sql<number>`count(*)::int` })
    .from(unlimitedChallengeDaysTable)
    .innerJoin(unlimitedChallengeParticipantsTable, eq(unlimitedChallengeDaysTable.participantId, unlimitedChallengeParticipantsTable.id))
    .where(and(
      eq(unlimitedChallengeDaysTable.challengeId, challengeId),
      ne(unlimitedChallengeParticipantsTable.qualificationStatus, "left"),
      inArray(unlimitedChallengeDaysTable.status, ["pending", "in_progress", "pending_verification"]),
    ));
  if ((unfinalized ?? 0) > 0) {
    logger.info({ challengeId, unfinalized }, "[Unlimited] settlement deferred — days not finalized");
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

  // Qualified finishers: not left, and passed every required day.
  const participants = await db
    .select({ id: unlimitedChallengeParticipantsTable.id, userId: unlimitedChallengeParticipantsTable.userId, status: unlimitedChallengeParticipantsTable.qualificationStatus })
    .from(unlimitedChallengeParticipantsTable)
    .where(eq(unlimitedChallengeParticipantsTable.challengeId, challengeId));
  const passedCounts = await db
    .select({ participantId: unlimitedChallengeDaysTable.participantId, passed: sql<number>`count(*) filter (where ${unlimitedChallengeDaysTable.status} = 'passed')::int` })
    .from(unlimitedChallengeDaysTable)
    .where(eq(unlimitedChallengeDaysTable.challengeId, challengeId))
    .groupBy(unlimitedChallengeDaysTable.participantId);
  const passedByParticipant = new Map(passedCounts.map((r) => [r.participantId, r.passed ?? 0]));

  const qualified = participants.filter(
    (p) => p.status !== "left" && p.status !== "disqualified" && (passedByParticipant.get(p.id) ?? 0) === pre.durationDays,
  );

  // ── Zero-winner policy ────────────────────────────────────────────────────
  if (qualified.length === 0) {
    const policy = pre.zeroWinnerPolicy;

    if (policy === "refund_entry_contributions") {
      // Nobody completed → return each non-left participant's entry contribution (platform fee is
      // NOT refunded). Idempotent per (challenge, participant). Then complete as "refunded".
      const refundables = participants.filter((p) => p.status !== "left");
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

  const allocations = computeEqualSplit(pre.prizePoolCents, qualified.map((q) => q.id));
  const userIdByParticipant = new Map(qualified.map((q) => [q.id, q.userId]));

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
