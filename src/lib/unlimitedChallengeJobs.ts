import { and, eq, ne, gte, lte, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import { stepDailyTotalsTable } from "../../db/src/schema/steps.js";
import {
  unlimitedChallengesTable,
  unlimitedChallengeParticipantsTable,
  unlimitedChallengeDaysTable,
} from "../../db/src/schema/unlimitedChallenge.js";
import {
  healMissingParticipantSchedules,
  materializeParticipantSchedule,
  minParticipantStartAtUtc,
} from "./unlimitedParticipantSchedule.js";
import {
  captureSettlementPopulation,
  refreshUnlimitedResultsStatus,
} from "./unlimitedResults.js";
import { settleUnlimitedChallenge } from "./unlimitedChallengeSettlement.js";
import { enqueueJob } from "./queue.js";
import { triggerEvent } from "./pusher.js";
import { emitUnlimitedRealtime } from "./unlimitedRealtime.js";
import { sendNotification } from "../routes/notifications.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * Start an Unlimited Challenge at its scheduled time: compare-and-set waiting→starting, materialize
 * each participant's per-day windows in their LOCKED timezone, go starting→active, and schedule
 * settlement. Idempotent — a challenge not in `waiting`/`starting` (recovery) is a no-op; day rows
 * use a unique (challenge, participant, dayNumber) constraint so re-runs never duplicate.
 */
export async function startUnlimitedChallenge(challengeId: string): Promise<void> {
  const [pre] = await db.select().from(unlimitedChallengesTable).where(eq(unlimitedChallengesTable.id, challengeId)).limit(1);
  if (!pre) return;
  // Allow resume of stuck `starting` rows (crash between claim and active).
  if (pre.status !== "waiting" && pre.status !== "starting") return;
  if (pre.status === "waiting") {
    // Activate when the EARLIEST participant's local day 1 opens, not when the host's does. A
    // participant east of the host starts first, and their steps only count while the challenge
    // is `active` (see findActiveUnlimitedDaysForUser). Falls back to the host anchor when no
    // participant schedule is resolvable yet.
    await healMissingParticipantSchedules(pre);
    const earliest = (await minParticipantStartAtUtc(challengeId)) ?? pre.startAtUtc;
    if (Date.now() < earliest.getTime()) return;
  }

  if (pre.status === "waiting") {
    const [claimed] = await db
      .update(unlimitedChallengesTable)
      .set({ status: "starting", updatedAt: new Date() })
      .where(and(eq(unlimitedChallengesTable.id, challengeId), eq(unlimitedChallengesTable.status, "waiting")))
      .returning({ id: unlimitedChallengesTable.id });
    if (!claimed) return; // another worker won
  }

  const participants = await db
    .select({ id: unlimitedChallengeParticipantsTable.id, userId: unlimitedChallengeParticipantsTable.userId, tz: unlimitedChallengeParticipantsTable.participantTimezone })
    .from(unlimitedChallengeParticipantsTable)
    .where(and(eq(unlimitedChallengeParticipantsTable.challengeId, challengeId), ne(unlimitedChallengeParticipantsTable.qualificationStatus, "left")));

  // Windows are normally written at join. This is the safety net for memberships created before
  // that was true (or by a crash mid-join): same helper, same semantics, idempotent on
  // (challenge, participant, dayNumber) so re-runs never duplicate or move an existing day.
  for (const p of participants) {
    await materializeParticipantSchedule(db, {
      challenge: pre,
      participantId: p.id,
      userId: p.userId,
      timezone: p.tz,
    });
  }

  // §2 — freeze the settlement population now, so the denominator of the final result cannot
  // drift as memberships change afterwards. Ghost hosts have no participant row and so are never
  // included, never waited on, and never given day records.
  await captureSettlementPopulation(challengeId);

  await db
    .update(unlimitedChallengesTable)
    .set({ status: "active", startedAtUtc: pre.startedAtUtc ?? new Date(), updatedAt: new Date() })
    .where(and(eq(unlimitedChallengesTable.id, challengeId), eq(unlimitedChallengesTable.status, "starting")));

  await enqueueJob("scheduled-jobs", "unlimited.settle", { challengeId }, {
    jobId: `ult-settle:${challengeId}`,
    delay: Math.max(0, pre.settlementNotBeforeUtc.getTime() - Date.now()),
  }).catch((err) => logger.warn({ err, challengeId }, "[Unlimited] settle-job enqueue failed (reconciler covers)"));

  logger.info({ challengeId, participants: participants.length }, "[Unlimited] challenge started (active)");
  emitUnlimitedRealtime(
    challengeId,
    "challenge_started",
    { challengeId },
    { event: "race:started", payload: { raceId: challengeId, challengeType: "unlimited_goal" } },
  );
  void triggerEvent(`public-live-race-${challengeId}`, "race:starting", {
    raceId: challengeId,
    challengeType: "unlimited_goal",
  });
  // Only the participants whose OWN local day 1 has opened. Telling a Chicago user "your
  // challenge has started" at India's midnight is the notification form of the same bug — the
  // rest are notified by notifyDueParticipantStarts when their own midnight arrives.
  await notifyDueParticipantStarts(new Date());
}

/**
 * Send the "challenge started" notification at each participant's OWN local start.
 *
 * Driven off participant_start_at_utc, deduped durably per (challenge, user), and bounded to
 * starts in the recent past so a long-running challenge does not rescan every membership forever.
 */
export async function notifyDueParticipantStarts(now: Date = new Date()): Promise<void> {
  const lookbackMs = 6 * 60 * 60_000;
  const due = await db
    .select({
      challengeId: unlimitedChallengeParticipantsTable.challengeId,
      userId: unlimitedChallengeParticipantsTable.userId,
    })
    .from(unlimitedChallengeParticipantsTable)
    .innerJoin(
      unlimitedChallengesTable,
      eq(unlimitedChallengesTable.id, unlimitedChallengeParticipantsTable.challengeId),
    )
    .where(and(
      inArray(unlimitedChallengesTable.status, ["starting", "active"]),
      ne(unlimitedChallengeParticipantsTable.qualificationStatus, "left"),
      lte(unlimitedChallengeParticipantsTable.participantStartAtUtc, now),
      gte(unlimitedChallengeParticipantsTable.participantStartAtUtc, new Date(now.getTime() - lookbackMs)),
    ))
    .limit(500);

  for (const p of due) {
    void sendNotification(p.userId, "race_started", "Your challenge has started", "Your Unlimited Challenge has started — hit your daily goal every day!", {
      challengeId: p.challengeId,
      dedupeKey: `unlimited_started:${p.challengeId}:${p.userId}`,
    }).catch(() => {});
  }
}

/**
 * Finalize participant-days whose window has closed. Within the grace period the day is marked
 * `pending_verification` (late verified syncs still count); after `windowEnd + grace` it is finalized
 * `passed`/`failed` from the verified daily total for that locked-tz local date. A `failed` day
 * permanently disqualifies the participant. Idempotent via status guards.
 */
export async function finalizeUnlimitedDays(now: Date = new Date()): Promise<void> {
  const graceMs = config.unlimitedGoal.graceMs;

  // Mark closed-but-in-grace days as pending_verification (snapshot current verified steps).
  const inGrace = await db
    .select({ id: unlimitedChallengeDaysTable.id, userId: unlimitedChallengeDaysTable.userId, localDate: unlimitedChallengeDaysTable.localDate })
    .from(unlimitedChallengeDaysTable)
    .where(and(
      inArray(unlimitedChallengeDaysTable.status, ["pending", "in_progress"]),
      lte(unlimitedChallengeDaysTable.windowEndUtc, now),
    ))
    .limit(500);
  for (const d of inGrace) {
    const verified = await getVerifiedSteps(d.userId, d.localDate);
    await db
      .update(unlimitedChallengeDaysTable)
      // GREATEST, not assignment: verified_steps was already credited window-by-window by the
      // ingest path, and step_daily_totals is only a fallback lane keyed by the DEVICE's local
      // date. Overwriting would discard the window-accurate number for a traveller.
      .set({
        status: "pending_verification",
        verifiedSteps: sql`GREATEST(${unlimitedChallengeDaysTable.verifiedSteps}, ${verified})`,
        updatedAt: now,
      })
      .where(and(eq(unlimitedChallengeDaysTable.id, d.id), inArray(unlimitedChallengeDaysTable.status, ["pending", "in_progress"])));
  }

  // Finalize days whose grace has elapsed.
  const graceCutoff = new Date(now.getTime() - graceMs);
  const due = await db
    .select({
      id: unlimitedChallengeDaysTable.id,
      challengeId: unlimitedChallengeDaysTable.challengeId,
      participantId: unlimitedChallengeDaysTable.participantId,
      userId: unlimitedChallengeDaysTable.userId,
      localDate: unlimitedChallengeDaysTable.localDate,
      goalSteps: unlimitedChallengeDaysTable.goalSteps,
      creditedSteps: unlimitedChallengeDaysTable.verifiedSteps,
    })
    .from(unlimitedChallengeDaysTable)
    .where(and(
      inArray(unlimitedChallengeDaysTable.status, ["pending", "in_progress", "pending_verification"]),
      lte(unlimitedChallengeDaysTable.windowEndUtc, graceCutoff),
    ))
    .limit(500);

  for (const d of due) {
    // Best of both lanes: what the window-mapped ingest credited to this exact day, and the
    // device-local daily total. Neither lane may silently lose steps the user really walked.
    const verified = Math.max(d.creditedSteps, await getVerifiedSteps(d.userId, d.localDate));
    const passed = verified >= d.goalSteps;
    const [updated] = await db
      .update(unlimitedChallengeDaysTable)
      .set({
        status: passed ? "passed" : "failed",
        verifiedSteps: verified,
        passedAt: passed ? now : null,
        finalizedAt: now,
        updatedAt: now,
      })
      .where(and(eq(unlimitedChallengeDaysTable.id, d.id), inArray(unlimitedChallengeDaysTable.status, ["pending", "in_progress", "pending_verification"])))
      .returning({ id: unlimitedChallengeDaysTable.id });
    if (updated && !passed) {
      // First failed day permanently removes prize eligibility, but the participant stays in the
      // challenge until they manually leave/forfeit so their remaining step results keep showing.
      await db
        .update(unlimitedChallengeParticipantsTable)
        .set({
          prizePoolEligibilityStatus: "not_eligible",
          eligibilityReasonCode: "daily_goal_missed",
          eligibilityFinalizedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(unlimitedChallengeParticipantsTable.id, d.participantId),
          inArray(unlimitedChallengeParticipantsTable.qualificationStatus, ["active", "goal_completed_today", "pending_verification"]),
        ));
      void emitUnlimitedRealtime(
        d.challengeId,
        "participant_eligibility_updated",
        { challengeId: d.challengeId, userId: d.userId, prizePoolEligibilityStatus: "not_eligible", eligibilityReason: "daily_goal_missed" },
        {
          event: "race:participant-eligibility-updated",
          payload: { raceId: d.challengeId, userId: d.userId, prizePoolEligibilityStatus: "not_eligible", eligibilityReason: "daily_goal_missed" },
        },
      );
    }
  }
}

async function getVerifiedSteps(userId: string, localDate: string): Promise<number> {
  const [row] = await db
    .select({ steps: stepDailyTotalsTable.steps })
    .from(stepDailyTotalsTable)
    .where(and(eq(stepDailyTotalsTable.userId, userId), eq(stepDailyTotalsTable.date, localDate)))
    .limit(1);
  return row?.steps ?? 0;
}

/**
 * Reconciliation sweep (safety net behind the durable jobs): start past-due waiting challenges,
 * finalize due participant-days, and settle challenges past their settlement time. Idempotent.
 */
export async function reconcileUnlimitedChallenges(now: Date = new Date()): Promise<void> {
  try {
    // Due to start = ANY eligible participant's own local day 1 has opened. The host anchor is
    // kept as a fallback for challenges whose participants have no schedule yet.
    const dueStart = await db
      .selectDistinct({ id: unlimitedChallengesTable.id })
      .from(unlimitedChallengesTable)
      .leftJoin(
        unlimitedChallengeParticipantsTable,
        and(
          eq(unlimitedChallengeParticipantsTable.challengeId, unlimitedChallengesTable.id),
          ne(unlimitedChallengeParticipantsTable.qualificationStatus, "left"),
        ),
      )
      .where(and(
        eq(unlimitedChallengesTable.status, "waiting"),
        or(
          lte(unlimitedChallengeParticipantsTable.participantStartAtUtc, now),
          lte(unlimitedChallengesTable.startAtUtc, now),
        ),
      ));
    for (const c of dueStart) await startUnlimitedChallenge(c.id);

    // Resume challenges stuck in `starting` (crash between claim and active).
    const stuckStarting = await db
      .select({ id: unlimitedChallengesTable.id })
      .from(unlimitedChallengesTable)
      .where(eq(unlimitedChallengesTable.status, "starting"));
    for (const c of stuckStarting) await startUnlimitedChallenge(c.id);

    // Participants whose own local midnight has since arrived (a challenge started for an
    // eastern participant hours before a western one).
    await notifyDueParticipantStarts(now);

    await finalizeUnlimitedDays(now);

    // Result lifecycle (in_progress → waiting_for_participants → steps_validation_in_progress).
    // Driven every tick, not only at settlement time, so a participant who finishes days before
    // the rest sees "waiting for the others" instead of a stuck in-progress board.
    const liveResults = await db
      .select({ id: unlimitedChallengesTable.id })
      .from(unlimitedChallengesTable)
      .where(and(
        inArray(unlimitedChallengesTable.status, ["active", "settling"]),
        ne(unlimitedChallengesTable.resultsStatus, "results_ready"),
      ));
    for (const c of liveResults) {
      await refreshUnlimitedResultsStatus(c.id, now).catch((err) =>
        logger.error({ err, challengeId: c.id }, "[Unlimited] results status refresh failed"),
      );
    }

    const dueSettle = await db
      .select({ id: unlimitedChallengesTable.id })
      .from(unlimitedChallengesTable)
      .where(and(inArray(unlimitedChallengesTable.status, ["active", "settling"]), lte(unlimitedChallengesTable.settlementNotBeforeUtc, now)));
    for (const c of dueSettle) await settleUnlimitedChallenge(c.id);
  } catch (err) {
    logger.error({ err }, "[Unlimited] reconcile tick failed");
  }
}
