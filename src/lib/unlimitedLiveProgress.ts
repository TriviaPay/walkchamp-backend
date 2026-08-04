/**
 * Shared Unlimited Challenge live daily-progress helpers.
 *
 * currentSteps  = active challenge-day total from step_daily_totals
 * totalChallengeSteps = finalized verifiedSteps + today's live steps
 *
 * Active day is resolved via each participant's locked day window (windowStart/End),
 * not via a client-supplied localDate alone.
 */

import { and, asc, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import { profilesTable } from "../../db/src/schema/profiles.js";
import { stepDailyTotalsTable } from "../../db/src/schema/steps.js";
import {
  unlimitedChallengeDaysTable,
  unlimitedChallengeParticipantsTable,
  unlimitedChallengesTable,
} from "../../db/src/schema/unlimitedChallenge.js";

export type UnlimitedActiveDayProgress = {
  participantId: string;
  userId: string;
  dayNumber: number;
  challengeDayKey: string;
  localDate: string;
  timezone: string;
  goalSteps: number;
  /** Live display steps = max(verified, provisional). Not settlement authority. */
  currentSteps: number;
  /** Authoritative step_daily_totals for the challenge day. */
  verifiedTodaySteps: number;
  provisionalTodaySteps: number;
  progressSource: "verified" | "provisional" | "mixed" | "unavailable";
  windowStartUtc: Date;
  windowEndUtc: Date;
};

export type UnlimitedPlayerLiveProgress = {
  id: string;
  participantId: string;
  userId: string;
  username: string;
  fullName: string | null;
  displayName: string;
  country: string | null;
  countryFlag: string | null;
  avatarColor: string | null;
  avatarUrl: string | null;
  avatarVersion: number;
  qualificationStatus: string;
  status: string;
  joinedAt: Date;
  rank: number;
  isHost: boolean;
  isCurrentUser: boolean;
  friendStatus: "none";
  friendRequestId: null;
  activeTitle: null;
  currentSteps: number;
  verifiedTodaySteps: number;
  provisionalTodaySteps: number;
  progressSource: "verified" | "provisional" | "mixed" | "unavailable";
  completedDays: number;
  /** Accumulated finalized verified days + today's verified (not provisional). */
  totalChallengeSteps: number;
  challengeDayKey: string | null;
  localDate: string | null;
  timezone: string | null;
  dayNumber: number | null;
  dailyGoalSteps: number | null;
};

/** Load active-day progress for every non-left participant in a challenge. */
export async function loadActiveDayProgressByChallenge(
  challengeId: string,
  now: Date = new Date(),
): Promise<Map<string, UnlimitedActiveDayProgress>> {
  const currentDays = await db
    .select({
      participantId: unlimitedChallengeDaysTable.participantId,
      userId: unlimitedChallengeDaysTable.userId,
      dayNumber: unlimitedChallengeDaysTable.dayNumber,
      localDate: unlimitedChallengeDaysTable.localDate,
      timezone: unlimitedChallengeDaysTable.timezone,
      goalSteps: unlimitedChallengeDaysTable.goalSteps,
      windowStartUtc: unlimitedChallengeDaysTable.windowStartUtc,
      windowEndUtc: unlimitedChallengeDaysTable.windowEndUtc,
    })
    .from(unlimitedChallengeDaysTable)
    .where(
      and(
        eq(unlimitedChallengeDaysTable.challengeId, challengeId),
        lte(unlimitedChallengeDaysTable.windowStartUtc, now),
        gt(unlimitedChallengeDaysTable.windowEndUtc, now),
      ),
    );

  const byParticipant = new Map<string, UnlimitedActiveDayProgress>();
  if (!currentDays.length) return byParticipant;

  const stepRows = await db
    .select({
      userId: stepDailyTotalsTable.userId,
      date: stepDailyTotalsTable.date,
      steps: stepDailyTotalsTable.steps,
    })
    .from(stepDailyTotalsTable)
    .where(
      and(
        inArray(
          stepDailyTotalsTable.userId,
          currentDays.map((d) => d.userId),
        ),
        inArray(
          stepDailyTotalsTable.date,
          currentDays.map((d) => d.localDate),
        ),
      ),
    );
  const liveByUserDate = new Map<string, number>();
  for (const s of stepRows) {
    liveByUserDate.set(`${s.userId}|${s.date}`, s.steps);
  }

  for (const d of currentDays) {
    byParticipant.set(d.participantId, {
      participantId: d.participantId,
      userId: d.userId,
      dayNumber: d.dayNumber,
      challengeDayKey: d.localDate,
      localDate: d.localDate,
      timezone: d.timezone,
      goalSteps: d.goalSteps,
      currentSteps: liveByUserDate.get(`${d.userId}|${d.localDate}`) ?? 0,
      verifiedTodaySteps: liveByUserDate.get(`${d.userId}|${d.localDate}`) ?? 0,
      provisionalTodaySteps: 0,
      progressSource: "unavailable",
      windowStartUtc: d.windowStartUtc,
      windowEndUtc: d.windowEndUtc,
    });
  }

  // Overlay Redis provisional live lane (display only — never settlement).
  try {
    const {
      loadUnlimitedProvisionalMap,
      displayedFromLanes,
      progressSourceFromLanes,
    } = await import("./unlimitedProvisionalLive.js");
    const entries = [...byParticipant.values()].map((p) => ({
      userId: p.userId,
      challengeDayKey: p.challengeDayKey,
    }));
    const provMap = await loadUnlimitedProvisionalMap(challengeId, entries);
    for (const p of byParticipant.values()) {
      const prov = provMap.get(`${p.userId}|${p.challengeDayKey}`);
      const provisional = prov?.provisionalSteps ?? 0;
      const verified = p.verifiedTodaySteps;
      p.provisionalTodaySteps = provisional;
      p.currentSteps = displayedFromLanes(verified, provisional);
      p.progressSource = progressSourceFromLanes(verified, provisional);
    }
  } catch {
    for (const p of byParticipant.values()) {
      p.progressSource =
        p.verifiedTodaySteps > 0 ? "verified" : "unavailable";
    }
  }

  return byParticipant;
}

/** Active Unlimited day windows for a user at `now` (authoritative window match). */
export async function findActiveUnlimitedDaysForUser(
  userId: string,
  now: Date = new Date(),
): Promise<
  Array<{
    challengeId: string;
    participantId: string;
    dayNumber: number;
    goalSteps: number;
    localDate: string;
    timezone: string;
    challengeTimezone: string;
  }>
> {
  return db
    .select({
      challengeId: unlimitedChallengeDaysTable.challengeId,
      participantId: unlimitedChallengeDaysTable.participantId,
      dayNumber: unlimitedChallengeDaysTable.dayNumber,
      goalSteps: unlimitedChallengeDaysTable.goalSteps,
      localDate: unlimitedChallengeDaysTable.localDate,
      timezone: unlimitedChallengeDaysTable.timezone,
      challengeTimezone: unlimitedChallengesTable.challengeTimezone,
    })
    .from(unlimitedChallengeDaysTable)
    .innerJoin(
      unlimitedChallengesTable,
      eq(unlimitedChallengesTable.id, unlimitedChallengeDaysTable.challengeId),
    )
    .where(
      and(
        eq(unlimitedChallengeDaysTable.userId, userId),
        eq(unlimitedChallengesTable.status, "active"),
        inArray(unlimitedChallengeDaysTable.status, [
          "pending",
          "in_progress",
          "pending_verification",
        ]),
        lte(unlimitedChallengeDaysTable.windowStartUtc, now),
        gt(unlimitedChallengeDaysTable.windowEndUtc, now),
      ),
    );
}

/** Detail / waiting-room roster with live daily currentSteps. */
export async function loadChallengePlayers(
  challengeId: string,
  currentUserId: string,
  hostUserId: string,
  now: Date = new Date(),
): Promise<UnlimitedPlayerLiveProgress[]> {
  const rows = await db
    .select({
      participantId: unlimitedChallengeParticipantsTable.id,
      userId: unlimitedChallengeParticipantsTable.userId,
      qualificationStatus: unlimitedChallengeParticipantsTable.qualificationStatus,
      joinedAt: unlimitedChallengeParticipantsTable.joinedAt,
      username: profilesTable.username,
      fullName: profilesTable.fullName,
      country: profilesTable.country,
      countryFlag: profilesTable.countryFlag,
      avatarColor: profilesTable.avatarColor,
      avatarUrl: profilesTable.avatarUrl,
      updatedAt: profilesTable.updatedAt,
    })
    .from(unlimitedChallengeParticipantsTable)
    .leftJoin(
      profilesTable,
      eq(profilesTable.id, unlimitedChallengeParticipantsTable.userId),
    )
    .where(
      and(
        eq(unlimitedChallengeParticipantsTable.challengeId, challengeId),
        ne(unlimitedChallengeParticipantsTable.qualificationStatus, "left"),
      ),
    )
    .orderBy(
      sql`(${unlimitedChallengeParticipantsTable.userId} = ${hostUserId}) desc`,
      asc(unlimitedChallengeParticipantsTable.joinedAt),
      asc(unlimitedChallengeParticipantsTable.id),
    );

  const dayAgg = await db
    .select({
      participantId: unlimitedChallengeDaysTable.participantId,
      completedDays: sql<number>`count(*) filter (where ${unlimitedChallengeDaysTable.status} = 'passed')::int`,
      finalizedSteps: sql<number>`coalesce(sum(${unlimitedChallengeDaysTable.verifiedSteps}), 0)::int`,
    })
    .from(unlimitedChallengeDaysTable)
    .where(eq(unlimitedChallengeDaysTable.challengeId, challengeId))
    .groupBy(unlimitedChallengeDaysTable.participantId);
  const aggByParticipant = new Map(dayAgg.map((d) => [d.participantId, d]));

  const activeByParticipant = await loadActiveDayProgressByChallenge(challengeId, now);

  return rows.map((p, i) => {
    const agg = aggByParticipant.get(p.participantId);
    const cur = activeByParticipant.get(p.participantId);
    const verifiedToday = cur?.verifiedTodaySteps ?? 0;
    const provisionalToday = cur?.provisionalTodaySteps ?? 0;
    const displayToday = cur?.currentSteps ?? verifiedToday;
    const finalizedSteps = agg?.finalizedSteps ?? 0;
    const displayName =
      p.fullName ||
      p.username ||
      (p.userId === currentUserId ? "You" : `Player ${i + 1}`);
    return {
      id: p.participantId,
      participantId: p.participantId,
      userId: p.userId,
      username: p.username ?? displayName,
      fullName: p.fullName,
      displayName,
      country: p.country ?? null,
      countryFlag: p.countryFlag ?? null,
      avatarColor: p.avatarColor ?? null,
      avatarUrl: p.avatarUrl ?? null,
      avatarVersion: p.updatedAt?.getTime() ?? 0,
      qualificationStatus: p.qualificationStatus,
      status: p.qualificationStatus,
      joinedAt: p.joinedAt,
      rank: i + 1,
      isHost: p.userId === hostUserId,
      isCurrentUser: p.userId === currentUserId,
      friendStatus: "none" as const,
      friendRequestId: null,
      activeTitle: null,
      currentSteps: displayToday,
      verifiedTodaySteps: verifiedToday,
      provisionalTodaySteps: provisionalToday,
      progressSource: cur?.progressSource ?? "unavailable",
      completedDays: agg?.completedDays ?? 0,
      // Settlement / multi-day total uses verified today only — never provisional.
      totalChallengeSteps: finalizedSteps + verifiedToday,
      challengeDayKey: cur?.challengeDayKey ?? null,
      localDate: cur?.localDate ?? null,
      timezone: cur?.timezone ?? null,
      dayNumber: cur?.dayNumber ?? null,
      dailyGoalSteps: cur?.goalSteps ?? null,
    };
  });
}
