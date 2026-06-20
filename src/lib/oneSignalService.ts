import { db } from "@db";
import {
  notificationEventsTable,
  pushNotificationLogsTable,
  userNotificationPreferencesTable,
} from "@db/schema";
import { and, eq } from "drizzle-orm";

export type SendOneSignalNotificationInput = {
  recipientUserIds: string[];
  title: string;
  body: string;
  data?: Record<string, unknown>;
  url?: string;
  priority?: number;
  idempotencyKey?: {
    eventType: string;
    entityId: string;
    recipientUserId: string;
  };
  /** When true, also checks inviteUpdatesEnabled preference (friend/group invites). */
  checkInvitePreference?: boolean;
};

export type SendOneSignalResult =
  | { status: "sent"; onesignalNotificationId?: string }
  | { status: "skipped_no_config" }
  | { status: "skipped_disabled" }
  | { status: "skipped_duplicate" }
  | { status: "failed"; error?: string };

async function isPushEnabledForUser(
  userId: string,
  checkInvitePreference: boolean,
): Promise<boolean> {
  const [prefs] = await db
    .select({
      pushNotificationsEnabled: userNotificationPreferencesTable.pushNotificationsEnabled,
      inviteUpdatesEnabled: userNotificationPreferencesTable.inviteUpdatesEnabled,
    })
    .from(userNotificationPreferencesTable)
    .where(eq(userNotificationPreferencesTable.userId, userId))
    .limit(1);

  if (prefs && !prefs.pushNotificationsEnabled) return false;
  if (checkInvitePreference && prefs && !prefs.inviteUpdatesEnabled) return false;
  return true;
}

async function hasDuplicateEvent(key: {
  eventType: string;
  entityId: string;
  recipientUserId: string;
}): Promise<boolean> {
  const [existing] = await db
    .select({ id: notificationEventsTable.id })
    .from(notificationEventsTable)
    .where(
      and(
        eq(notificationEventsTable.eventType, key.eventType),
        eq(notificationEventsTable.entityId, key.entityId),
        eq(notificationEventsTable.recipientUserId, key.recipientUserId),
      ),
    )
    .limit(1);
  return !!existing;
}

async function recordNotificationEvent(
  key: { eventType: string; entityId: string; recipientUserId: string },
  onesignalNotificationId: string | undefined,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(notificationEventsTable)
    .values({
      eventType: key.eventType,
      entityId: key.entityId,
      recipientUserId: key.recipientUserId,
      onesignalNotificationId,
      sentAt: new Date(),
      metadata,
    })
    .onConflictDoNothing();
}

/**
 * Send a targeted push notification via OneSignal REST API.
 * Uses include_aliases.external_id (OneSignal v5) — equivalent to include_external_user_ids.
 * Never uses segments or Total Subscriptions.
 */
export async function sendOneSignalNotification(
  input: SendOneSignalNotificationInput,
): Promise<SendOneSignalResult> {
  const {
    recipientUserIds,
    title,
    body,
    data,
    url,
    priority,
    idempotencyKey,
    checkInvitePreference = false,
  } = input;

  const userIds = recipientUserIds.filter(Boolean);
  if (userIds.length === 0) return { status: "failed", error: "no_recipients" };

  const oneSignalKey = process.env.ONESIGNAL_REST_API_KEY;
  const oneSignalAppId = process.env.ONESIGNAL_APP_ID;
  if (!oneSignalKey || !oneSignalAppId) {
    console.warn("[OneSignal] push skipped — missing ONESIGNAL_APP_ID or ONESIGNAL_REST_API_KEY");
    return { status: "skipped_no_config" };
  }

  const userId = userIds[0];
  const notificationType = String(data?.type ?? "notification");

  if (idempotencyKey) {
    const duplicate = await hasDuplicateEvent(idempotencyKey);
    if (duplicate) {
      console.info("[OneSignal] duplicate push skipped", {
        eventType: idempotencyKey.eventType,
        entityId: idempotencyKey.entityId,
        recipientUserId: idempotencyKey.recipientUserId,
      });
      await db.insert(pushNotificationLogsTable).values({
        userId,
        notificationType,
        title,
        body,
        data,
        status: "skipped_duplicate",
      });
      return { status: "skipped_duplicate" };
    }
  }

  const enabled = await isPushEnabledForUser(userId, checkInvitePreference);
  if (!enabled) {
    console.info("[OneSignal] push skipped — user preference disabled", {
      userId,
      type: notificationType,
      checkInvitePreference,
    });
    await db.insert(pushNotificationLogsTable).values({
      userId,
      notificationType,
      title,
      body,
      data,
      status: "skipped_disabled",
    });
    return { status: "skipped_disabled" };
  }

  console.info("[OneSignal] push send attempt", {
    userId,
    type: notificationType,
    eventType: idempotencyKey?.eventType,
  });

  let status: "sent" | "failed" = "sent";
  let onesignalResponse: Record<string, unknown> | undefined;
  let onesignalNotificationId: string | undefined;

  try {
    const payload: Record<string, unknown> = {
      app_id: oneSignalAppId,
      include_aliases: { external_id: userIds },
      target_channel: "push",
      headings: { en: title },
      contents: { en: body },
      data: data ?? {},
    };
    if (url) payload.url = url;
    if (priority != null) payload.priority = priority;

    const resp = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${oneSignalKey}`,
      },
      body: JSON.stringify(payload),
    });

    onesignalResponse = (await resp.json()) as Record<string, unknown>;
    if (!resp.ok) {
      status = "failed";
      console.error("[OneSignal] push failed", {
        status: resp.status,
        type: notificationType,
        userId,
        response: onesignalResponse,
      });
    } else {
      onesignalNotificationId =
        typeof onesignalResponse.id === "string" ? onesignalResponse.id : undefined;
      console.info("[OneSignal] push sent", {
        type: notificationType,
        userId,
        onesignalNotificationId,
      });
    }
  } catch (err) {
    status = "failed";
    console.error("[OneSignal] push request error", {
      type: notificationType,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
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

  if (status === "sent" && idempotencyKey) {
    await recordNotificationEvent(idempotencyKey, onesignalNotificationId, data);
  }

  if (status === "failed") {
    return { status: "failed", error: "onesignal_request_failed" };
  }
  return { status: "sent", onesignalNotificationId };
}
