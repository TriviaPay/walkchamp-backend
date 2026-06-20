import { sendOneSignalNotification } from "../lib/oneSignalService";
import { Router } from "express";
import { db } from "@db";
import {
  notificationDevicesTable,
} from "@db/schema";
import { eq } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth";
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

router.post("/push/send", requireAuth, async (req, res) => {
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
// Signature: (userId, title, body, data?, url?)
// Targeting uses OneSignal external_id (set via OneSignal.login(userId)) —
// more reliable than storing subscription IDs, and works even if device
// registration hasn't completed yet.
export async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
  url?: string,
): Promise<string> {
  const notificationType = String(data?.type ?? "notification");
  const checkInvitePreference =
    notificationType === "friend_request" ||
    notificationType === "friend_request_received" ||
    notificationType === "friend_request_accepted" ||
    notificationType === "group_invite";

  const result = await sendOneSignalNotification({
    recipientUserIds: [userId],
    title,
    body,
    data,
    url: url ?? (typeof data?.deepLink === "string" ? data.deepLink : undefined),
    checkInvitePreference,
  });

  return result.status;
}

export default router;
