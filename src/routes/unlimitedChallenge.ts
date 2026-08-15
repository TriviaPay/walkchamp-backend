import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, asc, desc, eq, gt, inArray, lte, notInArray, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import { profilesTable } from "../../db/src/schema/profiles.js";
import { liveRaceCommentsTable, liveRaceReactionsTable } from "../../db/src/schema/liveRace.js";
import { userPreferencesTable } from "../../db/src/schema/userPreferences.js";
import {
  unlimitedChallengesTable,
  unlimitedChallengeParticipantsTable,
  unlimitedChallengeDaysTable,
} from "../../db/src/schema/unlimitedChallenge.js";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import { config } from "../lib/config.js";
import { computeTotalChargeCents } from "../lib/unlimitedChallengeMoney.js";
import {
  createUnlimitedChallenge,
  joinUnlimitedChallenge,
  leaveUnlimitedChallenge,
  UNLIMITED_OPEN_STATUSES,
} from "../lib/unlimitedChallengeService.js";
import { UNLIMITED_NON_ACTIVE_STATUSES } from "../lib/unlimitedChallengeStatuses.js";
import {
  loadActiveDayProgressByChallenge,
  loadChallengePlayers,
  publicEligibilityReason,
} from "../lib/unlimitedLiveProgress.js";
import {
  deriveViewerState,
  loadViewerDays,
  participantScheduleFor,
  resolveChallengeStartLocalDate,
  resolveLockableTimezone,
} from "../lib/unlimitedParticipantSchedule.js";
import { areAllParticipantWindowsClosed, toDayStatus } from "../lib/unlimitedResults.js";
import {
  applyUnlimitedProvisionalLive,
  displayedFromLanes,
  loadUnlimitedProvisionalMap,
  progressSourceFromLanes,
} from "../lib/unlimitedProvisionalLive.js";
import { emitUnlimitedRealtime } from "../lib/unlimitedRealtime.js";
import { isProvisionalLiveSource, normalizeSource } from "../lib/stepSources.js";
import { stepDailyTotalsTable } from "../../db/src/schema/steps.js";

const router: Router = Router();

type ChallengeCardPlayer = {
  id: string;
  participantId: string;
  userId: string;
  username: string;
  avatarUrl: string | null;
  avatarColor: string | null;
  countryFlag: string | null;
  currentSteps: number;
  rank: number;
  isHost: boolean;
  status: string;
  qualificationStatus: string;
};

type RawChallengeCardPlayerRow = {
  challenge_id: string;
  participant_id: string;
  user_id: string;
  username: string | null;
  avatar_url: string | null;
  avatar_color: string | null;
  country_flag: string | null;
  current_steps: number | string;
  roster_rank: number | string;
  is_host: boolean;
  qualification_status: string;
  challenge_day_key?: string | null;
};

function rowsFromExecute<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

function sqlValues(values: readonly string[]): SQL {
  return sql.join(values.map((v) => sql`${v}`), sql`, `);
}

// ── Env rollback gate: FEATURE_UNLIMITED_GOAL=false → all routes 404 ──────────
// The worker start/finalize/settle paths are intentionally NOT gated, so any in-flight
// challenge still completes after the flag is turned off.
router.use("/unlimited-challenges", (_req: Request, res: Response, next: NextFunction): void => {
  if (!config.features.unlimitedGoalEnabled) {
    res.status(404).json({ error: "Unlimited Challenges are disabled for this build.", code: "FEATURE_DISABLED" });
    return;
  }
  next();
});

const createSchema = z.object({
  title: z.string().max(80).optional(),
  visibility: z.enum(["public", "private"]).default("public"),
  entryFeeCents: z.number().int(),
  dailyGoalSteps: z.number().int().default(config.unlimitedGoal.defaultDailyGoalSteps),
  durationDays: z.number().int(),
  // PREFERRED: the calendar date every participant starts on, in their own timezone.
  startLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // LEGACY: an instant that must be local midnight in the challenge timezone. Still accepted so
  // existing clients keep working; reduced to its calendar date server-side.
  startAtIso: z.string().optional(),
  // IANA timezone the HOST picked the date in — audit/display only, never another participant's
  // day boundaries. Falls back to the host's saved timezone.
  challengeTimezone: z.string().min(1).max(64).optional(),
  hostTimezone: z.string().min(1).max(64).optional(),
}).refine((v) => v.startLocalDate !== undefined || v.startAtIso !== undefined, {
  message: "Provide startLocalDate (YYYY-MM-DD) or startAtIso.",
  path: ["startLocalDate"],
});

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function resolveChallengeEndAtIso(c: typeof unlimitedChallengesTable.$inferSelect): string | null {
  const stored = isoOrNull(c.challengeEndAtUtc);
  if (stored) return stored;
  try {
    return participantScheduleFor(c, c.challengeTimezone || "UTC").endAtUtc.toISOString();
  } catch {
    return null;
  }
}

function serializeChallenge(
  c: typeof unlimitedChallengesTable.$inferSelect,
  opts: { participantCount?: number } = {},
) {
  const startAtUtc = isoOrNull(c.startAtUtc);
  const registrationClosesAtUtc = isoOrNull(c.registrationClosesAtUtc);
  const challengeEndAtUtc = resolveChallengeEndAtIso(c);
  const resultsReadyAt = isoOrNull(c.resultsReadyAt);
  const createdAt = isoOrNull(c.createdAt);

  return {
    id: c.id,
    challengeType: "unlimited_goal",
    entryType: "unlimited_goal",
    hostUserId: c.hostUserId,
    title: c.title,
    visibility: c.visibility,
    capacityMode: "unlimited",
    maxParticipants: null,
    maxPlayers: null,
    status: c.status,
    entryFeeCents: c.entryFeeCents,
    platformFeeCents: c.platformFeeCents,
    totalChargeCents: computeTotalChargeCents(c.entryFeeCents),
    currency: c.currency,
    dailyGoalSteps: c.dailyGoalSteps,
    durationDays: c.durationDays,
    // The semantic schedule. Clients should render dates from startLocalDate; startAtUtc is only
    // the host's own anchor and is NOT when other participants begin.
    startLocalDate: c.startLocalDate,
    startLocalTime: c.startLocalTime,
    challengeTimezone: c.challengeTimezone,
    hostTimezone: c.challengeTimezone,
    startAtUtc,
    registrationClosesAtUtc,
    registration_closes_at_utc: registrationClosesAtUtc,
    challengeEndAtUtc,
    challenge_end_at: challengeEndAtUtc,
    challenge_end_at_utc: challengeEndAtUtc,
    prizePoolCents: c.prizePoolCents,
    participantCount: opts.participantCount ?? c.paidParticipantCount,
    qualifiedParticipantCount: c.qualifiedParticipantCount,
    settlementStatus: c.settlementStatus,
    // Result lifecycle. Clients must branch on resultsStatus, NOT on `status` — a challenge whose
    // host has finished is still `active` for participants in later timezones, and its result is
    // not final until results_ready.
    resultsStatus: c.resultsStatus,
    resultsReadyAt,
    settlementPopulationSize: c.settlementPopulationSize,
    createdAt,
  };
}

async function overlayMembership(
  rows: Array<typeof unlimitedChallengesTable.$inferSelect>,
  userId: string,
) {
  const memberships = rows.length
    ? await db
        .select({
          challengeId: unlimitedChallengeParticipantsTable.challengeId,
          status: unlimitedChallengeParticipantsTable.qualificationStatus,
        })
        .from(unlimitedChallengeParticipantsTable)
        .where(
          and(
            eq(unlimitedChallengeParticipantsTable.userId, userId),
            inArray(
              unlimitedChallengeParticipantsTable.challengeId,
              rows.map((r) => r.id),
            ),
          ),
        )
    : [];
  const statusByChallenge = new Map(memberships.map((m) => [m.challengeId, m.status]));
  return rows.map((c) => {
    const status = statusByChallenge.get(c.id) ?? null;
    const currentUserRegistered =
      status != null
      && !UNLIMITED_NON_ACTIVE_STATUSES.includes(
        status as typeof UNLIMITED_NON_ACTIVE_STATUSES[number],
      );
    return {
      ...serializeChallenge(c),
      participationStatus: status,
      currentUserRegistered,
      current_user_registered: currentUserRegistered,
    };
  });
}

async function loadChallengeParticipantCounts(challengeIds: string[]): Promise<Map<string, number>> {
  if (challengeIds.length === 0) return new Map();
  const rows = await db
    .select({
      challengeId: unlimitedChallengeParticipantsTable.challengeId,
      participantCount: sql<number>`count(*)::int`,
    })
    .from(unlimitedChallengeParticipantsTable)
    .where(
      and(
        inArray(unlimitedChallengeParticipantsTable.challengeId, challengeIds),
        sql`${unlimitedChallengeParticipantsTable.entryContributionCents} > 0`,
        notInArray(unlimitedChallengeParticipantsTable.qualificationStatus, [...UNLIMITED_NON_ACTIVE_STATUSES]),
      ),
    )
    .groupBy(unlimitedChallengeParticipantsTable.challengeId);
  return new Map(rows.map((r) => [r.challengeId, Number(r.participantCount)]));
}

async function loadActiveChallengeCardPlayers(
  challenges: Array<typeof unlimitedChallengesTable.$inferSelect>,
  now: Date = new Date(),
): Promise<Map<string, ChallengeCardPlayer[]>> {
  const challengeIds = challenges.map((c) => c.id);
  if (challengeIds.length === 0) return new Map();

  const idList = sqlValues(challengeIds);
  const nonActiveList = sqlValues([...UNLIMITED_NON_ACTIVE_STATUSES]);
  const result = await db.execute(sql`
    WITH current_days AS (
      SELECT
        d.challenge_id,
        d.participant_id,
        d.user_id,
        d.local_date
      FROM unlimited_challenge_days d
      WHERE d.challenge_id IN (${idList})
        AND d.window_start_utc <= ${now}
        AND d.window_end_utc > ${now}
    ),
    ranked AS (
      SELECT
        p.challenge_id,
        p.id AS participant_id,
        p.user_id,
        pr.username,
        pr.avatar_url,
        pr.avatar_color,
        pr.country_flag,
        COALESCE(s.steps, 0)::int AS current_steps,
        row_number() OVER (
          PARTITION BY p.challenge_id
          ORDER BY COALESCE(s.steps, 0) DESC, p.joined_at ASC, p.id ASC
        )::int AS roster_rank,
        (p.user_id = c.host_user_id) AS is_host,
        p.qualification_status,
        current_days.local_date AS challenge_day_key
      FROM unlimited_challenge_participants p
      INNER JOIN unlimited_challenges c ON c.id = p.challenge_id
      LEFT JOIN current_days ON current_days.participant_id = p.id
      LEFT JOIN step_daily_totals s
        ON s.user_id = p.user_id
       AND s.date = current_days.local_date
      LEFT JOIN profiles pr ON pr.id = p.user_id
      WHERE p.challenge_id IN (${idList})
        AND p.entry_contribution_cents > 0
        AND p.qualification_status NOT IN (${nonActiveList})
    )
    SELECT
      challenge_id,
      participant_id,
      user_id,
      username,
      avatar_url,
      avatar_color,
      country_flag,
      current_steps,
      roster_rank,
      is_host,
      qualification_status,
      challenge_day_key
    FROM ranked
    WHERE roster_rank <= 3
    ORDER BY challenge_id, roster_rank
  `);

  const rawRows = rowsFromExecute<RawChallengeCardPlayerRow>(result);
  const provisionalByChallenge = new Map<string, Map<string, { provisionalSteps: number }>>();
  await Promise.all(
    challengeIds.map(async (challengeId) => {
      const entries = rawRows
        .filter((r) => r.challenge_id === challengeId && r.challenge_day_key)
        .map((r) => ({ userId: r.user_id, challengeDayKey: r.challenge_day_key! }));
      if (entries.length === 0) return;
      provisionalByChallenge.set(challengeId, await loadUnlimitedProvisionalMap(challengeId, entries));
    }),
  );

  const out = new Map<string, ChallengeCardPlayer[]>();
  for (const row of rawRows) {
    const verifiedSteps = Number(row.current_steps ?? 0);
    const provisional = row.challenge_day_key
      ? provisionalByChallenge.get(row.challenge_id)?.get(`${row.user_id}|${row.challenge_day_key}`)?.provisionalSteps
      : null;
    const player: ChallengeCardPlayer = {
      id: row.participant_id,
      participantId: row.participant_id,
      userId: row.user_id,
      username: row.username ?? `Player ${Number(row.roster_rank) || 1}`,
      avatarUrl: row.avatar_url ?? null,
      avatarColor: row.avatar_color ?? null,
      countryFlag: row.country_flag ?? null,
      currentSteps: displayedFromLanes(verifiedSteps, provisional),
      rank: Number(row.roster_rank) || 1,
      isHost: row.is_host,
      status: row.qualification_status,
      qualificationStatus: row.qualification_status,
    };
    const list = out.get(row.challenge_id) ?? [];
    list.push(player);
    out.set(row.challenge_id, list);
  }

  for (const players of out.values()) {
    players.sort((a, b) => b.currentSteps - a.currentSteps || a.rank - b.rank);
    players.forEach((p, i) => {
      p.rank = i + 1;
    });
  }
  return out;
}

async function loadCompletedChallengeCardPlayers(
  challenges: Array<typeof unlimitedChallengesTable.$inferSelect>,
): Promise<Map<string, ChallengeCardPlayer[]>> {
  const challengeIds = challenges.map((c) => c.id);
  if (challengeIds.length === 0) return new Map();

  const idList = sqlValues(challengeIds);
  const result = await db.execute(sql`
    WITH scored AS (
      SELECT
        p.challenge_id,
        p.id AS participant_id,
        p.user_id,
        pr.username,
        pr.avatar_url,
        pr.avatar_color,
        pr.country_flag,
        COALESCE(sum(d.verified_steps), 0)::int AS current_steps,
        count(*) FILTER (WHERE d.status = 'passed')::int AS passed_days,
        (p.user_id = c.host_user_id) AS is_host,
        p.qualification_status
      FROM unlimited_challenge_participants p
      INNER JOIN unlimited_challenges c ON c.id = p.challenge_id
      INNER JOIN unlimited_challenge_days d ON d.participant_id = p.id
      LEFT JOIN profiles pr ON pr.id = p.user_id
      WHERE p.challenge_id IN (${idList})
        AND p.entry_contribution_cents > 0
      GROUP BY
        p.challenge_id,
        p.id,
        p.user_id,
        pr.username,
        pr.avatar_url,
        pr.avatar_color,
        pr.country_flag,
        c.host_user_id,
        p.qualification_status
    ),
    ranked AS (
      SELECT
        scored.*,
        row_number() OVER (
          PARTITION BY scored.challenge_id
          ORDER BY scored.passed_days DESC, scored.current_steps DESC, scored.participant_id ASC
        )::int AS roster_rank
      FROM scored
    )
    SELECT
      challenge_id,
      participant_id,
      user_id,
      username,
      avatar_url,
      avatar_color,
      country_flag,
      current_steps,
      roster_rank,
      is_host,
      qualification_status
    FROM ranked
    WHERE roster_rank <= 3
    ORDER BY challenge_id, roster_rank
  `);

  const out = new Map<string, ChallengeCardPlayer[]>();
  for (const row of rowsFromExecute<RawChallengeCardPlayerRow>(result)) {
    const list = out.get(row.challenge_id) ?? [];
    list.push({
      id: row.participant_id,
      participantId: row.participant_id,
      userId: row.user_id,
      username: row.username ?? `Player ${Number(row.roster_rank) || 1}`,
      avatarUrl: row.avatar_url ?? null,
      avatarColor: row.avatar_color ?? null,
      countryFlag: row.country_flag ?? null,
      currentSteps: Number(row.current_steps ?? 0),
      rank: Number(row.roster_rank) || 1,
      isHost: row.is_host,
      status: row.qualification_status,
      qualificationStatus: row.qualification_status,
    });
    out.set(row.challenge_id, list);
  }
  return out;
}

async function loadChallengeCardPlayers(
  rows: Array<typeof unlimitedChallengesTable.$inferSelect>,
): Promise<Map<string, ChallengeCardPlayer[]>> {
  const completedRows = rows.filter(
    (c) => c.status === "completed" || c.status === "cancelled_by_platform" || c.resultsStatus === "results_ready",
  );
  const liveRows = rows.filter((c) => !completedRows.some((completed) => completed.id === c.id));
  const [livePlayers, completedPlayers] = await Promise.all([
    loadActiveChallengeCardPlayers(liveRows),
    loadCompletedChallengeCardPlayers(completedRows),
  ]);
  return new Map([...livePlayers, ...completedPlayers]);
}

async function overlayChallengeListCards(
  rows: Array<typeof unlimitedChallengesTable.$inferSelect>,
  userId: string,
) {
  const challengeIds = rows.map((r) => r.id);
  const [challenges, participantCounts, playersByChallenge] = await Promise.all([
    overlayMembership(rows, userId),
    loadChallengeParticipantCounts(challengeIds),
    loadChallengeCardPlayers(rows),
  ]);

  return challenges.map((challenge) => {
    const players = playersByChallenge.get(challenge.id) ?? [];
    return {
      ...challenge,
      participantCount: participantCounts.get(challenge.id) ?? 0,
      players,
      participants: players,
    };
  });
}

/** The timezone a not-yet-joined viewer would lock if they joined now. */
async function resolveViewerTimezone(userId: string): Promise<string> {
  const [pref] = await db
    .select({ timezone: userPreferencesTable.timezone })
    .from(userPreferencesTable)
    .where(eq(userPreferencesTable.userId, userId))
    .limit(1);
  return resolveLockableTimezone(pref?.timezone);
}

/**
 * Everything the viewer needs about THEIR OWN run, so no client has to reconstruct timezone rules.
 *
 * challenge.status is global; viewerStatus is personal. At one instant a challenge can be
 * `in_progress` while this viewer is still `scheduled` because their local midnight has not
 * arrived. Clients must branch on viewerStatus.
 */
async function buildViewerSchedule(
  challenge: typeof unlimitedChallengesTable.$inferSelect,
  userId: string,
) {
  const [participant] = await db
    .select({
      id: unlimitedChallengeParticipantsTable.id,
      participantTimezone: unlimitedChallengeParticipantsTable.participantTimezone,
      timezoneLockedAt: unlimitedChallengeParticipantsTable.timezoneLockedAt,
      participantStartAtUtc: unlimitedChallengeParticipantsTable.participantStartAtUtc,
      participantEndAtUtc: unlimitedChallengeParticipantsTable.participantEndAtUtc,
      qualificationStatus: unlimitedChallengeParticipantsTable.qualificationStatus,
      prizePoolEligibilityStatus: unlimitedChallengeParticipantsTable.prizePoolEligibilityStatus,
      eligibilityReasonCode: unlimitedChallengeParticipantsTable.eligibilityReasonCode,
      inSettlementPopulation: unlimitedChallengeParticipantsTable.inSettlementPopulation,
    })
    .from(unlimitedChallengeParticipantsTable)
    .where(and(
      eq(unlimitedChallengeParticipantsTable.challengeId, challenge.id),
      eq(unlimitedChallengeParticipantsTable.userId, userId),
    ))
    .limit(1);

  const days = participant ? await loadViewerDays(challenge.id, participant.id) : [];
  const state = deriveViewerState({ challenge, participant: participant ?? null, days });

  // Live steps for the open day come from the day row the ingest path credits by window.
  const currentDay = state.currentDayIndex
    ? await db
        .select({
          verifiedSteps: unlimitedChallengeDaysTable.verifiedSteps,
          goalSteps: unlimitedChallengeDaysTable.goalSteps,
          startBaselineSteps: unlimitedChallengeDaysTable.startBaselineSteps,
        })
        .from(unlimitedChallengeDaysTable)
        .where(and(
          eq(unlimitedChallengeDaysTable.challengeId, challenge.id),
          eq(unlimitedChallengeDaysTable.participantId, participant!.id),
          eq(unlimitedChallengeDaysTable.dayNumber, state.currentDayIndex),
        ))
        .limit(1)
        .then((r) => r[0] ?? null)
    : null;

  // §7 — counters behind "waiting for all registered participants to finish in their local
  // timezones". Derived from the frozen settlement population, never from a live row count.
  const closure = await areAllParticipantWindowsClosed(challenge.id);

  return {
    startLocalDate: resolveChallengeStartLocalDate(challenge),
    durationDays: challenge.durationDays,
    resultsStatus: challenge.resultsStatus,
    registeredParticipantCount: closure.registeredParticipantCount,
    participantsFinishedCount: closure.participantsFinishedCount,
    participantsPendingCount: closure.participantsPendingCount,
    latestParticipantEndAtUtc: isoOrNull(closure.latestParticipantEndAtUtc),
    // §10 — the viewer's own eligibility, explicit rather than inferred from day rows.
    prizePoolEligibilityStatus: participant?.prizePoolEligibilityStatus ?? null,
    eligibilityReasonCode: participant?.eligibilityReasonCode ?? null,
    inSettlementPopulation: participant?.inSettlementPopulation ?? null,
    viewerStatus: state.viewerStatus,
    viewerTimezone: state.viewerTimezone,
    viewerTimezoneLockedAt: isoOrNull(participant?.timezoneLockedAt),
    viewerStartAt: isoOrNull(state.viewerStartAt),
    viewerEndAt: isoOrNull(state.viewerEndAt),
    verificationPending: state.verificationPending,
    currentDayIndex: state.currentDayIndex,
    currentDayLocalDate: state.currentDayLocalDate,
    currentDayStartAt: isoOrNull(state.currentDayStartAt),
    currentDayEndAt: isoOrNull(state.currentDayEndAt),
    currentDayStatus: state.currentDayStatus,
    remainingDaysAfterToday: state.remainingDaysAfterToday,
    completedDays: state.completedDays,
    failedDays: state.failedDays,
    dailyGoalSteps: currentDay?.goalSteps ?? challenge.dailyGoalSteps,
    currentSteps: currentDay?.verifiedSteps ?? 0,
    // ── Tray cold-start restore ───────────────────────────────────────────────
    // Everything the Unlimited tray needs to rebuild itself after process death, without opening
    // Live Detail. challengeDayKey/participantTimezone are the PARTICIPANT's locked values — never
    // the host's — so a restored tray writes provisional progress against the right day key.
    challengeDayKey: state.currentDayLocalDate,
    participantLocalDate: state.currentDayLocalDate,
    participantTimezone: state.viewerTimezone,
    challengeDaySteps: Math.max(0, (currentDay?.verifiedSteps ?? 0) - (currentDay?.startBaselineSteps ?? 0)),
    raceStartBaselineSteps: currentDay?.startBaselineSteps ?? 0,
    // The tray must drive step sync through these, never through /api/races/:id/progress.
    unlimitedDailyMode: true,
    verifiedStepsEndpoint: "/api/walk/steps",
    provisionalStepsEndpoint: `/api/unlimited-challenges/${challenge.id}/live-progress`,
  };
}

// ── POST /unlimited-challenges/host ───────────────────────────────────────────
router.post("/unlimited-challenges/host", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid challenge parameters.", details: parsed.error.flatten() });
  const result = await createUnlimitedChallenge(userId, {
    ...parsed.data,
    // hostTimezone is the clearer name for what challengeTimezone has always meant.
    challengeTimezone: parsed.data.challengeTimezone ?? parsed.data.hostTimezone,
  });
  if (!result.ok) return res.status(result.httpStatus).json(result.body);
  return res.status(201).json({ challenge: serializeChallenge(result.data), inviteCode: result.data.inviteCode ?? undefined });
});

// ── POST /unlimited-challenges/:id/join ───────────────────────────────────────
router.post("/unlimited-challenges/:id/join", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const inviteCode = typeof req.body?.inviteCode === "string" ? req.body.inviteCode : undefined;
  const result = await joinUnlimitedChallenge(userId, String(req.params.id), { inviteCode });
  if (!result.ok) return res.status(result.httpStatus).json(result.body);
  return res.json({ success: true, ...result.data });
});

// ── POST /unlimited-challenges/:id/leave ──────────────────────────────────────
router.post("/unlimited-challenges/:id/leave", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const result = await leaveUnlimitedChallenge(userId, String(req.params.id));
  if (!result.ok) return res.status(result.httpStatus).json(result.body);
  // Leaving never cancels the challenge; the original host/creator is preserved for display.
  return res.json({
    success: true,
    challengeId: result.data.challengeId,
    raceContinues: true,
    challengeContinues: true,
    participationStatus: "left",
    participantStatus: "left",
    currentUserRegistered: false,
    current_user_registered: false,
    prizeEligible: false,
    refundEligible: result.data.refundIssued,
    refundIssued: result.data.refundIssued,
    refundAmount: result.data.refundAmountCents,
    refundAmountCents: result.data.refundAmountCents,
    activeChallengeReleased: true,
  });
});

// ── GET /unlimited-challenges/live (public running challenges for Live tab) ───
// Must be registered BEFORE /:id so "live" is not treated as an id.
router.get("/unlimited-challenges/live", requireAuth, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const rows = await db
    .select()
    .from(unlimitedChallengesTable)
    .where(
      and(
        eq(unlimitedChallengesTable.visibility, "public"),
        inArray(unlimitedChallengesTable.status, ["starting", "active", "settling"]),
      ),
    )
    .orderBy(desc(unlimitedChallengesTable.startAtUtc))
    .limit(limit)
    .offset(offset);

  const challenges = await overlayChallengeListCards(rows, userId);
  return res.json({ challenges, pagination: { limit, offset, count: rows.length } });
});

// ── GET /unlimited-challenges/recently-finished (Live tab Recently Finished) ───
router.get("/unlimited-challenges/recently-finished", requireAuth, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 50);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const rows = await db
    .select()
    .from(unlimitedChallengesTable)
    .where(
      and(
        eq(unlimitedChallengesTable.visibility, "public"),
        inArray(unlimitedChallengesTable.status, ["completed", "cancelled_by_platform"]),
      ),
    )
    .orderBy(desc(unlimitedChallengesTable.challengeEndAtUtc))
    .limit(limit)
    .offset(offset);

  const challenges = await overlayChallengeListCards(rows, userId);
  return res.json({ challenges, pagination: { limit, offset, count: rows.length } });
});

// ── GET /unlimited-challenges/my-active (membership-scoped open challenges) ───
router.get("/unlimited-challenges/my-active", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const rows = await db
    .select({
      challenge: unlimitedChallengesTable,
      participationStatus: unlimitedChallengeParticipantsTable.qualificationStatus,
    })
    .from(unlimitedChallengeParticipantsTable)
    .innerJoin(
      unlimitedChallengesTable,
      eq(unlimitedChallengesTable.id, unlimitedChallengeParticipantsTable.challengeId),
    )
    .where(
      and(
        eq(unlimitedChallengeParticipantsTable.userId, userId),
        notInArray(unlimitedChallengeParticipantsTable.qualificationStatus, [...UNLIMITED_NON_ACTIVE_STATUSES]),
        inArray(unlimitedChallengesTable.status, [...UNLIMITED_OPEN_STATUSES]),
      ),
    )
    .orderBy(desc(unlimitedChallengesTable.startAtUtc));

  // The Walk screen branches on viewerStatus, never on challenge.status: a challenge can be
  // globally `active` while this viewer is still `scheduled` until their own local midnight.
  // The Android daily foreground service reads viewerTimezone / currentDayEndAt / viewerEndAt
  // from here rather than reconstructing host-timezone semantics natively.
  const participantCounts = await loadChallengeParticipantCounts(rows.map((r) => r.challenge.id));
  const challenges = await Promise.all(
    rows.map(async (r) => {
      const participantCount = participantCounts.get(r.challenge.id) ?? 0;
      const viewer = await buildViewerSchedule(r.challenge, userId);
      return {
        ...serializeChallenge(r.challenge, { participantCount }),
        participationStatus: r.participationStatus,
        currentUserRegistered: true,
        current_user_registered: true,
        challengeStatus: r.challenge.status,
        viewer,
      };
    }),
  );
  return res.json({ challenge: challenges[0] ?? null, challenges, count: challenges.length });
});

// ── GET /unlimited-challenges (paginated public listing) ──────────────────────
// Default: public + waiting (Available / joinable).
// ?status=active|live|in_progress → public starting/active/settling (Live browse).
// ?status=waiting → explicit waiting (same as default).
router.get("/unlimited-challenges", requireAuth, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const statusRaw = typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : "";
  const liveStatuses = statusRaw === "active" || statusRaw === "live" || statusRaw === "in_progress";
  const finishedStatuses =
    statusRaw === "completed" ||
    statusRaw === "finished" ||
    statusRaw === "ended" ||
    statusRaw === "cancelled" ||
    statusRaw === "canceled";
  const statusFilter = liveStatuses
    ? inArray(unlimitedChallengesTable.status, ["starting", "active", "settling"])
    : finishedStatuses
      ? inArray(unlimitedChallengesTable.status, ["completed", "cancelled_by_platform"])
      : eq(unlimitedChallengesTable.status, "waiting");

  const rows = await db
    .select()
    .from(unlimitedChallengesTable)
    .where(and(eq(unlimitedChallengesTable.visibility, "public"), statusFilter))
    .orderBy(desc(unlimitedChallengesTable.startAtUtc))
    .limit(limit)
    .offset(offset);

  // Overlay the viewer's own membership and a trimmed roster so clients can render cards without
  // opening detail. Counts come from the live paid participant rows, never paidParticipantCount.
  const challenges = await overlayChallengeListCards(rows, userId);
  return res.json({ challenges, pagination: { limit, offset, count: rows.length } });
});

// ── GET /unlimited-challenges/:id (detail + membership + canJoin) ─────────────
router.get("/unlimited-challenges/:id", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const challengeId = String(req.params.id);
  const [challenge] = await db.select().from(unlimitedChallengesTable).where(eq(unlimitedChallengesTable.id, challengeId)).limit(1);
  if (!challenge) return res.status(404).json({ error: "Challenge not found." });

  const [membership] = await db
    .select({ status: unlimitedChallengeParticipantsTable.qualificationStatus })
    .from(unlimitedChallengeParticipantsTable)
    .where(and(eq(unlimitedChallengeParticipantsTable.challengeId, challengeId), eq(unlimitedChallengeParticipantsTable.userId, userId)))
    .limit(1);

  // canJoin uses THIS viewer's would-be local start, matching the join cutoff in the service. A
  // Chicago viewer can still join a challenge that already began for participants in India.
  const viewerTimezone = await resolveViewerTimezone(userId);
  const wouldStartAt = participantScheduleFor(challenge, viewerTimezone).startAtUtc;
  const canJoin = !membership && challenge.status === "waiting" && Date.now() < wouldStartAt.getTime();

  const [players, viewer] = await Promise.all([
    loadChallengePlayers(challengeId, userId, challenge.hostUserId),
    buildViewerSchedule(challenge, userId),
  ]);
  // The VIEWER's own locked day key wins. The roster-derived value is only a fallback for a
  // spectator who is not a participant — using another participant's day key to drive this
  // viewer's provisional writes is exactly the host-day-key bug we removed.
  const challengeDayKey =
    viewer.challengeDayKey ??
    players.find((p) => p.userId === userId)?.challengeDayKey ??
    players.find((p) => p.challengeDayKey)?.challengeDayKey ??
    null;
  const currentUserRegistered =
    !!membership
    && !UNLIMITED_NON_ACTIVE_STATUSES.includes(
      membership.status as typeof UNLIMITED_NON_ACTIVE_STATUSES[number],
    );
  return res.json({
    challenge: serializeChallenge(challenge, { participantCount: players.length }),
    membership: membership ? { status: membership.status } : null,
    currentUserRegistered,
    current_user_registered: currentUserRegistered,
    canJoin,
    // What a non-member would get if they joined right now — lets the client show a real date
    // instead of the host's.
    prospectiveStartAtUtc: membership ? null : wouldStartAt.toISOString(),
    prospectiveTimezone: membership ? null : viewerTimezone,
    ...viewer,
    challengeDayKey,
    participantCount: players.length,
    players,
    participants: players,
  });
});

// ── POST /unlimited-challenges/:id/live-progress (provisional sensor only) ─────
// Redis live state only. Never writes step_daily_totals / qualification / prizes.
const provisionalLiveSchema = z.object({
  challengeDayKey: z.string().min(1).max(32),
  timezone: z.string().min(1).max(64).optional(),
  provisionalCumulativeSteps: z.number().int().min(0).max(200000),
  source: z.string().max(50),
  measuredAtUtc: z.string().min(1).max(64).optional(),
  sessionId: z.string().min(1).max(128),
  sequence: z.number().int().min(0).max(1_000_000_000),
});

router.post("/unlimited-challenges/:id/live-progress", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const challengeId = String(req.params.id);
  const parsed = provisionalLiveSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid provisional progress", details: parsed.error.issues });
  }

  const source = normalizeSource(parsed.data.source);
  if (!isProvisionalLiveSource(source)) {
    return res.status(400).json({
      error: "Only provisional sensor sources are accepted on this endpoint.",
      code: "INVALID_PROVISIONAL_SOURCE",
      accepted: false,
    });
  }

  const [challenge] = await db
    .select()
    .from(unlimitedChallengesTable)
    .where(eq(unlimitedChallengesTable.id, challengeId))
    .limit(1);
  if (!challenge) return res.status(404).json({ error: "Challenge not found." });
  if (challenge.status !== "active") {
    return res.status(409).json({
      error: "Challenge is not active.",
      code: "CHALLENGE_NOT_ACTIVE",
      accepted: false,
    });
  }

  const [membership] = await db
    .select({
      participantId: unlimitedChallengeParticipantsTable.id,
      status: unlimitedChallengeParticipantsTable.qualificationStatus,
    })
    .from(unlimitedChallengeParticipantsTable)
    .where(
      and(
        eq(unlimitedChallengeParticipantsTable.challengeId, challengeId),
        eq(unlimitedChallengeParticipantsTable.userId, userId),
      ),
    )
    .limit(1);
  if (!membership || membership.status === "left" || membership.status === "disqualified") {
    return res.status(403).json({ error: "Not an active participant.", accepted: false });
  }

  const now = new Date();
  const [dayRow] = await db
    .select({
      localDate: unlimitedChallengeDaysTable.localDate,
      dayNumber: unlimitedChallengeDaysTable.dayNumber,
      goalSteps: unlimitedChallengeDaysTable.goalSteps,
      timezone: unlimitedChallengeDaysTable.timezone,
      status: unlimitedChallengeDaysTable.status,
      startBaselineSteps: unlimitedChallengeDaysTable.startBaselineSteps,
    })
    .from(unlimitedChallengeDaysTable)
    .where(
      and(
        eq(unlimitedChallengeDaysTable.challengeId, challengeId),
        eq(unlimitedChallengeDaysTable.participantId, membership.participantId),
        lte(unlimitedChallengeDaysTable.windowStartUtc, now),
        gt(unlimitedChallengeDaysTable.windowEndUtc, now),
      ),
    )
    .limit(1);

  if (!dayRow) {
    return res.status(409).json({
      error: "No active challenge day window.",
      code: "NO_ACTIVE_DAY",
      accepted: false,
    });
  }
  if (parsed.data.challengeDayKey !== dayRow.localDate) {
    return res.status(409).json({
      error: "Challenge day mismatch.",
      code: "WRONG_CHALLENGE_DAY",
      accepted: false,
      expectedChallengeDayKey: dayRow.localDate,
    });
  }

  const applied = await applyUnlimitedProvisionalLive({
    challengeId,
    userId,
    challengeDayKey: dayRow.localDate,
    provisionalCumulativeSteps: parsed.data.provisionalCumulativeSteps,
    source: source!,
    measuredAtUtc: parsed.data.measuredAtUtc ?? now.toISOString(),
    sessionId: parsed.data.sessionId,
    sequence: parsed.data.sequence,
  });

  if (!applied.accepted) {
    return res.status(409).json({
      accepted: false,
      reason: applied.reason,
      provisionalTodaySteps: applied.state?.provisionalSteps ?? 0,
    });
  }

  // Verified lane from step_daily_totals — never updated by this endpoint.
  const [verifiedRow] = await db
    .select({ steps: stepDailyTotalsTable.steps })
    .from(stepDailyTotalsTable)
    .where(
      and(
        eq(stepDailyTotalsTable.userId, userId),
        eq(stepDailyTotalsTable.date, dayRow.localDate),
      ),
    )
    .limit(1);
  const verifiedTodaySteps = verifiedRow?.steps ?? 0;
  const provisionalTodaySteps = applied.state.provisionalSteps;
  const displayedLiveSteps = displayedFromLanes(verifiedTodaySteps, provisionalTodaySteps);
  const progressSource = progressSourceFromLanes(verifiedTodaySteps, provisionalTodaySteps);
  const timezone = parsed.data.timezone || dayRow.timezone || challenge.challengeTimezone;
  const updatedAt = now.toISOString();

  const payload = {
    challengeId,
    userId,
    participantId: membership.participantId,
    challengeDayKey: dayRow.localDate,
    localDate: dayRow.localDate,
    timezone,
    dayNumber: dayRow.dayNumber,
    goalSteps: dayRow.goalSteps,
    dailyGoalSteps: dayRow.goalSteps,
    verifiedTodaySteps,
    provisionalTodaySteps,
    displayedLiveSteps,
    currentSteps: displayedLiveSteps,
    todaySteps: displayedLiveSteps,
    steps: displayedLiveSteps,
    progressSource,
    verificationStatus:
      provisionalTodaySteps > verifiedTodaySteps
        ? "verification_delayed"
        : verifiedTodaySteps > 0
          ? "verified"
          : "syncing",
    // Never claim goalReached from provisional alone.
    goalReached: verifiedTodaySteps >= dayRow.goalSteps,
    // Display only — same shape the verified broadcast from /api/walk/steps emits.
    raceStartBaselineSteps: dayRow.startBaselineSteps,
    challengeDaySteps: Math.max(0, displayedLiveSteps - dayRow.startBaselineSteps),
    updatedAt,
  };

  if (!applied.unchanged) {
    emitUnlimitedRealtime(challengeId, "progress_updated", payload, {
      event: "race:progress_updated",
      payload: { raceId: challengeId, ...payload },
    });
  }

  return res.json({
    accepted: true,
    unchanged: applied.unchanged,
    ...payload,
  });
});

// ── GET /unlimited-challenges/:id/daily-history ───────────────────────────────
// §12/§15 — the complete, historically queryable day-by-day record: exactly durationDays rows
// (7/10/30/60/90), each carrying the calendar date in the participant's locked timezone so a
// finished challenge can be rendered without re-deriving any timezone rules.
//
// ?userId= views another participant's history (the board is public within the challenge);
// omitted, it returns the caller's own.
router.get("/unlimited-challenges/:id/daily-history", requireAuth, async (req, res) => {
  const viewerId = (req as AuthenticatedRequest).descopeUserId;
  const challengeId = String(req.params.id);
  const targetUserId = typeof req.query.userId === "string" && req.query.userId ? req.query.userId : viewerId;

  const [challenge] = await db
    .select()
    .from(unlimitedChallengesTable)
    .where(eq(unlimitedChallengesTable.id, challengeId))
    .limit(1);
  if (!challenge) return res.status(404).json({ error: "Challenge not found." });

  const [participant] = await db
    .select({
      id: unlimitedChallengeParticipantsTable.id,
      userId: unlimitedChallengeParticipantsTable.userId,
      participantTimezone: unlimitedChallengeParticipantsTable.participantTimezone,
      participantStartAtUtc: unlimitedChallengeParticipantsTable.participantStartAtUtc,
      participantEndAtUtc: unlimitedChallengeParticipantsTable.participantEndAtUtc,
      qualificationStatus: unlimitedChallengeParticipantsTable.qualificationStatus,
      prizePoolEligibilityStatus: unlimitedChallengeParticipantsTable.prizePoolEligibilityStatus,
      eligibilityReasonCode: unlimitedChallengeParticipantsTable.eligibilityReasonCode,
      inSettlementPopulation: unlimitedChallengeParticipantsTable.inSettlementPopulation,
    })
    .from(unlimitedChallengeParticipantsTable)
    .where(and(
      eq(unlimitedChallengeParticipantsTable.challengeId, challengeId),
      eq(unlimitedChallengeParticipantsTable.userId, targetUserId),
    ))
    .limit(1);
  if (!participant) return res.status(404).json({ error: "Participant not found in this challenge." });

  const dayRows = await db
    .select({
      dayNumber: unlimitedChallengeDaysTable.dayNumber,
      localDate: unlimitedChallengeDaysTable.localDate,
      timezone: unlimitedChallengeDaysTable.timezone,
      windowStartUtc: unlimitedChallengeDaysTable.windowStartUtc,
      windowEndUtc: unlimitedChallengeDaysTable.windowEndUtc,
      goalSteps: unlimitedChallengeDaysTable.goalSteps,
      verifiedSteps: unlimitedChallengeDaysTable.verifiedSteps,
      status: unlimitedChallengeDaysTable.status,
      passedAt: unlimitedChallengeDaysTable.passedAt,
      finalizedAt: unlimitedChallengeDaysTable.finalizedAt,
      createdAt: unlimitedChallengeDaysTable.createdAt,
      updatedAt: unlimitedChallengeDaysTable.updatedAt,
    })
    .from(unlimitedChallengeDaysTable)
    .where(and(
      eq(unlimitedChallengeDaysTable.challengeId, challengeId),
      eq(unlimitedChallengeDaysTable.participantId, participant.id),
    ))
    .orderBy(asc(unlimitedChallengeDaysTable.dayNumber));

  const now = new Date();
  const days = dayRows.map((d) => ({
    dayIndex: d.dayNumber,
    dayNumber: d.dayNumber,
    participantLocalDate: d.localDate,
    localDate: d.localDate,
    participantTimezone: d.timezone,
    windowStartUtc: d.windowStartUtc,
    windowEndUtc: d.windowEndUtc,
    dailyGoalSteps: d.goalSteps,
    goalSteps: d.goalSteps,
    verifiedSteps: d.verifiedSteps,
    // Qualification only ever uses the authoritative Health Connect / HealthKit value; provisional
    // sensor steps are live UX and never reach this record.
    verificationSource: "health_connect_or_healthkit",
    verificationStatus: d.finalizedAt ? "final" : d.status === "pending_verification" ? "awaiting_verification" : "live",
    // §14 client-facing vocabulary: upcoming | in_progress | validation_pending | passed | failed.
    dayStatus: toDayStatus(d.status, d.windowStartUtc, d.windowEndUtc, now),
    storedStatus: d.status,
    passedAt: d.passedAt,
    finalizedAt: d.finalizedAt,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }));

  return res.json({
    challengeId,
    userId: participant.userId,
    participantId: participant.id,
    durationDays: challenge.durationDays,
    dailyGoalSteps: challenge.dailyGoalSteps,
    startLocalDate: resolveChallengeStartLocalDate(challenge),
    participantTimezone: participant.participantTimezone,
    participantStartAtUtc: participant.participantStartAtUtc,
    participantEndAtUtc: participant.participantEndAtUtc,
    resultsStatus: challenge.resultsStatus,
    prizePoolEligibilityStatus: participant.prizePoolEligibilityStatus,
    eligibilityReasonCode: participant.eligibilityReasonCode,
    inSettlementPopulation: participant.inSettlementPopulation,
    // §20 — history is never erased when eligibility is lost: a participant who failed day 4 still
    // accumulates days 5..N, so the record can show "passed 6, failed 1, not eligible".
    passedDays: days.filter((d) => d.dayStatus === "passed").length,
    failedDays: days.filter((d) => d.dayStatus === "failed").length,
    pendingDays: days.filter((d) => d.dayStatus === "validation_pending" || d.dayStatus === "in_progress").length,
    days,
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Chat: comments + reactions
//
// Same request/response contract as /api/races/:id/comments and /reactions, down to the
// `raceRoomId` field name, so the client can reuse its existing chat component unchanged. Rows
// live in the same live_race_comments / live_race_reactions tables keyed by challengeId — those
// columns are plain text with no foreign key to race_rooms, so no new table or migration is
// needed and the two feeds can never diverge in shape.
//
// The membership check is the one real difference: unlimited_challenge_participants instead of
// race_participants, since an Unlimited challenge has no race_participants rows at all.
// ══════════════════════════════════════════════════════════════════════════════

/** Emoji whitelist — identical to the classic race reaction set. */
const VALID_REACTION_EMOJI = ["🔥", "👏", "👑", "🏃", "🏆", "😮", "❤️"];

/**
 * True if the user may post to this challenge's chat.
 *
 * Excludes `left` and `disqualified`, matching the classic rule that only live participants can
 * broadcast on a public channel. Note this also silences someone who missed a day but is still
 * watching the challenge run — that is the requested behavior, and it is a one-line change here
 * if you would rather keep disqualified participants in the conversation.
 */
async function isUnlimitedChatParticipant(userId: string, challengeId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: unlimitedChallengeParticipantsTable.id })
    .from(unlimitedChallengeParticipantsTable)
    .where(and(
      eq(unlimitedChallengeParticipantsTable.challengeId, challengeId),
      eq(unlimitedChallengeParticipantsTable.userId, userId),
      notInArray(unlimitedChallengeParticipantsTable.qualificationStatus, [...UNLIMITED_NON_ACTIVE_STATUSES]),
    ))
    .limit(1);
  return Boolean(row);
}

// ── GET /unlimited-challenges/:id/comments ────────────────────────────────────
router.get("/unlimited-challenges/:id/comments", requireAuth, async (req, res) => {
  const challengeId = String(req.params.id);
  const rows = await db
    .select({
      id:          liveRaceCommentsTable.id,
      raceRoomId:  liveRaceCommentsTable.raceRoomId,
      userId:      liveRaceCommentsTable.userId,
      username:    liveRaceCommentsTable.username,
      countryFlag: liveRaceCommentsTable.countryFlag,
      avatarColor: liveRaceCommentsTable.avatarColor,
      text:        liveRaceCommentsTable.text,
      createdAt:   liveRaceCommentsTable.createdAt,
      avatarUrl:      profilesTable.avatarUrl,
      avatarVersion:  profilesTable.updatedAt,
    })
    .from(liveRaceCommentsTable)
    .leftJoin(profilesTable, eq(profilesTable.id, liveRaceCommentsTable.userId))
    .where(eq(liveRaceCommentsTable.raceRoomId, challengeId))
    .orderBy(asc(liveRaceCommentsTable.createdAt))
    .limit(60);
  return res.json({
    comments: rows.map((r) => ({
      ...r,
      avatarUrl:     r.avatarUrl ?? null,
      avatarVersion: r.avatarVersion?.getTime() ?? 0,
    })),
  });
});

// ── POST /unlimited-challenges/:id/comments ───────────────────────────────────
router.post("/unlimited-challenges/:id/comments", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const challengeId = String(req.params.id);
  const { text, clientMessageId } = req.body as { text?: unknown; clientMessageId?: unknown };

  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "text is required" });
  }

  const clientMsgId = typeof clientMessageId === "string" && clientMessageId.length > 0 && clientMessageId.length <= 80
    ? clientMessageId : undefined;

  // Only participants may post — otherwise any authenticated user could inject comments and
  // broadcast them on this challenge's public channel.
  if (!(await isUnlimitedChatParticipant(userId, challengeId))) {
    return res.status(403).json({ error: "Only challenge participants can comment." });
  }

  const [profile] = await db
    .select({ username: profilesTable.username, countryFlag: profilesTable.countryFlag, avatarColor: profilesTable.avatarColor, avatarUrl: profilesTable.avatarUrl, updatedAt: profilesTable.updatedAt })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);

  if (!profile) return res.status(404).json({ error: "Profile not found" });

  const [inserted] = await db.insert(liveRaceCommentsTable).values({
    raceRoomId:  challengeId,
    userId,
    username:    profile.username,
    countryFlag: profile.countryFlag ?? "🏳️",
    avatarColor: profile.avatarColor ?? "#00E676",
    text:        text.trim(),
  }).returning();

  const comment = {
    id:            inserted.id,
    raceRoomId:    inserted.raceRoomId,
    userId:        inserted.userId,
    username:      inserted.username,
    countryFlag:   inserted.countryFlag,
    avatarColor:   inserted.avatarColor,
    avatarUrl:     profile.avatarUrl ?? null,
    avatarVersion: profile.updatedAt?.getTime() ?? 0,
    text:          inserted.text,
    createdAt:     inserted.createdAt instanceof Date ? inserted.createdAt.toISOString() : String(inserted.createdAt),
    clientMessageId: clientMsgId,
  };

  // Same fan-out as progress_updated: the native unlimited channel plus the compatibility
  // public-live-race channel carrying the classic event name the chat client already binds.
  emitUnlimitedRealtime(challengeId, "comment_new", { comment }, {
    event: "race:comment_new",
    payload: { comment },
  });
  return res.json({ comment });
});

// ── GET /unlimited-challenges/:id/reactions ───────────────────────────────────
router.get("/unlimited-challenges/:id/reactions", requireAuth, async (req, res) => {
  const challengeId = String(req.params.id);
  const rows = await db
    .select({
      emoji: liveRaceReactionsTable.emoji,
      count: sql<number>`count(*)::int`,
    })
    .from(liveRaceReactionsTable)
    .where(eq(liveRaceReactionsTable.raceRoomId, challengeId))
    .groupBy(liveRaceReactionsTable.emoji);
  return res.json({ reactions: rows });
});

// ── POST /unlimited-challenges/:id/reactions ──────────────────────────────────
router.post("/unlimited-challenges/:id/reactions", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const challengeId = String(req.params.id);
  const { emoji } = req.body as { emoji?: unknown };

  if (typeof emoji !== "string" || !VALID_REACTION_EMOJI.includes(emoji)) {
    return res.status(400).json({ error: "Invalid emoji" });
  }

  if (!(await isUnlimitedChatParticipant(userId, challengeId))) {
    return res.status(403).json({ error: "Only challenge participants can react." });
  }

  await db.insert(liveRaceReactionsTable).values({ raceRoomId: challengeId, userId, emoji });

  const counts = await db
    .select({ emoji: liveRaceReactionsTable.emoji, count: sql<number>`count(*)::int` })
    .from(liveRaceReactionsTable)
    .where(eq(liveRaceReactionsTable.raceRoomId, challengeId))
    .groupBy(liveRaceReactionsTable.emoji);

  emitUnlimitedRealtime(challengeId, "reaction_updated", { counts }, {
    event: "race:reaction_updated",
    payload: { counts },
  });
  return res.json({ success: true, counts });
});

// ── GET /unlimited-challenges/:id/leaderboard (paginated, informational) ──────
router.get("/unlimited-challenges/:id/leaderboard", requireAuth, async (req, res) => {
  const challengeId = String(req.params.id);
  // Live Board may paginate the full roster (100+/page). Cap keeps abuse bounded.
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  // Bounded, paginated. Ranking is informational only (never affects payout): eligible first,
  // then more completed (passed) days, then total verified steps.
  const rows = await db
    .select({
      participantId: unlimitedChallengeParticipantsTable.id,
      userId: unlimitedChallengeParticipantsTable.userId,
      username: profilesTable.username,
      fullName: profilesTable.fullName,
      qualificationStatus: unlimitedChallengeParticipantsTable.qualificationStatus,
      prizePoolEligibilityStatus: unlimitedChallengeParticipantsTable.prizePoolEligibilityStatus,
      eligibilityReasonCode: unlimitedChallengeParticipantsTable.eligibilityReasonCode,
      completedDays: sql<number>`count(*) filter (where ${unlimitedChallengeDaysTable.status} = 'passed')::int`,
      totalSteps: sql<number>`coalesce(sum(${unlimitedChallengeDaysTable.verifiedSteps}), 0)::int`,
    })
    .from(unlimitedChallengeParticipantsTable)
    .leftJoin(unlimitedChallengeDaysTable, eq(unlimitedChallengeDaysTable.participantId, unlimitedChallengeParticipantsTable.id))
    .leftJoin(profilesTable, eq(profilesTable.id, unlimitedChallengeParticipantsTable.userId))
    .where(
      and(
        eq(unlimitedChallengeParticipantsTable.challengeId, challengeId),
        notInArray(unlimitedChallengeParticipantsTable.qualificationStatus, [...UNLIMITED_NON_ACTIVE_STATUSES]),
      ),
    )
    .groupBy(
      unlimitedChallengeParticipantsTable.id,
      unlimitedChallengeParticipantsTable.userId,
      profilesTable.username,
      profilesTable.fullName,
      unlimitedChallengeParticipantsTable.qualificationStatus,
    )
    .orderBy(
      sql`(${unlimitedChallengeParticipantsTable.qualificationStatus} = 'disqualified')`,
      sql`count(*) filter (where ${unlimitedChallengeDaysTable.status} = 'passed') desc`,
      sql`coalesce(sum(${unlimitedChallengeDaysTable.verifiedSteps}), 0) desc`,
      unlimitedChallengeParticipantsTable.id,
    )
    .limit(limit)
    .offset(offset);

  // currentSteps = active challenge-day display (verified + provisional overlay).
  // totalChallengeSteps stays finalized + verified today only.
  const activeByParticipant = await loadActiveDayProgressByChallenge(challengeId);
  return res.json({
    leaderboard: rows.map((r, i) => {
      const live = activeByParticipant.get(r.participantId);
      const verifiedToday = live?.verifiedTodaySteps ?? 0;
      const provisionalToday = live?.provisionalTodaySteps ?? 0;
      const currentSteps = live?.currentSteps ?? verifiedToday;
      const displayName =
        (r.fullName && r.fullName.trim()) ||
        r.username ||
        `Player ${offset + i + 1}`;
      return {
        rank: offset + i + 1,
        participantId: r.participantId,
        userId: r.userId,
        username: r.username ?? displayName,
        fullName: r.fullName ?? null,
        displayName,
        qualificationStatus: r.qualificationStatus,
        prizePoolEligibilityStatus: r.prizePoolEligibilityStatus,
        eligibilityReason: publicEligibilityReason(r.eligibilityReasonCode),
        completedDays: r.completedDays,
        totalChallengeSteps: r.totalSteps + verifiedToday,
        currentSteps,
        verifiedTodaySteps: verifiedToday,
        provisionalTodaySteps: provisionalToday,
        displayedLiveSteps: currentSteps,
        progressSource: live?.progressSource ?? "unavailable",
        challengeDayKey: live?.challengeDayKey ?? null,
        localDate: live?.localDate ?? null,
        timezone: live?.timezone ?? null,
        dayNumber: live?.dayNumber ?? null,
        dailyGoalSteps: live?.goalSteps ?? null,
        // Display-only "steps during this challenge day". Ranking above still uses passed days
        // then total verified steps — the baseline never touches ordering or payout.
        raceStartBaselineSteps: live?.startBaselineSteps ?? 0,
        challengeDaySteps: live?.challengeDaySteps ?? currentSteps,
      };
    }),
    pagination: { limit, offset, count: rows.length },
  });
});

export default router;
