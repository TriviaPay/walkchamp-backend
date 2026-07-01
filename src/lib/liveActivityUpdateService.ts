import { db } from "@db";
import { liveActivityTokensTable, pushNotificationLogsTable } from "@db/schema";
import { and, eq } from "drizzle-orm";
import type { LiveRaceProgressContext } from "./raceLeaderboardService";

const lastUpdateAt = new Map<string, number>();
const MIN_UPDATE_INTERVAL_MS = 30_000;

function throttleKey(raceId: string, userId: string): string {
  return `${raceId}:${userId}`;
}

function shouldThrottle(raceId: string, userId: string): boolean {
  const key = throttleKey(raceId, userId);
  const last = lastUpdateAt.get(key) ?? 0;
  if (Date.now() - last < MIN_UPDATE_INTERVAL_MS) return true;
  lastUpdateAt.set(key, Date.now());
  return false;
}

/** Fire-and-forget iOS Live Activity remote update (throttled). */
export async function triggerLiveActivityUpdate(ctx: LiveRaceProgressContext): Promise<void> {
  if (ctx.raceStatus !== "in_progress") return;
  if (shouldThrottle(ctx.raceId, ctx.userId)) return;

  const [tokenRow] = await db
    .select({
      pushToken: liveActivityTokensTable.pushToken,
      activityId: liveActivityTokensTable.activityId,
    })
    .from(liveActivityTokensTable)
    .where(
      and(
        eq(liveActivityTokensTable.raceId, ctx.raceId),
        eq(liveActivityTokensTable.userId, ctx.userId),
        eq(liveActivityTokensTable.status, "active"),
        eq(liveActivityTokensTable.platform, "ios"),
      ),
    )
    .limit(1);

  if (!tokenRow) return;

  const oneSignalKey = process.env.ONESIGNAL_REST_API_KEY;
  const oneSignalAppId = process.env.ONESIGNAL_APP_ID;
  if (!oneSignalKey || !oneSignalAppId) return;

  const payload = {
    raceId: ctx.raceId,
    username: ctx.username,
    raceSteps: ctx.raceSteps,
    rank: ctx.rank,
    totalParticipants: ctx.totalParticipants,
    goalSteps: ctx.goalSteps,
    timeLeftSeconds: ctx.timeLeftSeconds,
    raceStatus: ctx.raceStatus,
    lastUpdatedAt: ctx.lastSyncedAt,
    deepLink: `walkchamp://race/${ctx.raceId}`,
  };

  let status: "sent" | "failed" = "sent";
  let onesignalResponse: Record<string, unknown> | undefined;

  try {
    // OneSignal Live Activity update — uses external_id + activity payload.
    const resp = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${oneSignalKey}`,
      },
      body: JSON.stringify({
        app_id: oneSignalAppId,
        include_aliases: { external_id: [ctx.userId] },
        target_channel: "push",
        data: { type: "live_activity_race_update", ...payload },
        ios_live_activity: {
          event: "update",
          activity_id: tokenRow.activityId,
          content_state: payload,
        },
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

  await db.insert(pushNotificationLogsTable).values({
    userId: ctx.userId,
    notificationType: "live_activity_race_update",
    title: "Walk Champ Race",
    body: `${ctx.username}: ${ctx.raceSteps} steps`,
    data: { ...payload, activityId: tokenRow.activityId, dedupeKey: `live_activity_update:${ctx.raceId}:${ctx.userId}` },
    onesignalResponse,
    status,
  });
}

export async function endLiveActivityForUser(
  raceId: string,
  userId: string,
  raceStatus: string,
): Promise<void> {
  await db
    .update(liveActivityTokensTable)
    .set({ status: "ended", updatedAt: new Date() })
    .where(
      and(
        eq(liveActivityTokensTable.raceId, raceId),
        eq(liveActivityTokensTable.userId, userId),
        eq(liveActivityTokensTable.status, "active"),
      ),
    );

  lastUpdateAt.delete(throttleKey(raceId, userId));
}
