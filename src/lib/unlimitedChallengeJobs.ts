import { and, eq, ne, lte, inArray, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import { stepDailyTotalsTable } from "../../db/src/schema/steps.js";
import {
  unlimitedChallengesTable,
  unlimitedChallengeParticipantsTable,
  unlimitedChallengeDaysTable,
} from "../../db/src/schema/unlimitedChallenge.js";
import { buildDayWindows } from "./challengeDayWindow.js";
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
  if (pre.status === "waiting" && Date.now() < pre.startAtUtc.getTime()) return;

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

  for (const p of participants) {
    const windows = buildDayWindows(pre.startAtUtc, p.tz, pre.durationDays, pre.dailyGoalSteps);
    await db
      .insert(unlimitedChallengeDaysTable)
      .values(windows.map((w) => ({
        challengeId,
        participantId: p.id,
        userId: p.userId,
        dayNumber: w.dayNumber,
        localDate: w.localDate,
        timezone: p.tz,
        windowStartUtc: w.windowStartUtc,
        windowEndUtc: w.windowEndUtc,
        goalSteps: w.goalSteps,
      })))
      .onConflictDoNothing();
  }

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
  for (const p of participants) {
    void sendNotification(p.userId, "race_started", "Your challenge has started", "Your Unlimited Challenge has started — hit your daily goal every day!", {
      challengeId,
      dedupeKey: `unlimited_started:${challengeId}:${p.userId}`,
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
      .set({ status: "pending_verification", verifiedSteps: verified, updatedAt: now })
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
    })
    .from(unlimitedChallengeDaysTable)
    .where(and(
      inArray(unlimitedChallengeDaysTable.status, ["pending", "in_progress", "pending_verification"]),
      lte(unlimitedChallengeDaysTable.windowEndUtc, graceCutoff),
    ))
    .limit(500);

  for (const d of due) {
    const verified = await getVerifiedSteps(d.userId, d.localDate);
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
      // First failed day permanently disqualifies the participant (if still eligible).
      await db
        .update(unlimitedChallengeParticipantsTable)
        .set({ qualificationStatus: "disqualified", disqualifiedAt: now, disqualificationReason: "missed_daily_goal", updatedAt: now })
        .where(and(
          eq(unlimitedChallengeParticipantsTable.id, d.participantId),
          inArray(unlimitedChallengeParticipantsTable.qualificationStatus, ["active", "goal_completed_today", "pending_verification"]),
        ));
      void emitUnlimitedRealtime(
        d.challengeId,
        "participant_disqualified",
        { challengeId: d.challengeId, userId: d.userId },
        {
          event: "race:participant-forfeited",
          payload: { raceId: d.challengeId, userId: d.userId, reason: "missed_daily_goal" },
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
    const dueStart = await db
      .select({ id: unlimitedChallengesTable.id })
      .from(unlimitedChallengesTable)
      .where(and(eq(unlimitedChallengesTable.status, "waiting"), lte(unlimitedChallengesTable.startAtUtc, now)));
    for (const c of dueStart) await startUnlimitedChallenge(c.id);

    // Resume challenges stuck in `starting` (crash between claim and active).
    const stuckStarting = await db
      .select({ id: unlimitedChallengesTable.id })
      .from(unlimitedChallengesTable)
      .where(eq(unlimitedChallengesTable.status, "starting"));
    for (const c of stuckStarting) await startUnlimitedChallenge(c.id);

    await finalizeUnlimitedDays(now);

    const dueSettle = await db
      .select({ id: unlimitedChallengesTable.id })
      .from(unlimitedChallengesTable)
      .where(and(inArray(unlimitedChallengesTable.status, ["active", "settling"]), lte(unlimitedChallengesTable.settlementNotBeforeUtc, now)));
    for (const c of dueSettle) await settleUnlimitedChallenge(c.id);
  } catch (err) {
    logger.error({ err }, "[Unlimited] reconcile tick failed");
  }
}
