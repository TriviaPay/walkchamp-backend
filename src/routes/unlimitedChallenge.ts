import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, desc, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import { profilesTable } from "../../db/src/schema/profiles.js";
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
import {
  loadActiveDayProgressByChallenge,
  loadChallengePlayers,
} from "../lib/unlimitedLiveProgress.js";
import {
  applyUnlimitedProvisionalLive,
  displayedFromLanes,
  progressSourceFromLanes,
} from "../lib/unlimitedProvisionalLive.js";
import { emitUnlimitedRealtime } from "../lib/unlimitedRealtime.js";
import { isProvisionalLiveSource, normalizeSource } from "../lib/stepSources.js";
import { stepDailyTotalsTable } from "../../db/src/schema/steps.js";

const router: Router = Router();

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
  startAtIso: z.string(),
  // Optional IANA timezone the schedule is anchored to; falls back to the host's saved timezone.
  challengeTimezone: z.string().min(1).max(64).optional(),
});

function serializeChallenge(c: typeof unlimitedChallengesTable.$inferSelect) {
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
    challengeTimezone: c.challengeTimezone,
    startAtUtc: c.startAtUtc,
    registrationClosesAtUtc: c.registrationClosesAtUtc,
    challengeEndAtUtc: c.challengeEndAtUtc,
    prizePoolCents: c.prizePoolCents,
    participantCount: c.paidParticipantCount,
    qualifiedParticipantCount: c.qualifiedParticipantCount,
    settlementStatus: c.settlementStatus,
    createdAt: c.createdAt,
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
    return {
      ...serializeChallenge(c),
      participationStatus: status,
      currentUserRegistered: status != null && status !== "left",
    };
  });
}

// ── POST /unlimited-challenges/host ───────────────────────────────────────────
router.post("/unlimited-challenges/host", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid challenge parameters.", details: parsed.error.flatten() });
  const result = await createUnlimitedChallenge(userId, parsed.data);
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

  const challenges = await overlayMembership(rows, userId);
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

  const challenges = await overlayMembership(rows, userId);
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
        ne(unlimitedChallengeParticipantsTable.qualificationStatus, "left"),
        inArray(unlimitedChallengesTable.status, [...UNLIMITED_OPEN_STATUSES]),
      ),
    )
    .orderBy(desc(unlimitedChallengesTable.startAtUtc));

  const challenges = rows.map((r) => ({
    ...serializeChallenge(r.challenge),
    participationStatus: r.participationStatus,
    currentUserRegistered: true,
  }));
  return res.json({ challenges, count: challenges.length });
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

  // Overlay the viewer's own membership so clients can tell "is this mine?" by
  // participation rather than falling back to hostUserId. One batched lookup for all listed rows.
  const challenges = await overlayMembership(rows, userId);
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

  const canJoin = !membership && challenge.status === "waiting" && Date.now() < challenge.startAtUtc.getTime();
  const players = await loadChallengePlayers(challengeId, userId, challenge.hostUserId);
  const challengeDayKey =
    players.find((p) => p.userId === userId)?.challengeDayKey ??
    players.find((p) => p.challengeDayKey)?.challengeDayKey ??
    null;
  return res.json({
    challenge: {
      ...serializeChallenge(challenge),
      challengeDayKey,
    },
    membership: membership ? { status: membership.status } : null,
    currentUserRegistered: !!membership && membership.status !== "left",
    canJoin,
    challengeDayKey,
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
      completedDays: sql<number>`count(*) filter (where ${unlimitedChallengeDaysTable.status} = 'passed')::int`,
      totalSteps: sql<number>`coalesce(sum(${unlimitedChallengeDaysTable.verifiedSteps}), 0)::int`,
    })
    .from(unlimitedChallengeParticipantsTable)
    .leftJoin(unlimitedChallengeDaysTable, eq(unlimitedChallengeDaysTable.participantId, unlimitedChallengeParticipantsTable.id))
    .leftJoin(profilesTable, eq(profilesTable.id, unlimitedChallengeParticipantsTable.userId))
    .where(and(eq(unlimitedChallengeParticipantsTable.challengeId, challengeId), ne(unlimitedChallengeParticipantsTable.qualificationStatus, "left")))
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
      };
    }),
    pagination: { limit, offset, count: rows.length },
  });
});

export default router;
