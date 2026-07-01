import { Router } from "express";
import { db } from "@db";
import {
  profilesTable,
  raceRoomsTable,
  raceParticipantsTable,
  walletsTable,
  walletTransactionsTable,
  withdrawalsTable,
  notificationsTable,
} from "@db/schema";
import { eq, and, desc, ilike, or, sql, inArray } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import { requireAdminRole } from "../middleware/requireAdminRole.js";
import { requireCashFeaturesEnabled } from "../middleware/requireCashFeaturesEnabled.js";
import { writeAuditLog } from "../lib/auditLog.js";

const router = Router();

router.use("/admin", requireAuth, requireAdminRole);

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

  const [row] = await db
    .select()
    .from(withdrawalsTable)
    .where(eq(withdrawalsTable.id, withdrawalId))
    .limit(1);

  if (!row) return res.status(404).json({ error: "Withdrawal not found" });
  if (row.status !== "pending") return res.status(409).json({ error: `Withdrawal is already ${row.status}` });

  await db
    .update(withdrawalsTable)
    .set({ status: "approved", updatedAt: new Date() })
    .where(eq(withdrawalsTable.id, withdrawalId));

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

  const [row] = await db
    .select()
    .from(withdrawalsTable)
    .where(eq(withdrawalsTable.id, withdrawalId))
    .limit(1);

  if (!row) return res.status(404).json({ error: "Withdrawal not found" });
  if (row.status !== "pending") return res.status(409).json({ error: `Withdrawal is already ${row.status}` });

  await db
    .update(withdrawalsTable)
    .set({ status: "rejected", updatedAt: new Date() })
    .where(eq(withdrawalsTable.id, withdrawalId));

  // Return funds to user wallet (best-effort)
  db.update(walletsTable)
    .set({
      availableBalanceCents: sql`available_balance_cents + ${row.amountCents}`,
      withdrawableBalanceCents: sql`withdrawable_balance_cents + ${row.amountCents}`,
      updatedAt: new Date(),
    })
    .where(eq(walletsTable.userId, row.userId))
    .catch((err) => logger.error({ withdrawalId, err }, "Admin: failed to refund wallet on rejection"));

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

export default router;
