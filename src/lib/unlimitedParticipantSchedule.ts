/**
 * Per-participant scheduling for the Unlimited Daily Goal Challenge.
 *
 * The challenge stores a CALENDAR DATE. Each participant's real schedule is that date at 00:00 in
 * their own locked IANA timezone, so two participants in different zones legitimately start at
 * different UTC instants and may be in different states at the same moment: India `active` while
 * Chicago is still `scheduled`.
 *
 * Everything a caller needs to reason about "when does THIS person's challenge run" lives here, so
 * no route, job or ingest path has to re-derive timezone rules.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import {
  unlimitedChallengeDaysTable,
  unlimitedChallengeParticipantsTable,
  type UnlimitedChallenge,
} from "../../db/src/schema/unlimitedChallenge.js";
import {
  buildDayWindowsFromLocalDate,
  computeParticipantSchedule,
  isStrictIanaTimezone,
  localDateInZone,
  type ChallengeDayWindow,
} from "./challengeDayWindow.js";
import { logger } from "./logger.js";

/** The subset of a challenge row the schedule math needs. */
export type ScheduleSourceChallenge = Pick<
  UnlimitedChallenge,
  "id" | "startLocalDate" | "challengeTimezone" | "startAtUtc" | "durationDays" | "dailyGoalSteps"
>;

/**
 * The challenge's semantic calendar date.
 *
 * Rows created before start_local_date existed fall back to the local date of start_at_utc in the
 * challenge timezone — the same reconstruction migration 0027 performs, kept in code so a row that
 * somehow escaped the backfill still resolves instead of throwing on a read path.
 */
export function resolveChallengeStartLocalDate(challenge: ScheduleSourceChallenge): string {
  if (challenge.startLocalDate) return challenge.startLocalDate;
  return localDateInZone(challenge.startAtUtc, challenge.challengeTimezone || "UTC");
}

/** Build a participant's windows from the challenge's calendar date and their locked timezone. */
export function participantWindows(
  challenge: ScheduleSourceChallenge,
  timezone: string,
): ChallengeDayWindow[] {
  return buildDayWindowsFromLocalDate(
    resolveChallengeStartLocalDate(challenge),
    timezone,
    challenge.durationDays,
    challenge.dailyGoalSteps,
  );
}

/** A participant's own start/end instants, without touching the database. */
export function participantScheduleFor(
  challenge: ScheduleSourceChallenge,
  timezone: string,
): { startAtUtc: Date; endAtUtc: Date; windows: ChallengeDayWindow[] } {
  return computeParticipantSchedule({
    startLocalDate: resolveChallengeStartLocalDate(challenge),
    timezone,
    durationDays: challenge.durationDays,
    goalSteps: challenge.dailyGoalSteps,
  });
}

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Write a participant's schedule: their start/end on the membership row, and one
 * unlimited_challenge_days row per required day.
 *
 * Called at JOIN so a participant's windows exist from the moment they pay, rather than only when
 * the challenge flips to active — the challenge-start job would otherwise be the single point where
 * every participant's schedule appears, and a viewer joining a not-yet-started challenge would have
 * no personal dates to show.
 *
 * NON-DESTRUCTIVE by design. If day rows already exist for this participant they are the authority
 * and are left untouched; start/end are derived from them rather than recomputed. A challenge
 * created under the old instant-anchored rule therefore keeps the boundaries its participants have
 * already been living by — re-deriving them mid-run could retroactively pass or fail a day. Only a
 * participant with no days yet gets freshly computed windows.
 *
 * Idempotent and safe to re-run.
 */
export async function materializeParticipantSchedule(
  exec: Executor,
  input: {
    challenge: ScheduleSourceChallenge;
    participantId: string;
    userId: string;
    timezone: string;
  },
): Promise<{ startAtUtc: Date; endAtUtc: Date; dayCount: number; preserved: boolean }> {
  const [existing] = await exec
    .select({
      count: sql<number>`count(*)::int`,
      minStart: sql<Date | null>`min(${unlimitedChallengeDaysTable.windowStartUtc})`,
      maxEnd: sql<Date | null>`max(${unlimitedChallengeDaysTable.windowEndUtc})`,
    })
    .from(unlimitedChallengeDaysTable)
    .where(
      and(
        eq(unlimitedChallengeDaysTable.challengeId, input.challenge.id),
        eq(unlimitedChallengeDaysTable.participantId, input.participantId),
      ),
    );

  if ((existing?.count ?? 0) > 0 && existing?.minStart && existing?.maxEnd) {
    const startAtUtc = existing.minStart instanceof Date ? existing.minStart : new Date(existing.minStart);
    const endAtUtc = existing.maxEnd instanceof Date ? existing.maxEnd : new Date(existing.maxEnd);
    await exec
      .update(unlimitedChallengeParticipantsTable)
      .set({ participantStartAtUtc: startAtUtc, participantEndAtUtc: endAtUtc, updatedAt: new Date() })
      .where(eq(unlimitedChallengeParticipantsTable.id, input.participantId));
    return { startAtUtc, endAtUtc, dayCount: existing.count, preserved: true };
  }

  const { startAtUtc, endAtUtc, windows } = participantScheduleFor(input.challenge, input.timezone);

  await exec
    .insert(unlimitedChallengeDaysTable)
    .values(
      windows.map((w) => ({
        challengeId: input.challenge.id,
        participantId: input.participantId,
        userId: input.userId,
        dayNumber: w.dayNumber,
        localDate: w.localDate,
        timezone: input.timezone,
        windowStartUtc: w.windowStartUtc,
        windowEndUtc: w.windowEndUtc,
        goalSteps: w.goalSteps,
      })),
    )
    .onConflictDoNothing();

  await exec
    .update(unlimitedChallengeParticipantsTable)
    .set({ participantStartAtUtc: startAtUtc, participantEndAtUtc: endAtUtc, updatedAt: new Date() })
    .where(eq(unlimitedChallengeParticipantsTable.id, input.participantId));

  return { startAtUtc, endAtUtc, dayCount: windows.length, preserved: false };
}

/**
 * The participant's own start instant, preferring the persisted value and falling back to a fresh
 * computation. Used by the join cutoff and by read paths that must work before materialization.
 */
export function effectiveParticipantStart(
  challenge: ScheduleSourceChallenge,
  participant: { participantTimezone: string; participantStartAtUtc: Date | null },
): Date {
  return participant.participantStartAtUtc ?? participantScheduleFor(challenge, participant.participantTimezone).startAtUtc;
}

export function effectiveParticipantEnd(
  challenge: ScheduleSourceChallenge,
  participant: { participantTimezone: string; participantEndAtUtc: Date | null },
): Date {
  return participant.participantEndAtUtc ?? participantScheduleFor(challenge, participant.participantTimezone).endAtUtc;
}

/**
 * The timezone to lock for a joining user: their saved preference when it is a real Area/Location
 * IANA identifier, else UTC. Abbreviations ("IST", "CST", "EST") are rejected even though Intl
 * resolves some of them — they are ambiguous and carry no DST rules. A rejection is logged,
 * because silently locking a user to UTC would give them the wrong midnights for weeks.
 */
export function resolveLockableTimezone(raw: string | null | undefined): string {
  const tz = raw?.trim();
  if (!tz) return "UTC";
  if (isStrictIanaTimezone(tz)) return tz;
  logger.warn({ timezone: tz }, "[Unlimited] non-IANA timezone offered at join — locking UTC instead");
  return "UTC";
}

// ── Viewer-personalized status ────────────────────────────────────────────────

export type ViewerStatus = "scheduled" | "active" | "completed" | "failed" | "left" | "not_joined";

export interface ViewerScheduleState {
  viewerStatus: ViewerStatus;
  viewerTimezone: string | null;
  viewerStartAt: Date | null;
  viewerEndAt: Date | null;
  /** True when the run is over but at least one day is still awaiting verification. */
  verificationPending: boolean;
  currentDayIndex: number | null;
  currentDayLocalDate: string | null;
  currentDayStartAt: Date | null;
  currentDayEndAt: Date | null;
  currentDayStatus: string | null;
  remainingDaysAfterToday: number;
  completedDays: number;
  failedDays: number;
}

export interface ViewerDayRow {
  dayNumber: number;
  localDate: string;
  windowStartUtc: Date;
  windowEndUtc: Date;
  status: string;
}

/**
 * Derive what THIS viewer sees, from their own boundaries — never from challenge.status.
 * A challenge can be globally `active` while this viewer is still `scheduled`.
 */
export function deriveViewerState(input: {
  challenge: ScheduleSourceChallenge;
  participant: {
    participantTimezone: string;
    participantStartAtUtc: Date | null;
    participantEndAtUtc: Date | null;
    qualificationStatus: string;
  } | null;
  days: ViewerDayRow[];
  now?: Date;
}): ViewerScheduleState {
  const now = input.now ?? new Date();
  const empty: ViewerScheduleState = {
    viewerStatus: "not_joined",
    viewerTimezone: null,
    viewerStartAt: null,
    viewerEndAt: null,
    verificationPending: false,
    currentDayIndex: null,
    currentDayLocalDate: null,
    currentDayStartAt: null,
    currentDayEndAt: null,
    currentDayStatus: null,
    remainingDaysAfterToday: 0,
    completedDays: 0,
    failedDays: 0,
  };
  const p = input.participant;
  if (!p) return empty;

  const startAt = effectiveParticipantStart(input.challenge, p);
  const endAt = effectiveParticipantEnd(input.challenge, p);
  const completedDays = input.days.filter((d) => d.status === "passed").length;
  const failedDays = input.days.filter((d) => d.status === "failed").length;
  const unfinalized = input.days.filter(
    (d) => d.status === "pending" || d.status === "in_progress" || d.status === "pending_verification",
  );

  // The day whose window contains `now`. Falls back to null outside the run.
  const current = input.days.find(
    (d) => d.windowStartUtc.getTime() <= now.getTime() && now.getTime() < d.windowEndUtc.getTime(),
  ) ?? null;
  const remainingDaysAfterToday = current
    ? Math.max(0, input.challenge.durationDays - current.dayNumber)
    : now.getTime() < startAt.getTime()
      ? input.challenge.durationDays
      : 0;

  const base = {
    viewerTimezone: p.participantTimezone,
    viewerStartAt: startAt,
    viewerEndAt: endAt,
    verificationPending: now.getTime() >= endAt.getTime() && unfinalized.length > 0,
    currentDayIndex: current?.dayNumber ?? null,
    currentDayLocalDate: current?.localDate ?? null,
    currentDayStartAt: current?.windowStartUtc ?? null,
    currentDayEndAt: current?.windowEndUtc ?? null,
    currentDayStatus: current?.status ?? null,
    remainingDaysAfterToday,
    completedDays,
    failedDays,
  };

  // Terminal membership states win over the clock.
  if (p.qualificationStatus === "left") return { ...base, viewerStatus: "left" };
  if (p.qualificationStatus === "disqualified") return { ...base, viewerStatus: "failed" };
  if (p.qualificationStatus === "qualified") return { ...base, viewerStatus: "completed" };

  // A single finalized failed day is terminal, whatever the clock says (miss-one-day rule).
  if (failedDays > 0) return { ...base, viewerStatus: "failed" };

  if (now.getTime() < startAt.getTime()) return { ...base, viewerStatus: "scheduled" };
  if (now.getTime() < endAt.getTime()) return { ...base, viewerStatus: "active" };
  // Run is over: completed only once every required day finalized as passed.
  if (unfinalized.length === 0 && completedDays === input.challenge.durationDays) {
    return { ...base, viewerStatus: "completed" };
  }
  // Ended but still verifying — stay `active` so clients keep polling rather than declaring a
  // result the backend has not reached yet. verificationPending distinguishes it.
  return { ...base, viewerStatus: "active" };
}

/** Load a viewer's day rows (ordered) for status derivation. */
export async function loadViewerDays(
  challengeId: string,
  participantId: string,
): Promise<ViewerDayRow[]> {
  return db
    .select({
      dayNumber: unlimitedChallengeDaysTable.dayNumber,
      localDate: unlimitedChallengeDaysTable.localDate,
      windowStartUtc: unlimitedChallengeDaysTable.windowStartUtc,
      windowEndUtc: unlimitedChallengeDaysTable.windowEndUtc,
      status: unlimitedChallengeDaysTable.status,
    })
    .from(unlimitedChallengeDaysTable)
    .where(
      and(
        eq(unlimitedChallengeDaysTable.challengeId, challengeId),
        eq(unlimitedChallengeDaysTable.participantId, participantId),
      ),
    )
    .orderBy(unlimitedChallengeDaysTable.dayNumber);
}

/**
 * The latest local end instant across every participant who can still qualify — the earliest
 * moment the challenge as a whole can be settled. Participants who left are excluded: they hold no
 * qualification and must not hold settlement open.
 *
 * Returns null when no eligible participant has a resolvable end, which callers treat as "cannot
 * settle yet" rather than "settle now".
 */
export async function maxParticipantEndAtUtc(challengeId: string): Promise<Date | null> {
  const [row] = await db
    .select({ maxEnd: sql<Date | null>`max(${unlimitedChallengeParticipantsTable.participantEndAtUtc})` })
    .from(unlimitedChallengeParticipantsTable)
    .where(
      and(
        eq(unlimitedChallengeParticipantsTable.challengeId, challengeId),
        sql`${unlimitedChallengeParticipantsTable.qualificationStatus} <> 'left'`,
      ),
    );
  const maxEnd = row?.maxEnd ?? null;
  if (!maxEnd) return null;
  return maxEnd instanceof Date ? maxEnd : new Date(maxEnd);
}

/**
 * The EARLIEST local start across eligible participants — when the challenge as a whole must be
 * live, not the host's instant.
 *
 * A participant east of the host begins their day 1 before the host does: for a 2026-08-09
 * challenge hosted in Chicago, India's day 1 opens 2026-08-08 18:30Z while the host's does not
 * open until 2026-08-09 05:00Z. If activation waited for the host, India's steps would not count
 * for their first ~10.5 hours, because the live-progress lookups require an `active` challenge.
 */
export async function minParticipantStartAtUtc(challengeId: string): Promise<Date | null> {
  const [row] = await db
    .select({ minStart: sql<Date | null>`min(${unlimitedChallengeParticipantsTable.participantStartAtUtc})` })
    .from(unlimitedChallengeParticipantsTable)
    .where(
      and(
        eq(unlimitedChallengeParticipantsTable.challengeId, challengeId),
        sql`${unlimitedChallengeParticipantsTable.qualificationStatus} <> 'left'`,
      ),
    );
  const minStart = row?.minStart ?? null;
  if (!minStart) return null;
  return minStart instanceof Date ? minStart : new Date(minStart);
}

/**
 * Heal participants whose schedule columns are null (joined before this feature, or a crash
 * between the membership insert and materialization). Never rewrites an existing schedule — a
 * running participant's boundaries must not move underneath them.
 */
export async function healMissingParticipantSchedules(
  challenge: ScheduleSourceChallenge,
): Promise<number> {
  const missing = await db
    .select({
      id: unlimitedChallengeParticipantsTable.id,
      userId: unlimitedChallengeParticipantsTable.userId,
      timezone: unlimitedChallengeParticipantsTable.participantTimezone,
    })
    .from(unlimitedChallengeParticipantsTable)
    .where(
      and(
        eq(unlimitedChallengeParticipantsTable.challengeId, challenge.id),
        sql`${unlimitedChallengeParticipantsTable.qualificationStatus} <> 'left'`,
        sql`${unlimitedChallengeParticipantsTable.participantStartAtUtc} is null`,
      ),
    );

  for (const p of missing) {
    try {
      await materializeParticipantSchedule(db, {
        challenge,
        participantId: p.id,
        userId: p.userId,
        timezone: p.timezone,
      });
    } catch (err) {
      logger.error({ err, challengeId: challenge.id, participantId: p.id }, "[Unlimited] schedule heal failed");
    }
  }
  return missing.length;
}
