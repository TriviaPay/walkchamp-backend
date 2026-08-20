import { Router } from "express";
import { db } from "../../db/src/index.js";
import {
  profilesTable,
  raceRoomsTable,
  raceParticipantsTable,
  walletsTable,
  walletTransactionsTable,
  withdrawalsTable,
  notificationsTable,
  operationalLocksTable,
  sponsoredGiftCardAwardsTable,
  authSessionsTable,
  scheduledRoomRegistrationsTable,
} from "../../db/src/schema/index.js";
import { eq, and, desc, ilike, or, sql, inArray, gt } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import { requireAdminRole } from "../middleware/requireAdminRole.js";
import { requireCashFeaturesEnabled } from "../middleware/requireCashFeaturesEnabled.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { cacheAccountStatus, revokeSession } from "../lib/sessionService.js";
import { getDescopeClient } from "../lib/descope.js";
import {
  approveRefund,
  getRefund,
  getRefundBatch,
  listRefunds,
  rejectRefund,
} from "../lib/refundService.js";
import { assertOperationalLockOpen, setOperationalLock, WALLET_LEDGER_ANOMALY_LOCK } from "../lib/operationalLocks.js";
import { sendPushToUser } from "./push.js";
import { resolveUnlimitedDayVerification } from "../lib/unlimitedChallengeJobs.js";
import {
  beginWalkRedisRehydration,
  completeWalkRedisRehydration,
  getWalkDirtyHealth,
  seedWalkDayFromPostgres,
  switchWalkAuthorityToPostgres,
  syncWalkIngestControlFromPostgres,
} from "../lib/walkRedisIngest.js";

const router = Router();

router.use("/admin", requireAuth, requireAdminRole);

const walkAuthorityReasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });
const walkSeedSchema = z.object({
  epoch: z.number().int().positive(),
  days: z.array(z.object({ userId: z.string().min(1), localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })).max(10_000),
});

router.get("/admin/walk-ingest/control", async (_req, res) => {
  const [control, dirty] = await Promise.all([syncWalkIngestControlFromPostgres(), getWalkDirtyHealth()]);
  return res.json({ control, dirty });
});

router.post("/admin/walk-ingest/postgres", async (req, res) => {
  const parsed = walkAuthorityReasonSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "A reason is required." });
  const epoch = await switchWalkAuthorityToPostgres(parsed.data.reason);
  return res.json({ ok: true, mode: "postgres", epoch });
});

router.post("/admin/walk-ingest/rehydration/begin", async (req, res) => {
  const parsed = walkAuthorityReasonSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "A reason is required." });
  const epoch = await beginWalkRedisRehydration(parsed.data.reason);
  return res.json({ ok: true, mode: "rehydrating", epoch });
});

router.post("/admin/walk-ingest/rehydration/seed", async (req, res) => {
  const parsed = walkSeedSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid rehydration seed." });
  for (const day of parsed.data.days) await seedWalkDayFromPostgres(parsed.data.epoch, day.userId, day.localDate);
  return res.json({ ok: true, seeded: parsed.data.days.length, epoch: parsed.data.epoch });
});

router.post("/admin/walk-ingest/rehydration/complete", async (req, res) => {
  const parsed = walkSeedSchema.extend({ shadow: z.boolean(), reason: z.string().trim().min(3).max(500) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid rehydration completion." });
  await completeWalkRedisRehydration(parsed.data.epoch, parsed.data.shadow, parsed.data.reason, parsed.data.days);
  return res.json({ ok: true, mode: parsed.data.shadow ? "redis_shadow" : "redis", epoch: parsed.data.epoch });
});

const unlimitedDayVerificationSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approve"),
    authoritativeSteps: z.number().int().min(0).max(200_000),
    reason: z.string().trim().min(3).max(500),
  }),
  z.object({
    decision: z.literal("reject"),
    reason: z.string().trim().min(3).max(500),
  }),
]);

// Production-funded Unlimited days stay pending until this authenticated ops boundary supplies
// the authoritative total. The regular mobile step endpoint can never call this path.
router.post("/admin/unlimited-challenges/:challengeId/days/:dayId/verification-resolve", async (req, res) => {
  const parsed = unlimitedDayVerificationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid verification decision", details: parsed.error.issues });
  }

  const result = await resolveUnlimitedDayVerification({
    challengeId: String(req.params.challengeId),
    dayId: String(req.params.dayId),
    decision: parsed.data.decision,
    authoritativeSteps: parsed.data.decision === "approve" ? parsed.data.authoritativeSteps : undefined,
  });
  if (!result.found) return res.status(404).json({ error: "Unlimited challenge day not found" });
  if (!result.resolved && result.status !== "passed" && result.status !== "failed") {
    return res.status(409).json({ error: "Day is not pending verification", status: result.status });
  }

  await writeAuditLog({
    actorUserId: (req as unknown as AuthenticatedRequest).descopeUserId ?? null,
    actorType: "admin",
    action: "unlimited_day.verification_resolved",
    entityType: "unlimited_challenge_day",
    entityId: String(req.params.dayId),
    reason: parsed.data.reason,
    metadata: {
      challengeId: String(req.params.challengeId),
      decision: parsed.data.decision,
      authoritativeSteps: result.authoritativeSteps ?? null,
      status: result.status ?? null,
      alreadyResolved: !result.resolved,
    },
  });

  return res.json({ ok: true, ...result });
});

function redactGiftCardAward<T extends { fulfillmentCode?: string | null }>(award: T): Omit<T, "fulfillmentCode"> & { hasFulfillmentCode: boolean } {
  const { fulfillmentCode, ...safeAward } = award;
  return {
    ...safeAward,
    hasFulfillmentCode: Boolean(fulfillmentCode),
  };
}

// ── Sponsored Gift Card Fulfillment ───────────────────────────────────────────
const giftCardAwardStatusSchema = z.enum(["pending_fulfillment", "fulfilled", "cancelled", "all"]).default("pending_fulfillment");

router.get("/admin/sponsored-gift-card-awards", async (req, res) => {
  const parsedStatus = giftCardAwardStatusSchema.safeParse(req.query.status ?? "pending_fulfillment");
  if (!parsedStatus.success) return res.status(400).json({ error: "Invalid status" });

  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const status = parsedStatus.data;

  const query = db
    .select({
      award: sponsoredGiftCardAwardsTable,
      userEmail: profilesTable.email,
      username: profilesTable.username,
      raceTitle: raceRoomsTable.title,
      raceStatus: raceRoomsTable.status,
      raceCompletedAt: raceRoomsTable.completedAt,
    })
    .from(sponsoredGiftCardAwardsTable)
    .innerJoin(profilesTable, eq(sponsoredGiftCardAwardsTable.userId, profilesTable.id))
    .innerJoin(raceRoomsTable, eq(sponsoredGiftCardAwardsTable.raceRoomId, raceRoomsTable.id))
    .$dynamic();

  const rows = await (status === "all"
    ? query
    : query.where(eq(sponsoredGiftCardAwardsTable.status, status)))
    .orderBy(desc(sponsoredGiftCardAwardsTable.createdAt))
    .limit(limit)
    .offset(offset);

  return res.json({
    awards: rows.map((row) => ({
      ...redactGiftCardAward(row.award),
      userEmail: row.userEmail,
      username: row.username,
      raceTitle: row.raceTitle,
      raceStatus: row.raceStatus,
      raceCompletedAt: row.raceCompletedAt,
    })),
  });
});

router.get("/admin/sponsored-gift-card-awards/:id", async (req, res) => {
  const awardId = String(req.params.id);
  const [row] = await db
    .select({
      award: sponsoredGiftCardAwardsTable,
      userEmail: profilesTable.email,
      username: profilesTable.username,
      raceTitle: raceRoomsTable.title,
    })
    .from(sponsoredGiftCardAwardsTable)
    .innerJoin(profilesTable, eq(sponsoredGiftCardAwardsTable.userId, profilesTable.id))
    .innerJoin(raceRoomsTable, eq(sponsoredGiftCardAwardsTable.raceRoomId, raceRoomsTable.id))
    .where(eq(sponsoredGiftCardAwardsTable.id, awardId))
    .limit(1);

  if (!row) return res.status(404).json({ error: "Gift card award not found" });
  return res.json({
    award: {
      ...redactGiftCardAward(row.award),
      userEmail: row.userEmail,
      username: row.username,
      raceTitle: row.raceTitle,
    },
  });
});

const fulfillGiftCardAwardSchema = z.object({
  fulfillmentReference: z.string().trim().min(1).max(200).optional(),
  fulfillmentCode: z.string().trim().min(1).max(500).optional(),
  fulfillmentNotes: z.string().trim().max(1000).optional(),
  recipientEmail: z.string().trim().email().optional(),
}).refine((value) => Boolean(value.fulfillmentReference || value.fulfillmentCode), {
  message: "fulfillmentReference or fulfillmentCode is required",
});

router.post("/admin/sponsored-gift-card-awards/:id/fulfill", async (req, res) => {
  const awardId = String(req.params.id);
  const parsed = fulfillGiftCardAwardSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });

  const adminUserId = (req as unknown as AuthenticatedRequest).descopeUserId ?? null;
  const fulfilledAt = new Date();
  const [award] = await db
    .update(sponsoredGiftCardAwardsTable)
    .set({
      status: "fulfilled",
      ...(parsed.data.recipientEmail ? { recipientEmail: parsed.data.recipientEmail } : {}),
      fulfillmentReference: parsed.data.fulfillmentReference,
      fulfillmentCode: parsed.data.fulfillmentCode,
      fulfillmentNotes: parsed.data.fulfillmentNotes,
      fulfilledBy: adminUserId,
      fulfilledAt,
      updatedAt: fulfilledAt,
    })
    .where(and(
      eq(sponsoredGiftCardAwardsTable.id, awardId),
      eq(sponsoredGiftCardAwardsTable.status, "pending_fulfillment"),
    ))
    .returning();

  if (!award) {
    const [existing] = await db
      .select()
      .from(sponsoredGiftCardAwardsTable)
      .where(eq(sponsoredGiftCardAwardsTable.id, awardId))
      .limit(1);
    if (!existing) return res.status(404).json({ error: "Gift card award not found" });
    return res.status(409).json({ error: `Gift card award is already ${existing.status}` });
  }

  await db.insert(notificationsTable).values({
    userId: award.userId,
    type: "reward_approved",
    title: "Gift card sent",
    body: "Your sponsored event gift card has been fulfilled. Please check your email.",
    data: {
      type: "sponsored_gift_card_fulfilled",
      awardId: award.id,
      raceRoomId: award.raceRoomId,
      prizeAmountCents: award.prizeAmountCents,
      provider: award.provider,
    },
  });

  void sendPushToUser(
    award.userId,
    "Gift card sent",
    "Your sponsored event gift card has been fulfilled. Please check your email.",
    {
      type: "sponsored_gift_card_fulfilled",
      award_id: award.id,
      race_room_id: award.raceRoomId,
    },
    { category: "reward", dedupeKey: `sponsored_gift_card_fulfilled:${award.id}` },
  );

  logger.info({
    awardId: award.id,
    raceRoomId: award.raceRoomId,
    userId: award.userId,
    hasFulfillmentCode: Boolean(award.fulfillmentCode),
  }, "Admin: sponsored gift card fulfilled");

  void writeAuditLog({
    actorUserId: adminUserId,
    actorType: "admin",
    action: "admin.sponsored_gift_card.fulfill",
    entityType: "sponsored_gift_card_award",
    entityId: award.id,
    metadata: {
      raceRoomId: award.raceRoomId,
      userId: award.userId,
      prizeAmountCents: award.prizeAmountCents,
      hasFulfillmentCode: Boolean(award.fulfillmentCode),
    },
  });

  return res.json({ award: redactGiftCardAward(award) });
});

const cancelGiftCardAwardSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

router.post("/admin/sponsored-gift-card-awards/:id/cancel", async (req, res) => {
  const awardId = String(req.params.id);
  const parsed = cancelGiftCardAwardSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "reason is required" });

  const adminUserId = (req as unknown as AuthenticatedRequest).descopeUserId ?? null;
  const cancelledAt = new Date();
  const [award] = await db
    .update(sponsoredGiftCardAwardsTable)
    .set({
      status: "cancelled",
      cancelledBy: adminUserId,
      cancelledAt,
      cancelReason: parsed.data.reason,
      updatedAt: cancelledAt,
    })
    .where(and(
      eq(sponsoredGiftCardAwardsTable.id, awardId),
      eq(sponsoredGiftCardAwardsTable.status, "pending_fulfillment"),
    ))
    .returning();

  if (!award) {
    const [existing] = await db
      .select()
      .from(sponsoredGiftCardAwardsTable)
      .where(eq(sponsoredGiftCardAwardsTable.id, awardId))
      .limit(1);
    if (!existing) return res.status(404).json({ error: "Gift card award not found" });
    return res.status(409).json({ error: `Gift card award is already ${existing.status}` });
  }

  logger.info({ awardId: award.id, raceRoomId: award.raceRoomId, userId: award.userId }, "Admin: sponsored gift card cancelled");
  void writeAuditLog({
    actorUserId: adminUserId,
    actorType: "admin",
    action: "admin.sponsored_gift_card.cancel",
    entityType: "sponsored_gift_card_award",
    entityId: award.id,
    reason: parsed.data.reason,
    metadata: { raceRoomId: award.raceRoomId, userId: award.userId },
  });

  return res.json({ award: redactGiftCardAward(award) });
});

// ── Operational Locks ────────────────────────────────────────────────────────
router.get("/admin/operational-locks", async (_req, res) => {
  const locks = await db
    .select()
    .from(operationalLocksTable)
    .orderBy(desc(operationalLocksTable.updatedAt));
  return res.json({ locks });
});

const resolveOperationalLockSchema = z.object({
  reason: z.string().min(5).max(500),
});

router.post("/admin/operational-locks/:key/resolve", async (req, res) => {
  const key = String(req.params.key);
  const parsed = resolveOperationalLockSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "reason is required" });

  const [lock] = await db
    .select()
    .from(operationalLocksTable)
    .where(eq(operationalLocksTable.key, key))
    .limit(1);

  if (!lock) return res.status(404).json({ error: "Operational lock not found" });
  if (!lock.locked) return res.status(409).json({ error: "Operational lock is not active" });

  await setOperationalLock({
    key,
    locked: false,
    reason: parsed.data.reason,
    metadata: {
      previousReason: lock.reason,
      previousMetadata: lock.metadata,
      resolvedByAdminUserId: (req as unknown as AuthenticatedRequest).descopeUserId ?? null,
    },
  });

  void writeAuditLog({
    actorUserId: (req as unknown as AuthenticatedRequest).descopeUserId ?? null,
    actorType: "admin",
    action: "admin.operational_lock.resolve",
    entityType: "operational_lock",
    entityId: key,
    reason: parsed.data.reason,
    metadata: { previousReason: lock.reason, previousMetadata: lock.metadata },
  });

  return res.json({ ok: true });
});

// ── Refund Administration ────────────────────────────────────────────────────
router.get("/admin/refunds", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const refunds = await listRefunds({ status, limit, offset });
  return res.json({ refunds });
});

router.get("/admin/refunds/:id", async (req, res) => {
  const refund = await getRefund(String(req.params.id));
  if (!refund) return res.status(404).json({ error: "Refund not found" });
  return res.json({ refund });
});

const approveRefundSchema = z.object({
  approvedItems: z.array(z.object({
    refundItemId: z.string().uuid(),
    approvedAmount: z.number().int().positive().optional(),
    rejectReason: z.string().min(3).max(500).optional(),
  })).optional(),
});

router.post("/admin/refunds/:id/approve", async (req, res) => {
  const parsed = approveRefundSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  try {
    const refund = await approveRefund({
      refundId: String(req.params.id),
      adminUserId: (req as unknown as AuthenticatedRequest).descopeUserId,
      approvedItems: parsed.data.approvedItems,
    });
    return res.json({ refund });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Approval failed";
    if (message === "REFUND_NOT_FOUND") return res.status(404).json({ error: "Refund not found" });
    return res.status(400).json({ error: message });
  }
});

const rejectRefundSchema = z.object({ reason: z.string().min(3).max(500) });

router.post("/admin/refunds/:id/reject", async (req, res) => {
  const parsed = rejectRefundSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "reason is required" });
  try {
    const refund = await rejectRefund({
      refundId: String(req.params.id),
      adminUserId: (req as unknown as AuthenticatedRequest).descopeUserId,
      reason: parsed.data.reason,
    });
    return res.json({ refund });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Rejection failed";
    if (message === "REFUND_NOT_FOUND") return res.status(404).json({ error: "Refund not found" });
    return res.status(400).json({ error: message });
  }
});

router.get("/admin/refund-batches/:id", async (req, res) => {
  const batch = await getRefundBatch(String(req.params.id));
  if (!batch) return res.status(404).json({ error: "Refund batch not found" });
  return res.json({ batch });
});

// ── GET /api/admin/stats ──────────────────────────────────────────────────────
router.get("/admin/stats", async (_req, res) => {
  const [users, activeRaces, pendingWithdrawals] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(profilesTable),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(raceRoomsTable)
      .where(eq(raceRoomsTable.status, "in_progress")),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(withdrawalsTable)
      .where(eq(withdrawalsTable.status, "pending")),
  ]);
  return res.json({
    totalUsers: users[0]?.count ?? 0,
    activeRaces: activeRaces[0]?.count ?? 0,
    pendingWithdrawals: pendingWithdrawals[0]?.count ?? 0,
  });
});

// ── GET /api/admin/users ──────────────────────────────────────────────────────
router.get("/admin/users", async (req, res) => {
  const q = (req.query.q as string) || "";
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const rows = await db
    .select({
      id: profilesTable.id,
      username: profilesTable.username,
      email: profilesTable.email,
      countryFlag: profilesTable.countryFlag,
      accountStatus: profilesTable.accountStatus,
      createdAt: profilesTable.createdAt,
    })
    .from(profilesTable)
    .where(
      q
        ? or(
            ilike(profilesTable.username, `%${q}%`),
            ilike(profilesTable.email ?? "", `%${q}%`),
          )
        : undefined,
    )
    .orderBy(desc(profilesTable.createdAt))
    .limit(limit)
    .offset(offset);

  return res.json({ users: rows });
});

// ── GET /api/admin/users/:id ──────────────────────────────────────────────────
router.get("/admin/users/:id", async (req, res) => {
  const userId = String(req.params.id);
  const [profile] = await db
    .select()
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);
  if (!profile) return res.status(404).json({ error: "User not found" });

  const [wallet] = await db
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.userId, userId))
    .limit(1);

  const recentTxs = await db
    .select()
    .from(walletTransactionsTable)
    .where(eq(walletTransactionsTable.userId, userId))
    .orderBy(desc(walletTransactionsTable.createdAt))
    .limit(10);

  return res.json({ profile, wallet: wallet ?? null, recentTransactions: recentTxs });
});

// Side effects of restricting an account (ban/suspend) — audit 2026-08-17 H4. A status flip alone
// left the user racing on live sessions and eligible to win real money. Revoke every session so no
// device outlives the restriction, and (for a ban) disqualify their live/pending race entries so
// settlement never pays a banned account. requireActiveAccount additionally blocks step submission.
async function enforceAccountRestriction(
  userId: string,
  restrictionReason: string,
  opts: { disqualifyRaces: boolean },
): Promise<void> {
  await cacheAccountStatus(userId, opts.disqualifyRaces ? "banned" : "suspended");
  const activeSessions = await db
    .select({ sessionId: authSessionsTable.sessionId })
    .from(authSessionsTable)
    .where(and(eq(authSessionsTable.userId, userId), eq(authSessionsTable.status, "active")));
  for (const s of activeSessions) {
    await revokeSession(s.sessionId, userId, restrictionReason).catch((err) =>
      logger.warn({ err, userId }, "revokeSession during account restriction failed"),
    );
  }
  try {
    await getDescopeClient().management.user.logoutUserByUserId(userId);
  } catch (err) {
    logger.warn({ err, userId }, "descope logout during account restriction failed");
  }

  if (opts.disqualifyRaces) {
    // Disqualify (forfeit) live/pending participations so the banned user is excluded from
    // winner selection — settlement already skips "disqualified". Entry stays in the pool.
    await db
      .update(raceParticipantsTable)
      .set({ status: "disqualified" })
      .where(and(
        eq(raceParticipantsTable.userId, userId),
        inArray(raceParticipantsTable.status, ["joined", "active"]),
        inArray(
          raceParticipantsTable.raceRoomId,
          db
            .select({ id: raceRoomsTable.id })
            .from(raceRoomsTable)
            .where(inArray(raceRoomsTable.status, ["open", "full", "starting", "in_progress"])),
        ),
      ));
    // Drop pending scheduled registrations so a banned user is not materialized at start.
    await db
      .update(scheduledRoomRegistrationsTable)
      .set({ status: "cancelled" })
      .where(and(
        eq(scheduledRoomRegistrationsTable.userId, userId),
        inArray(scheduledRoomRegistrationsTable.status, ["registered", "activated"]),
      ));
  }
}

// ── POST /api/admin/users/:id/ban ─────────────────────────────────────────────
const banSchema = z.object({ reason: z.string().min(3).max(500) });

router.post("/admin/users/:id/ban", async (req, res) => {
  const userId = String(req.params.id);
  const parsed = banSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "reason is required" });

  await db
    .update(profilesTable)
    .set({ accountStatus: "banned" })
    .where(eq(profilesTable.id, userId));

  await enforceAccountRestriction(userId, "account_banned", { disqualifyRaces: true });

  logger.info({ userId, reason: parsed.data.reason }, "Admin: user banned");
  void writeAuditLog({
    actorUserId: (req as unknown as AuthenticatedRequest).descopeUserId ?? null,
    actorType: "admin",
    action: "admin.user.ban",
    entityType: "user",
    entityId: userId,
    reason: parsed.data.reason,
  });
  return res.json({ ok: true, status: "banned" });
});

// ── POST /api/admin/users/:id/suspend ────────────────────────────────────────
const suspendSchema = z.object({
  reason: z.string().min(3).max(500),
  durationHours: z.number().int().min(1).max(720).optional().default(24),
});

router.post("/admin/users/:id/suspend", async (req, res) => {
  const userId = String(req.params.id);
  const parsed = suspendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "reason is required" });

  await db
    .update(profilesTable)
    .set({ accountStatus: "suspended" })
    .where(eq(profilesTable.id, userId));

  // Suspension is temporary — revoke sessions so the user cannot act while suspended, but keep
  // their race entries (requireActiveAccount blocks step submission, so they cannot progress).
  await enforceAccountRestriction(userId, "account_suspended", { disqualifyRaces: false });

  logger.info({ userId, reason: parsed.data.reason, durationHours: parsed.data.durationHours }, "Admin: user suspended");
  void writeAuditLog({
    actorUserId: (req as unknown as AuthenticatedRequest).descopeUserId ?? null,
    actorType: "admin",
    action: "admin.user.suspend",
    entityType: "user",
    entityId: userId,
    reason: parsed.data.reason,
    metadata: { durationHours: parsed.data.durationHours },
  });
  return res.json({ ok: true, status: "suspended" });
});

// ── POST /api/admin/users/:id/reinstate ──────────────────────────────────────
router.post("/admin/users/:id/reinstate", async (req, res) => {
  const userId = String(req.params.id);
  await db
    .update(profilesTable)
    .set({ accountStatus: "active" })
    .where(eq(profilesTable.id, userId));
  await cacheAccountStatus(userId, "active");
  logger.info({ userId }, "Admin: user reinstated");
  void writeAuditLog({
    actorUserId: (req as unknown as AuthenticatedRequest).descopeUserId ?? null,
    actorType: "admin",
    action: "admin.user.reinstate",
    entityType: "user",
    entityId: userId,
  });
  return res.json({ ok: true, status: "active" });
});

// ── GET /api/admin/races ──────────────────────────────────────────────────────
router.get("/admin/races", async (req, res) => {
  const status = (req.query.status as string) || "all";
  const limit  = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const statusCond =
    status === "all"
      ? undefined
      : eq(raceRoomsTable.status, status as "open" | "in_progress" | "completed" | "cancelled");

  const rows = await db
    .select({
      id: raceRoomsTable.id,
      title: raceRoomsTable.title,
      status: raceRoomsTable.status,
      type: raceRoomsTable.type,
      entryType: raceRoomsTable.entryType,
      entryAmountCents: raceRoomsTable.entryAmountCents,
      currentPlayers: raceRoomsTable.currentPlayers,
      maxPlayers: raceRoomsTable.maxPlayers,
      creatorId: raceRoomsTable.creatorId,
      createdAt: raceRoomsTable.createdAt,
      startedAt: raceRoomsTable.startedAt,
      completedAt: raceRoomsTable.completedAt,
    })
    .from(raceRoomsTable)
    .where(statusCond)
    .orderBy(desc(raceRoomsTable.createdAt))
    .limit(limit)
    .offset(offset);

  return res.json({ races: rows });
});

// ── POST /api/admin/races/:id/cancel ─────────────────────────────────────────
const cancelSchema = z.object({ reason: z.string().min(3).max(500).optional() });

router.post("/admin/races/:id/cancel", async (req, res) => {
  const raceId = String(req.params.id);
  const parsed = cancelSchema.safeParse(req.body);

  const [race] = await db
    .select({ id: raceRoomsTable.id, status: raceRoomsTable.status })
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.id, raceId))
    .limit(1);

  if (!race) return res.status(404).json({ error: "Race not found" });
  if (race.status === "completed" || race.status === "cancelled") {
    return res.status(409).json({ error: `Race already ${race.status}` });
  }

  await db
    .update(raceRoomsTable)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(eq(raceRoomsTable.id, raceId));

  logger.info({ raceId, reason: parsed.success ? parsed.data.reason : undefined }, "Admin: race cancelled");
  void writeAuditLog({
    actorUserId: (req as unknown as AuthenticatedRequest).descopeUserId ?? null,
    actorType: "admin",
    action: "admin.race.cancel",
    entityType: "race",
    entityId: raceId,
    reason: parsed.success ? parsed.data.reason : null,
  });
  return res.json({ ok: true });
});

// ── GET /api/admin/withdrawals ────────────────────────────────────────────────
router.get("/admin/withdrawals", requireCashFeaturesEnabled, async (req, res) => {
  const status = (req.query.status as string) || "pending";
  const limit  = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const rows = await db
    .select()
    .from(withdrawalsTable)
    .where(eq(withdrawalsTable.status, status as "pending" | "approved" | "rejected" | "cancelled" | "paid"))
    .orderBy(desc(withdrawalsTable.createdAt))
    .limit(limit)
    .offset(offset);

  return res.json({ withdrawals: rows });
});

// ── POST /api/admin/withdrawals/:id/approve ───────────────────────────────────
router.post("/admin/withdrawals/:id/approve", requireCashFeaturesEnabled, async (req, res) => {
  const withdrawalId = String(req.params.id);

  try {
    await assertOperationalLockOpen(
      WALLET_LEDGER_ANOMALY_LOCK,
      "Withdrawal approvals are paused while wallet ledger reconciliation is under review.",
    );
  } catch (err) {
    if (err instanceof Error && err.name === "OPERATIONAL_LOCK_ACTIVE") {
      return res.status(503).json({
        error: err.message,
        code: "WITHDRAWAL_APPROVALS_PAUSED_LEDGER_REVIEW",
      });
    }
    throw err;
  }

  // Atomic state transition: lock the row, then flip pending -> approved with a
  // compare-and-swap predicate. Two concurrent approvals (double-click, retry,
  // two admins) can no longer both succeed — the second sees rowsAffected === 0
  // and returns 409. Prevents double approval / double payout (TOCTOU).
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(withdrawalsTable)
      .where(eq(withdrawalsTable.id, withdrawalId))
      .limit(1)
      .for("update");

    if (!row) return { status: "not_found" as const };
    if (row.status !== "pending") return { status: "conflict" as const, withdrawal: row };

    const updated = await tx
      .update(withdrawalsTable)
      .set({ status: "approved", updatedAt: new Date() })
      .where(and(eq(withdrawalsTable.id, withdrawalId), eq(withdrawalsTable.status, "pending")))
      .returning({ id: withdrawalsTable.id });

    if (updated.length === 0) return { status: "conflict" as const, withdrawal: row };
    return { status: "approved" as const, withdrawal: row };
  });

  if (result.status === "not_found") return res.status(404).json({ error: "Withdrawal not found" });
  if (result.status === "conflict") {
    return res.status(409).json({ error: `Withdrawal is already ${result.withdrawal.status}` });
  }

  const row = result.withdrawal;

  logger.info({ withdrawalId, userId: row.userId, amountCents: row.amountCents }, "Admin: withdrawal approved");
  void writeAuditLog({
    actorUserId: (req as unknown as AuthenticatedRequest).descopeUserId ?? null,
    actorType: "admin",
    action: "admin.withdrawal.approve",
    entityType: "withdrawal",
    entityId: withdrawalId,
    metadata: { userId: row.userId, amountCents: row.amountCents },
  });
  return res.json({ ok: true });
});

// ── POST /api/admin/withdrawals/:id/reject ────────────────────────────────────
const rejectSchema = z.object({ reason: z.string().min(3).max(500) });

router.post("/admin/withdrawals/:id/reject", requireCashFeaturesEnabled, async (req, res) => {
  const withdrawalId = String(req.params.id);
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "reason is required" });

  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(withdrawalsTable)
      .where(eq(withdrawalsTable.id, withdrawalId))
      .limit(1)
      .for("update");

    if (!row) return { status: "not_found" as const };
    if (row.status !== "pending") return { status: "conflict" as const, withdrawal: row };

    const [wallet] = await tx
      .select()
      .from(walletsTable)
      .where(eq(walletsTable.userId, row.userId))
      .limit(1)
      .for("update");

    if (!wallet) return { status: "wallet_not_found" as const, withdrawal: row };

    const beforeAvailable = wallet.availableBalanceCents;
    const afterAvailable = beforeAvailable + row.amountCents;

    await tx
      .update(withdrawalsTable)
      .set({
        status: "rejected",
        rejectedAt: new Date(),
        reviewedAt: new Date(),
        reviewedBy: (req as unknown as AuthenticatedRequest).descopeUserId ?? null,
        reviewNotes: parsed.data.reason,
        updatedAt: new Date(),
      })
      .where(eq(withdrawalsTable.id, withdrawalId));

    await tx
      .update(walletsTable)
      .set({
        availableBalanceCents: afterAvailable,
        // Mirror withdrawable to available (any cleared balance is withdrawable).
        withdrawableBalanceCents: afterAvailable,
        updatedAt: new Date(),
      })
      .where(eq(walletsTable.id, wallet.id));

    await tx
      .update(walletTransactionsTable)
      .set({
        status: "cancelled",
        metadata: sql`coalesce(${walletTransactionsTable.metadata}, '{}'::jsonb) || ${JSON.stringify({
          withdrawalRejectedAt: new Date().toISOString(),
          rejectionReason: parsed.data.reason,
        })}::jsonb`,
      })
      .where(and(
        eq(walletTransactionsTable.withdrawalId, withdrawalId),
        eq(walletTransactionsTable.transactionType, "withdrawal_requested"),
      ));

    await tx
      .insert(walletTransactionsTable)
      .values({
        walletId: wallet.id,
        userId: row.userId,
        transactionType: "withdrawal_rejected",
        amountCents: row.amountCents,
        currency: wallet.currency,
        status: "completed",
        description: `Withdrawal rejected - funds restored`,
        withdrawalId,
        idempotencyKey: `withdrawal_rejected:${withdrawalId}`,
        balanceBeforeCents: beforeAvailable,
        balanceAfterCents: afterAvailable,
        metadata: {
          reason: parsed.data.reason,
        },
      })
      .onConflictDoNothing();

    return { status: "rejected" as const, withdrawal: row };
  });

  if (result.status === "not_found") return res.status(404).json({ error: "Withdrawal not found" });
  if (result.status === "wallet_not_found") return res.status(409).json({ error: "Wallet not found for withdrawal." });
  if (result.status === "conflict") return res.status(409).json({ error: `Withdrawal is already ${result.withdrawal.status}` });

  const row = result.withdrawal;

  logger.info({ withdrawalId, userId: row.userId, reason: parsed.data.reason }, "Admin: withdrawal rejected");
  void writeAuditLog({
    actorUserId: (req as unknown as AuthenticatedRequest).descopeUserId ?? null,
    actorType: "admin",
    action: "admin.withdrawal.reject",
    entityType: "withdrawal",
    entityId: withdrawalId,
    reason: parsed.data.reason,
    metadata: { userId: row.userId, amountCents: row.amountCents },
  });
  return res.json({ ok: true });
});

// ── POST /api/admin/unlimited-challenges/cancel-all ───────────────────────────
// Platform cancel every open Unlimited Challenge and refund entry contributions.
router.post("/admin/unlimited-challenges/cancel-all", async (req, res) => {
  const adminUserId = (req as unknown as AuthenticatedRequest).descopeUserId;
  const reason =
    typeof req.body?.reason === "string" && req.body.reason.trim()
      ? req.body.reason.trim()
      : "platform_cancelled_all";

  const { cancelAllOpenUnlimitedChallenges } = await import("../lib/unlimitedChallengeService.js");
  const result = await cancelAllOpenUnlimitedChallenges({
    reason,
    actorUserId: adminUserId,
  });

  void writeAuditLog({
    actorUserId: adminUserId ?? null,
    actorType: "admin",
    action: "admin.unlimited_challenge.cancel_all",
    entityType: "unlimited_challenge",
    entityId: null,
    reason,
    metadata: {
      cancelled: result.cancelled,
      skippedTerminal: result.skippedTerminal,
    },
  });

  logger.info(
    { cancelled: result.cancelled, skippedTerminal: result.skippedTerminal, reason },
    "Admin: cancelled all open unlimited challenges",
  );

  return res.json({
    ok: true,
    cancelled: result.cancelled,
    skippedTerminal: result.skippedTerminal,
    results: result.results.map((r) => ({
      challengeId: r.challengeId,
      ok: r.ok,
      alreadyTerminal: r.alreadyTerminal ?? false,
      refundedCount: r.refundedUserIds.length,
      failedRefundCount: r.failedRefundUserIds.length,
    })),
  });
});

// ── POST /api/admin/unlimited-challenges/:id/cancel ───────────────────────────
router.post("/admin/unlimited-challenges/:id/cancel", async (req, res) => {
  const adminUserId = (req as unknown as AuthenticatedRequest).descopeUserId;
  const challengeId = String(req.params.id);
  const reason =
    typeof req.body?.reason === "string" && req.body.reason.trim()
      ? req.body.reason.trim()
      : "platform_cancelled";

  const { cancelUnlimitedChallengeByPlatform } = await import("../lib/unlimitedChallengeService.js");
  const result = await cancelUnlimitedChallengeByPlatform(challengeId, {
    reason,
    actorUserId: adminUserId,
  });

  if (!result.ok && result.refundedUserIds.length === 0 && !result.alreadyTerminal) {
    return res.status(404).json({ error: "Challenge not found." });
  }

  void writeAuditLog({
    actorUserId: adminUserId ?? null,
    actorType: "admin",
    action: "admin.unlimited_challenge.cancel",
    entityType: "unlimited_challenge",
    entityId: challengeId,
    reason,
    metadata: {
      alreadyTerminal: result.alreadyTerminal ?? false,
      refundedCount: result.refundedUserIds.length,
      failedRefundCount: result.failedRefundUserIds.length,
    },
  });

  return res.json({
    ok: true,
    challengeId,
    alreadyTerminal: result.alreadyTerminal ?? false,
    refundedCount: result.refundedUserIds.length,
    failedRefundCount: result.failedRefundUserIds.length,
  });
});

export default router;
