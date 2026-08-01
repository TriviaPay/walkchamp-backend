import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, asc, desc, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import { profilesTable } from "../../db/src/schema/profiles.js";
import { stepDailyTotalsTable } from "../../db/src/schema/steps.js";
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
} from "../lib/unlimitedChallengeService.js";

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
    hostUserId: c.hostUserId,
    title: c.title,
    visibility: c.visibility,
    capacityMode: "unlimited",
    maxParticipants: null,
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

async function loadChallengePlayers(challengeId: string, currentUserId: string, hostUserId: string) {
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
    .innerJoin(profilesTable, eq(profilesTable.id, unlimitedChallengeParticipantsTable.userId))
    .where(and(eq(unlimitedChallengeParticipantsTable.challengeId, challengeId), ne(unlimitedChallengeParticipantsTable.qualificationStatus, "left")))
    .orderBy(
      sql`(${unlimitedChallengeParticipantsTable.userId} = ${hostUserId}) desc`,
      asc(unlimitedChallengeParticipantsTable.joinedAt),
      asc(unlimitedChallengeParticipantsTable.id),
    );

  const now = new Date();

  // Per-participant finalized aggregates: completed (passed) days + verified step sum across all days.
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

  // The day whose window currently contains `now` gives each participant's live local date. Its
  // verifiedSteps stays 0 until finalized, so today's steps come from step_daily_totals (the same
  // source finalizeUnlimitedDays reads), keeping the live number consistent with settlement.
  const currentDays = await db
    .select({
      participantId: unlimitedChallengeDaysTable.participantId,
      userId: unlimitedChallengeDaysTable.userId,
      localDate: unlimitedChallengeDaysTable.localDate,
    })
    .from(unlimitedChallengeDaysTable)
    .where(
      and(
        eq(unlimitedChallengeDaysTable.challengeId, challengeId),
        lte(unlimitedChallengeDaysTable.windowStartUtc, now),
        gt(unlimitedChallengeDaysTable.windowEndUtc, now),
      ),
    );
  const currentDayByParticipant = new Map(currentDays.map((d) => [d.participantId, d]));

  const liveByUserDate = new Map<string, number>();
  if (currentDays.length) {
    const stepRows = await db
      .select({ userId: stepDailyTotalsTable.userId, date: stepDailyTotalsTable.date, steps: stepDailyTotalsTable.steps })
      .from(stepDailyTotalsTable)
      .where(
        and(
          inArray(stepDailyTotalsTable.userId, currentDays.map((d) => d.userId)),
          inArray(stepDailyTotalsTable.date, currentDays.map((d) => d.localDate)),
        ),
      );
    for (const s of stepRows) liveByUserDate.set(`${s.userId}|${s.date}`, s.steps);
  }

  return rows.map((p, i) => {
    const agg = aggByParticipant.get(p.participantId);
    const cur = currentDayByParticipant.get(p.participantId);
    const todaySteps = cur ? liveByUserDate.get(`${cur.userId}|${cur.localDate}`) ?? 0 : 0;
    const finalizedSteps = agg?.finalizedSteps ?? 0;
    return {
      id: p.participantId,
      participantId: p.participantId,
      userId: p.userId,
      username: p.username,
      fullName: p.fullName,
      displayName: p.fullName || p.username,
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
      friendStatus: "none",
      friendRequestId: null,
      activeTitle: null,
      // Live today's steps (from step_daily_totals); verified finalized days plus today's live for the total.
      currentSteps: todaySteps,
      completedDays: agg?.completedDays ?? 0,
      totalChallengeSteps: finalizedSteps + todaySteps,
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

// ── GET /unlimited-challenges (paginated public listing) ──────────────────────
router.get("/unlimited-challenges", requireAuth, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const rows = await db
    .select()
    .from(unlimitedChallengesTable)
    .where(and(eq(unlimitedChallengesTable.visibility, "public"), eq(unlimitedChallengesTable.status, "waiting")))
    .orderBy(desc(unlimitedChallengesTable.startAtUtc))
    .limit(limit)
    .offset(offset);

  // Overlay the viewer's own membership so clients can tell "is this mine?" by
  // participation rather than falling back to hostUserId. One batched lookup for all listed rows.
  const memberships = rows.length
    ? await db
        .select({ challengeId: unlimitedChallengeParticipantsTable.challengeId, status: unlimitedChallengeParticipantsTable.qualificationStatus })
        .from(unlimitedChallengeParticipantsTable)
        .where(and(eq(unlimitedChallengeParticipantsTable.userId, userId), inArray(unlimitedChallengeParticipantsTable.challengeId, rows.map((r) => r.id))))
    : [];
  const statusByChallenge = new Map(memberships.map((m) => [m.challengeId, m.status]));

  const challenges = rows.map((c) => {
    const status = statusByChallenge.get(c.id) ?? null;
    return {
      ...serializeChallenge(c),
      participationStatus: status,
      currentUserRegistered: status != null && status !== "left",
    };
  });
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
  return res.json({
    challenge: serializeChallenge(challenge),
    membership: membership ? { status: membership.status } : null,
    currentUserRegistered: !!membership && membership.status !== "left",
    canJoin,
    players,
    participants: players,
  });
});

// ── GET /unlimited-challenges/:id/leaderboard (paginated, informational) ──────
router.get("/unlimited-challenges/:id/leaderboard", requireAuth, async (req, res) => {
  const challengeId = String(req.params.id);
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  // Bounded, paginated. Ranking is informational only (never affects payout): eligible first,
  // then more completed (passed) days, then total verified steps.
  const rows = await db
    .select({
      participantId: unlimitedChallengeParticipantsTable.id,
      userId: unlimitedChallengeParticipantsTable.userId,
      username: profilesTable.username,
      qualificationStatus: unlimitedChallengeParticipantsTable.qualificationStatus,
      completedDays: sql<number>`count(*) filter (where ${unlimitedChallengeDaysTable.status} = 'passed')::int`,
      totalSteps: sql<number>`coalesce(sum(${unlimitedChallengeDaysTable.verifiedSteps}), 0)::int`,
    })
    .from(unlimitedChallengeParticipantsTable)
    .leftJoin(unlimitedChallengeDaysTable, eq(unlimitedChallengeDaysTable.participantId, unlimitedChallengeParticipantsTable.id))
    .innerJoin(profilesTable, eq(profilesTable.id, unlimitedChallengeParticipantsTable.userId))
    .where(and(eq(unlimitedChallengeParticipantsTable.challengeId, challengeId), ne(unlimitedChallengeParticipantsTable.qualificationStatus, "left")))
    .groupBy(unlimitedChallengeParticipantsTable.id, unlimitedChallengeParticipantsTable.userId, profilesTable.username, unlimitedChallengeParticipantsTable.qualificationStatus)
    .orderBy(
      sql`(${unlimitedChallengeParticipantsTable.qualificationStatus} = 'disqualified')`,
      sql`count(*) filter (where ${unlimitedChallengeDaysTable.status} = 'passed') desc`,
      sql`coalesce(sum(${unlimitedChallengeDaysTable.verifiedSteps}), 0) desc`,
      unlimitedChallengeParticipantsTable.id,
    )
    .limit(limit)
    .offset(offset);

  return res.json({
    leaderboard: rows.map((r, i) => ({
      rank: offset + i + 1,
      participantId: r.participantId,
      userId: r.userId,
      displayName: r.username,
      qualificationStatus: r.qualificationStatus,
      completedDays: r.completedDays,
      totalChallengeSteps: r.totalSteps,
    })),
    pagination: { limit, offset, count: rows.length },
  });
});

export default router;
