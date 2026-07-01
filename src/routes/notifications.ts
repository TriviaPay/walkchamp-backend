import { Router } from "express";
import { db } from "../../db/src/index.js";
import {
  notificationsTable,
  notificationDevicesTable,
  userNotificationPreferencesTable,
} from "../../db/src/schema/index.js";
import { eq, and, desc, lt } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import { z } from "zod";
import { sendPushToUser } from "./push.js";

const router = Router();

// ── GET /api/notifications ────────────────────────────────────────────────────
// Supports cursor pagination via ?before=<ISO-timestamp> (exclusive upper bound).
router.get("/notifications", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const before = req.query.before as string | undefined;
  const beforeDate = before ? new Date(before) : null;

  const rows = await db
    .select()
    .from(notificationsTable)
    .where(
      beforeDate
        ? and(eq(notificationsTable.userId, userId), lt(notificationsTable.createdAt, beforeDate))
        : eq(notificationsTable.userId, userId),
    )
    .orderBy(desc(notificationsTable.createdAt))
    .limit(limit);

  const unreadCount = rows.filter((r) => !r.isRead).length;
  const nextCursor =
    rows.length === limit && rows.length > 0
      ? rows[rows.length - 1].createdAt.toISOString()
      : null;

  return res.json({
    notifications: rows.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      data: n.data,
      isRead: n.isRead,
      createdAt: n.createdAt.toISOString(),
      readAt: n.readAt?.toISOString() ?? null,
    })),
    unreadCount,
    nextCursor,
  });
});

// ── POST /api/notifications/:id/read ─────────────────────────────────────────
router.post("/notifications/:id/read", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const notifId = String(req.params.id);

  await db
    .update(notificationsTable)
    .set({ isRead: true, readAt: new Date() })
    .where(and(eq(notificationsTable.id, notifId), eq(notificationsTable.userId, userId)));

  return res.json({ ok: true });
});

// ── POST /api/notifications/read-all ─────────────────────────────────────────
router.post("/notifications/read-all", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  await db
    .update(notificationsTable)
    .set({ isRead: true, readAt: new Date() })
    .where(and(eq(notificationsTable.userId, userId), eq(notificationsTable.isRead, false)));

  return res.json({ ok: true });
});

// ── POST /api/notifications/register-device ───────────────────────────────────
const registerSchema = z.object({
  onesignalPlayerId: z.string().min(1),
  platform: z.enum(["ios", "android", "web"]).default("ios"),
  deviceModel: z.string().optional(),
  appVersion: z.string().optional(),
});

router.post("/notifications/register-device", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }

  const { onesignalPlayerId, platform, deviceModel, appVersion } = parsed.data;

  await db
    .insert(notificationDevicesTable)
    .values({
      userId,
      onesignalPlayerId,
      platform,
      deviceModel,
      appVersion,
      active: true,
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [notificationDevicesTable.onesignalPlayerId],
      set: {
        userId,
        platform,
        deviceModel,
        appVersion,
        active: true,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      },
    });

  req.log.info({ userId, onesignalPlayerId }, "device registered");
  return res.json({ ok: true });
});

// ── POST /api/notifications/unregister-device ─────────────────────────────────
const unregisterSchema = z.object({
  onesignalPlayerId: z.string().min(1),
});

router.post("/notifications/unregister-device", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = unregisterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });

  await db
    .update(notificationDevicesTable)
    .set({ active: false, updatedAt: new Date() })
    .where(
      and(
        eq(notificationDevicesTable.userId, userId),
        eq(notificationDevicesTable.onesignalPlayerId, parsed.data.onesignalPlayerId),
      ),
    );

  return res.json({ ok: true });
});

// ── GET /api/me/notification-preferences ──────────────────────────────────────
router.get("/me/notification-preferences", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const [prefs] = await db
    .select()
    .from(userNotificationPreferencesTable)
    .where(eq(userNotificationPreferencesTable.userId, userId))
    .limit(1);

  // Default to enabled if the user hasn't set a preference yet
  return res.json({
    success: true,
    push_notifications_enabled: prefs?.pushNotificationsEnabled ?? true,
  });
});

// ── PATCH /api/me/notification-preferences ────────────────────────────────────
const notifPrefsSchema = z.object({
  push_notifications_enabled: z.boolean(),
});

router.patch("/me/notification-preferences", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = notifPrefsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }

  const { push_notifications_enabled } = parsed.data;

  await db
    .insert(userNotificationPreferencesTable)
    .values({ userId, pushNotificationsEnabled: push_notifications_enabled })
    .onConflictDoUpdate({
      target: [userNotificationPreferencesTable.userId],
      set: {
        pushNotificationsEnabled: push_notifications_enabled,
        updatedAt: new Date(),
      },
    });

  req.log.info({ userId, push_notifications_enabled }, "notification preferences updated");
  return res.json({ success: true, push_notifications_enabled });
});

// ── Helper: send in-app + push notification to a user ─────────────────────────
export async function sendNotification(
  userId: string,
  type: typeof notificationsTable.$inferInsert["type"],
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  // Always store in-app notification
  await db.insert(notificationsTable).values({ userId, type, title, body, data });

  // Delegate push delivery to sendPushToUser (single source of truth for push
  // logic: preference check, external_id targeting, and send logging)
  sendPushToUser(userId, title, body, { type, ...(data ?? {}) }).catch(() => {
    // Push failures must never surface to callers
  });
}

export default router;
