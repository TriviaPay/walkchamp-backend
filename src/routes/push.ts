import { Router } from "express";
import { db } from "../../db/src/index.js";
import {
  notificationDevicesTable,
  userNotificationPreferencesTable,
  pushNotificationLogsTable,
} from "../../db/src/schema/index.js";
import { eq } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import { requireAdminKey } from "../middleware/requireAdminKey.js";
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
export type PushCategory = "chat" | "invite" | "race" | "reward";

export interface PushSendOptions {
  url?: string;
  category?: PushCategory;
  dedupeKey?: string;
}

async function isPushAllowedForUser(userId: string, category?: PushCategory): Promise<boolean> {
  const [prefs] = await db
    .select({
      pushNotificationsEnabled: userNotificationPreferencesTable.pushNotificationsEnabled,
      raceUpdatesEnabled: userNotificationPreferencesTable.raceUpdatesEnabled,
      inviteUpdatesEnabled: userNotificationPreferencesTable.inviteUpdatesEnabled,
      rewardUpdatesEnabled: userNotificationPreferencesTable.rewardUpdatesEnabled,
      chatUpdatesEnabled: userNotificationPreferencesTable.chatUpdatesEnabled,
    })
    .from(userNotificationPreferencesTable)
    .where(eq(userNotificationPreferencesTable.userId, userId))
    .limit(1);

  if (prefs && !prefs.pushNotificationsEnabled) return false;
  if (!category || !prefs) return true;

  switch (category) {
    case "chat":
      return prefs.chatUpdatesEnabled;
    case "invite":
      return prefs.inviteUpdatesEnabled;
    case "race":
      return prefs.raceUpdatesEnabled;
    case "reward":
      return prefs.rewardUpdatesEnabled;
    default:
      return true;
  }
}

export async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
  options?: PushSendOptions,
): Promise<string> {
  const oneSignalKey = process.env.ONESIGNAL_REST_API_KEY;
  const oneSignalAppId = process.env.ONESIGNAL_APP_ID;

  if (!oneSignalKey || !oneSignalAppId) return "skipped_no_config";

  const notificationType = String(data?.type ?? "notification");

  if (!(await isPushAllowedForUser(userId, options?.category))) {
    await db.insert(pushNotificationLogsTable).values({
      userId,
      notificationType,
      title,
      body,
      data: { ...(data ?? {}), dedupeKey: options?.dedupeKey },
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
        data: { ...(data ?? {}), dedupeKey: options?.dedupeKey },
        ...(options?.url ? { url: options.url } : {}),
      }),
    }) as {
      ok: boolean;
      json(): Promise<unknown>;
    };
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
    data: { ...(data ?? {}), dedupeKey: options?.dedupeKey },
    onesignalResponse,
    status,
  });

  return status;
}

/** Batch send to multiple users via OneSignal external_id aliases (max 2000 per call). */
export async function sendPushToUsers(
  userIds: string[],
  title: string,
  body: string,
  data?: Record<string, unknown>,
  options?: PushSendOptions,
): Promise<void> {
  const oneSignalKey = process.env.ONESIGNAL_REST_API_KEY;
  const oneSignalAppId = process.env.ONESIGNAL_APP_ID;
  if (!oneSignalKey || !oneSignalAppId) return;

  const notificationType = String(data?.type ?? "notification");
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return;

  const eligible: string[] = [];
  for (const uid of unique) {
    if (await isPushAllowedForUser(uid, options?.category)) eligible.push(uid);
  }
  if (eligible.length === 0) return;

  const payloadData = { ...(data ?? {}), dedupeKey: options?.dedupeKey };
  const BATCH = 2000;

  for (let i = 0; i < eligible.length; i += BATCH) {
    const batch = eligible.slice(i, i + BATCH);
    let status: "sent" | "failed" = "sent";
    let onesignalResponse: Record<string, unknown> | undefined;

    try {
      const resp = await fetch("https://onesignal.com/api/v1/notifications", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${oneSignalKey}`,
        },
        body: JSON.stringify({
          app_id: oneSignalAppId,
          include_aliases: { external_id: batch },
          target_channel: "push",
          headings: { en: title },
          contents: { en: body },
          data: payloadData,
          ...(options?.url ? { url: options.url } : {}),
        }),
      }) as {
        ok: boolean;
        json(): Promise<unknown>;
      };
      onesignalResponse = (await resp.json()) as Record<string, unknown>;
      if (!resp.ok || onesignalResponse?.errors) status = "failed";
    } catch {
      status = "failed";
    }

    await Promise.all(
      batch.map((userId) =>
        db.insert(pushNotificationLogsTable).values({
          userId,
          notificationType,
          title,
          body,
          data: payloadData,
          onesignalResponse,
          status,
        }),
      ),
    );
  }
}

export default router;
