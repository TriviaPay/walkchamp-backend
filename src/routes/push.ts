import { Router } from "express";
import { db } from "@db";
import {
  notificationDevicesTable,
  userNotificationPreferencesTable,
  pushNotificationLogsTable,
} from "@db/schema";
import { eq } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth";
import { requireAdminKey } from "../middleware/requireAdminKey";
import { z } from "zod";

const router = Router();

// ── POST /api/push/register-device ───────────────────────────────────────────
// Accepts either onesignalSubscriptionId (v5 SDK) or onesignalPlayerId (v4 legacy)
const registerDeviceSchema = z
  .object({
    onesignalPlayerId: z.string().min(1).optional(),
    onesignalSubscriptionId: z.string().min(1).optional(),
    devicePlatform: z.enum(["ios", "android", "web"]).optional(),
    deviceModel: z.string().optional(),
    appVersion: z.string().optional(),
  })
  .refine((d) => d.onesignalPlayerId ?? d.onesignalSubscriptionId, {
    message: "Either onesignalPlayerId or onesignalSubscriptionId is required",
  });

router.post("/push/register-device", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = registerDeviceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }

  const { onesignalPlayerId, onesignalSubscriptionId, devicePlatform, deviceModel, appVersion } =
    parsed.data;
  // Prefer subscription ID (v5), fall back to player ID (v4 legacy)
  const playerId = onesignalSubscriptionId ?? onesignalPlayerId!;

  await db
    .insert(notificationDevicesTable)
    .values({
      userId,
      onesignalPlayerId: playerId,
      platform: devicePlatform ?? "unknown",
      deviceModel,
      appVersion,
      active: true,
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [notificationDevicesTable.onesignalPlayerId],
      set: {
        userId,
        platform: devicePlatform ?? "unknown",
        deviceModel,
        appVersion,
        active: true,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      },
    });

  req.log.info({ userId, playerId }, "push device registered");
  return res.json({ ok: true });
});

// ── POST /api/push/send (system/internal use only) ───────────────────────────
const sendSchema = z.object({
  userId: z.string().min(1),
  type: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  data: z.record(z.unknown()).optional(),
});

router.post("/push/send", requireAdminKey, async (req, res) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }
  const { userId, type, title, body, data } = parsed.data;
  // Merge type into data so the frontend click-handler can route correctly
  const status = await sendPushToUser(userId, title, body, { type, ...(data ?? {}) });
  req.log.info({ userId, type, status }, "push sent");
  return res.json({ ok: true, status });
});

// ── Core push sending helper (called from other routes) ───────────────────────
// Signature: (userId, title, body, data?)
// Targeting uses OneSignal external_id (set via OneSignal.login(userId)) —
// more reliable than storing subscription IDs, and works even if device
// registration hasn't completed yet.
export async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<string> {
  const oneSignalKey = process.env.ONESIGNAL_REST_API_KEY;
  const oneSignalAppId = process.env.ONESIGNAL_APP_ID;

  if (!oneSignalKey || !oneSignalAppId) return "skipped_no_config";

  const notificationType = String(data?.type ?? "notification");

  // Check user notification preference — default to enabled if no row yet
  const [prefs] = await db
    .select({ pushNotificationsEnabled: userNotificationPreferencesTable.pushNotificationsEnabled })
    .from(userNotificationPreferencesTable)
    .where(eq(userNotificationPreferencesTable.userId, userId))
    .limit(1);

  if (prefs && !prefs.pushNotificationsEnabled) {
    await db.insert(pushNotificationLogsTable).values({
      userId,
      notificationType,
      title,
      body,
      data,
      status: "skipped_disabled",
    });
    return "skipped_disabled";
  }

  let status: "sent" | "failed" = "sent";
  let onesignalResponse: Record<string, unknown> | undefined;

  try {
    // Use include_aliases with external_id (set via OneSignal.login(userId) on
    // the client) — this is the correct v5 approach and removes reliance on
    // stored subscription IDs which may lag behind due to registration race.
    const resp = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${oneSignalKey}`,
      },
      body: JSON.stringify({
        app_id: oneSignalAppId,
        include_aliases: { external_id: [userId] },
        target_channel: "push",
        headings: { en: title },
        contents: { en: body },
        data: data ?? {},
      }),
    });
    onesignalResponse = (await resp.json()) as Record<string, unknown>;
    if (!resp.ok || onesignalResponse?.errors) {
      status = "failed";
    }
  } catch {
    status = "failed";
  }

  await db.insert(pushNotificationLogsTable).values({
    userId,
    notificationType,
    title,
    body,
    data,
    onesignalResponse,
    status,
  });

  return status;
}

export default router;
