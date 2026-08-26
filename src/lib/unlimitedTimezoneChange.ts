import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import {
  unlimitedChallengesTable,
  unlimitedChallengeDaysTable,
  unlimitedChallengeParticipantsTable,
  unlimitedChallengeTimezoneChangesTable,
} from "../../db/src/schema/unlimitedChallenge.js";
import { userPreferencesTable } from "../../db/src/schema/userPreferences.js";
import {
  buildDayWindowsFromLocalDate,
  isStrictIanaTimezone,
  localDateInZone,
  parseLocalDate,
} from "./challengeDayWindow.js";
import { emitUnlimitedRealtime } from "./unlimitedRealtime.js";

export class UnlimitedTimezoneChangeError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

type FutureDaySource = {
  id: string;
  dayNumber: number;
  goalSteps: number;
  timezone: string;
  windowStartUtc: Date;
  windowEndUtc: Date;
  status: string;
};

export type RescheduledTimezoneDay = {
  id: string;
  dayNumber: number;
  localDate: string;
  timezone: string;
  windowStartUtc: Date;
  windowEndUtc: Date;
  goalSteps: number;
};

function addOneCivilDay(dateKey: string): string {
  const parsed = parseLocalDate(dateKey);
  if (!parsed) throw new Error(`Invalid local date: ${dateKey}`);
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  date.setUTCDate(date.getUTCDate() + 1);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Rebuild only days that have not started. The first changed day begins at the first local midnight
 * in the new timezone on or after the immutable boundary. This prevents overlapping challenge days
 * (and therefore prevents the same verified steps from being assigned to two days) when travelling.
 */
export function buildRescheduledTimezoneDays(input: {
  immutableBoundaryUtc: Date;
  timezone: string;
  futureDays: FutureDaySource[];
}): RescheduledTimezoneDay[] {
  if (!isStrictIanaTimezone(input.timezone)) throw new Error(`Invalid IANA timezone: ${input.timezone}`);
  if (input.futureDays.length === 0) return [];

  let firstLocalDate = localDateInZone(input.immutableBoundaryUtc, input.timezone);
  let firstWindow = buildDayWindowsFromLocalDate(firstLocalDate, input.timezone, 1, 0)[0];
  if (firstWindow.windowStartUtc.getTime() < input.immutableBoundaryUtc.getTime()) {
    firstLocalDate = addOneCivilDay(firstLocalDate);
  }
  const windows = buildDayWindowsFromLocalDate(firstLocalDate, input.timezone, input.futureDays.length, 0);
  return input.futureDays.map((day, index) => ({
    id: day.id,
    dayNumber: day.dayNumber,
    localDate: windows[index].localDate,
    timezone: input.timezone,
    windowStartUtc: windows[index].windowStartUtc,
    windowEndUtc: windows[index].windowEndUtc,
    goalSteps: day.goalSteps,
  }));
}

export type UnlimitedTimezoneChangeResult = {
  challengeId: string;
  participantId: string;
  previousTimezone: string;
  newTimezone: string;
  confirmedAt: string;
  effectiveChallengeDay: number;
  appliesToChallenge: boolean;
  finalDayTimezoneLocked: boolean;
  currentChallengeDay: number | null;
  currentDayTimezone: string;
  currentDayEndAtUtc: string | null;
  participantStartAtUtc: string;
  participantEndAtUtc: string;
};

/** Confirm a device timezone change without ever rewriting a started challenge day. */
export async function changeUnlimitedParticipantTimezone(input: {
  challengeId: string;
  userId: string;
  timezone: string;
  now?: Date;
}): Promise<UnlimitedTimezoneChangeResult> {
  const timezone = input.timezone.trim();
  if (!isStrictIanaTimezone(timezone)) {
    throw new UnlimitedTimezoneChangeError(400, "invalid_timezone", "Use a valid IANA timezone such as America/Chicago.");
  }
  const now = input.now ?? new Date();

  const result = await db.transaction(async (tx) => {
    const [challenge] = await tx
      .select({ id: unlimitedChallengesTable.id, status: unlimitedChallengesTable.status, durationDays: unlimitedChallengesTable.durationDays })
      .from(unlimitedChallengesTable)
      .where(eq(unlimitedChallengesTable.id, input.challengeId))
      .limit(1)
      .for("update");
    if (!challenge) throw new UnlimitedTimezoneChangeError(404, "challenge_not_found", "Challenge not found.");
    if (challenge.status !== "active") {
      throw new UnlimitedTimezoneChangeError(409, "challenge_not_active", "The challenge timezone can only be changed while the challenge is active.");
    }

    const [participant] = await tx
      .select({
        id: unlimitedChallengeParticipantsTable.id,
        initialTimezone: unlimitedChallengeParticipantsTable.participantTimezone,
        participantStartAtUtc: unlimitedChallengeParticipantsTable.participantStartAtUtc,
      })
      .from(unlimitedChallengeParticipantsTable)
      .where(and(
        eq(unlimitedChallengeParticipantsTable.challengeId, input.challengeId),
        eq(unlimitedChallengeParticipantsTable.userId, input.userId),
      ))
      .limit(1)
      .for("update");
    if (!participant) throw new UnlimitedTimezoneChangeError(403, "not_participant", "Only a challenge participant may change this timezone.");

    const days = await tx
      .select({
        id: unlimitedChallengeDaysTable.id,
        dayNumber: unlimitedChallengeDaysTable.dayNumber,
        goalSteps: unlimitedChallengeDaysTable.goalSteps,
        timezone: unlimitedChallengeDaysTable.timezone,
        windowStartUtc: unlimitedChallengeDaysTable.windowStartUtc,
        windowEndUtc: unlimitedChallengeDaysTable.windowEndUtc,
        status: unlimitedChallengeDaysTable.status,
      })
      .from(unlimitedChallengeDaysTable)
      .where(and(
        eq(unlimitedChallengeDaysTable.challengeId, input.challengeId),
        eq(unlimitedChallengeDaysTable.participantId, participant.id),
      ))
      .orderBy(asc(unlimitedChallengeDaysTable.dayNumber))
      .for("update");
    if (days.length !== challenge.durationDays) {
      throw new UnlimitedTimezoneChangeError(409, "incomplete_schedule", "The participant schedule is incomplete; try again after it is repaired.");
    }

    const currentDay = days.find(
      (day) => day.windowStartUtc.getTime() <= now.getTime() && now.getTime() < day.windowEndUtc.getTime(),
    ) ?? null;
    const notStartedDays = days.filter(
      (day) => day.windowStartUtc.getTime() > now.getTime() && day.status === "pending",
    );
    const lastStartedDay = [...days].reverse().find((day) => day.windowStartUtc.getTime() <= now.getTime()) ?? null;
    // A timezone transition can create a short no-challenge gap between two local midnights. During
    // that gap the already-scheduled next day is treated as locked, preventing repeated changes from
    // continually pushing the next start farther into the future.
    const transitionLockedDay = !currentDay && lastStartedDay ? (notStartedDays[0] ?? null) : null;
    const futureDays = transitionLockedDay ? notStartedDays.slice(1) : notStartedDays;
    const currentDayTimezone = currentDay?.timezone ?? transitionLockedDay?.timezone ?? lastStartedDay?.timezone ?? participant.initialTimezone;
    const currentChallengeDay = currentDay?.dayNumber ?? transitionLockedDay?.dayNumber ?? lastStartedDay?.dayNumber ?? null;
    const confirmedAt = now;

    // The account preference is independent from the active challenge and is always retained, even
    // when the final day is already locked and this challenge cannot adopt the new zone.
    await tx
      .insert(userPreferencesTable)
      .values({ userId: input.userId, timezone, updatedAt: now })
      .onConflictDoUpdate({
        target: [userPreferencesTable.userId],
        set: { timezone, updatedAt: now },
      });

    const finalDayTimezoneLocked = currentChallengeDay === challenge.durationDays || futureDays.length === 0;
    const effectiveChallengeDay = finalDayTimezoneLocked
      ? challenge.durationDays + 1
      : futureDays[0].dayNumber;
    const previousTimezone = finalDayTimezoneLocked
      ? currentDayTimezone
      : futureDays[0].timezone;
    let participantEndAtUtc = days[days.length - 1].windowEndUtc;
    let participantStartAtUtc = participant.participantStartAtUtc ?? days[0].windowStartUtc;

    if (!finalDayTimezoneLocked && futureDays.some((day) => day.timezone !== timezone)) {
      const previousDay = days.find((day) => day.dayNumber === effectiveChallengeDay - 1) ?? null;
      const immutableBoundaryUtc = new Date(Math.max(
        now.getTime(),
        previousDay?.windowEndUtc.getTime() ?? now.getTime(),
      ));
      const replacements = buildRescheduledTimezoneDays({ immutableBoundaryUtc, timezone, futureDays });
      for (const replacement of replacements) {
        const updated = await tx
          .update(unlimitedChallengeDaysTable)
          .set({
            localDate: replacement.localDate,
            timezone: replacement.timezone,
            windowStartUtc: replacement.windowStartUtc,
            windowEndUtc: replacement.windowEndUtc,
            startBaselineSteps: 0,
            baselineCapturedAt: null,
            updatedAt: now,
          })
          .where(and(
            eq(unlimitedChallengeDaysTable.id, replacement.id),
            eq(unlimitedChallengeDaysTable.status, "pending"),
            gt(unlimitedChallengeDaysTable.windowStartUtc, now),
          ))
          .returning({ id: unlimitedChallengeDaysTable.id });
        if (updated.length !== 1) {
          throw new UnlimitedTimezoneChangeError(409, "day_already_started", "A future challenge day started while the timezone was being changed. Please refresh and try again.");
        }
      }
      if (effectiveChallengeDay === 1) participantStartAtUtc = replacements[0].windowStartUtc;
      participantEndAtUtc = replacements[replacements.length - 1].windowEndUtc;
      await tx
        .update(unlimitedChallengeParticipantsTable)
        .set({ participantStartAtUtc, participantEndAtUtc, updatedAt: now })
        .where(eq(unlimitedChallengeParticipantsTable.id, participant.id));
    }

    if (previousTimezone !== timezone || finalDayTimezoneLocked) {
      await tx.insert(unlimitedChallengeTimezoneChangesTable).values({
        challengeId: input.challengeId,
        participantId: participant.id,
        userId: input.userId,
        previousTimezone,
        newTimezone: timezone,
        confirmedAt,
        effectiveChallengeDay,
        appliesToChallenge: !finalDayTimezoneLocked,
      });
    }

    return {
      challengeId: input.challengeId,
      participantId: participant.id,
      previousTimezone,
      newTimezone: timezone,
      confirmedAt: confirmedAt.toISOString(),
      effectiveChallengeDay,
      appliesToChallenge: !finalDayTimezoneLocked,
      finalDayTimezoneLocked,
      currentChallengeDay,
      currentDayTimezone,
      currentDayEndAtUtc: (currentDay ?? transitionLockedDay)?.windowEndUtc.toISOString() ?? null,
      participantStartAtUtc: participantStartAtUtc.toISOString(),
      participantEndAtUtc: participantEndAtUtc.toISOString(),
    };
  });

  emitUnlimitedRealtime(input.challengeId, "timezone_changed", result, {
    event: "race:timezone-changed",
    payload: { raceId: input.challengeId, userId: input.userId, ...result },
  });
  return result;
}
