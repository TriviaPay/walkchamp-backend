/**
 * Maps a verified daily step submission onto the participant's OWN Unlimited challenge day.
 *
 * WHICH day a submission belongs to is decided by the participant's locked-timezone window
 * (window_start_utc <= now < window_end_utc), never by the device's current timezone. A Chicago
 * participant's steps can therefore never land on an India participant's day, and a participant who
 * changes their phone's timezone keeps the day boundaries they joined with.
 *
 * The day row's verified_steps is the qualification authority, so travel or a device-clock change
 * cannot silently move a day's total to a different bucket in step_daily_totals.
 */

import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import {
  unlimitedChallengeDaysTable,
  unlimitedChallengesTable,
} from "../../db/src/schema/unlimitedChallenge.js";
import { logger } from "./logger.js";

export interface UnlimitedDayCredit {
  challengeId: string;
  participantId: string;
  dayId: string;
  dayNumber: number;
  localDate: string;
  timezone: string;
  goalSteps: number;
  verifiedSteps: number;
  goalReached: boolean;
  /** True when the device's local date did not match the challenge day — see below. */
  timezoneDrift: boolean;
  /** Display-only baseline; see startBaselineSteps in the schema. */
  startBaselineSteps: number;
  /** verifiedSteps - startBaselineSteps, floored at 0. Display only. */
  challengeDaySteps: number;
}

/**
 * Apply an absolute verified daily total to whichever challenge day is open for this user right
 * now, in each active Unlimited challenge they belong to.
 *
 * `verifiedTotal` must be the ABSOLUTE cumulative verified total for the device's current local
 * day (which is what POST /api/walk/steps carries), not a delta. Stored monotonically:
 *   stored = max(stored, incoming)
 * Monotonicity is scoped to the single day row, so a new challenge day legitimately starts at 0 —
 * yesterday's total never leaks forward.
 *
 * DRIFT HANDLING: when the submitting device's local date differs from the challenge day's locked
 * local date (the participant travelled, or changed their clock), the incoming number describes a
 * DIFFERENT 24h span than the window being credited. Writing it would over- or under-credit a day
 * that decides real money, so the write is skipped and logged. Finalization then falls back to
 * step_daily_totals for that day. Closing this gap properly needs a Health Connect / HealthKit
 * interval query over the exact window, which is a client contract change and is out of scope here.
 */
export async function applyVerifiedStepsToUnlimitedDays(input: {
  userId: string;
  verifiedTotal: number;
  deviceLocalDate: string;
  now?: Date;
}): Promise<UnlimitedDayCredit[]> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(input.verifiedTotal) || input.verifiedTotal < 0) return [];

  const openDays = await db
    .select({
      dayId: unlimitedChallengeDaysTable.id,
      challengeId: unlimitedChallengeDaysTable.challengeId,
      participantId: unlimitedChallengeDaysTable.participantId,
      dayNumber: unlimitedChallengeDaysTable.dayNumber,
      localDate: unlimitedChallengeDaysTable.localDate,
      timezone: unlimitedChallengeDaysTable.timezone,
      goalSteps: unlimitedChallengeDaysTable.goalSteps,
      verifiedSteps: unlimitedChallengeDaysTable.verifiedSteps,
      dayStatus: unlimitedChallengeDaysTable.status,
      startBaselineSteps: unlimitedChallengeDaysTable.startBaselineSteps,
      baselineCapturedAt: unlimitedChallengeDaysTable.baselineCapturedAt,
      windowStartUtc: unlimitedChallengeDaysTable.windowStartUtc,
    })
    .from(unlimitedChallengeDaysTable)
    .innerJoin(
      unlimitedChallengesTable,
      eq(unlimitedChallengesTable.id, unlimitedChallengeDaysTable.challengeId),
    )
    .where(
      and(
        eq(unlimitedChallengeDaysTable.userId, input.userId),
        eq(unlimitedChallengesTable.status, "active"),
        inArray(unlimitedChallengeDaysTable.status, ["pending", "in_progress"]),
        // The window is the authority for which day this submission belongs to.
        lte(unlimitedChallengeDaysTable.windowStartUtc, now),
        gt(unlimitedChallengeDaysTable.windowEndUtc, now),
      ),
    );

  const credits: UnlimitedDayCredit[] = [];
  for (const day of openDays) {
    const timezoneDrift = day.localDate !== input.deviceLocalDate;
    if (timezoneDrift) {
      logger.warn(
        {
          userId: input.userId,
          challengeId: day.challengeId,
          dayNumber: day.dayNumber,
          challengeLocalDate: day.localDate,
          deviceLocalDate: input.deviceLocalDate,
          lockedTimezone: day.timezone,
        },
        "[Unlimited] device local date does not match the locked challenge day — verified total not applied",
      );
      credits.push({
        ...day,
        verifiedSteps: day.verifiedSteps,
        goalReached: day.verifiedSteps >= day.goalSteps,
        timezoneDrift: true,
        startBaselineSteps: day.startBaselineSteps,
        challengeDaySteps: Math.max(0, day.verifiedSteps - day.startBaselineSteps),
      });
      continue;
    }

    // Display-only baseline, captured once as this day row activates (pending → in_progress).
    // The window opens at local midnight, when the daily bucket is empty, so on an on-time
    // activation this is 0 and the live board shows the full day. It only differs when the row is
    // activated LATE — a heal, or a first sync that arrives after the window already opened with
    // steps already banked against this local date — and there the subtraction is what makes the
    // number mean "since this window opened" rather than "since midnight".
    const activating = day.dayStatus === "pending" && day.baselineCapturedAt == null;
    const baseline = activating
      ? Math.min(day.verifiedSteps, input.verifiedTotal)
      : day.startBaselineSteps;

    // GREATEST in SQL so concurrent submissions from two devices cannot race a total backwards.
    const [updated] = await db
      .update(unlimitedChallengeDaysTable)
      .set({
        verifiedSteps: sql`GREATEST(${unlimitedChallengeDaysTable.verifiedSteps}, ${input.verifiedTotal})`,
        status: "in_progress",
        updatedAt: now,
        ...(activating ? { startBaselineSteps: baseline, baselineCapturedAt: now } : {}),
      })
      .where(
        and(
          eq(unlimitedChallengeDaysTable.id, day.dayId),
          inArray(unlimitedChallengeDaysTable.status, ["pending", "in_progress"]),
        ),
      )
      .returning({
        verifiedSteps: unlimitedChallengeDaysTable.verifiedSteps,
        startBaselineSteps: unlimitedChallengeDaysTable.startBaselineSteps,
      });

    const verifiedSteps = updated?.verifiedSteps ?? day.verifiedSteps;
    const startBaselineSteps = updated?.startBaselineSteps ?? baseline;
    credits.push({
      ...day,
      verifiedSteps,
      goalReached: verifiedSteps >= day.goalSteps,
      timezoneDrift: false,
      startBaselineSteps,
      challengeDaySteps: Math.max(0, verifiedSteps - startBaselineSteps),
    });
  }

  return credits;
}
