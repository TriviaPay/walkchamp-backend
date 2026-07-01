/**
 * Shared helpers for friend activity notifications.
 * Used by the walk step sync endpoint (daily goal) and the friendActivity route (manual share).
 */

import { db } from "../../db/src/index.js";
import {
  friendsTable,
  blockedUsersTable,
  friendActivityEventsTable,
  profilesTable,
  userPreferencesTable,
} from "../../db/src/schema/index.js";
import { eq, and, inArray, or } from "drizzle-orm";
import { sendNotification } from "../routes/notifications.js";
import { logger } from "./logger.js";

// ── Friend eligibility ────────────────────────────────────────────────────────

/**
 * Returns the list of accepted friend IDs for `senderId`,
 * excluding anyone who has blocked or been blocked by the sender.
 */
export async function getEligibleFriendIds(senderId: string): Promise<string[]> {
  const myFriends = await db
    .select({ friendId: friendsTable.friendId })
    .from(friendsTable)
    .where(eq(friendsTable.userId, senderId));

  if (myFriends.length === 0) return [];

  const allFriendIds = myFriends.map((f) => f.friendId);

  const blockedPairs = await db
    .select({ blockerId: blockedUsersTable.blockerId, blockedId: blockedUsersTable.blockedId })
    .from(blockedUsersTable)
    .where(or(
      and(eq(blockedUsersTable.blockerId, senderId), inArray(blockedUsersTable.blockedId, allFriendIds)),
      and(inArray(blockedUsersTable.blockerId, allFriendIds), eq(blockedUsersTable.blockedId, senderId)),
    ));

  const blockedSet = new Set<string>();
  for (const b of blockedPairs) {
    blockedSet.add(b.blockerId === senderId ? b.blockedId : b.blockerId);
  }

  return allFriendIds.filter((id) => !blockedSet.has(id));
}

// ── Daily goal completion notification ───────────────────────────────────────

/**
 * Send daily goal completion push + in-app notifications to eligible friends.
 *
 * De-duplicated via the `friend_activity_events` unique partial index on
 * (user_id, event_type, event_date) WHERE event_type = 'daily_goal_completed'.
 *
 * Fire-and-forget safe — never throws.
 */
export async function notifyFriendsOnDailyGoal(
  userId: string,
  currentSteps: number,
  goalSteps: number,
  today: string,
): Promise<void> {
  try {
    logger.info({ userId, today }, "[DailyGoalNotify] checking if already sent");

    // Check for existing record — prevents duplicate sends before the insert
    const [existing] = await db
      .select({ id: friendActivityEventsTable.id })
      .from(friendActivityEventsTable)
      .where(and(
        eq(friendActivityEventsTable.userId, userId),
        eq(friendActivityEventsTable.eventType, "daily_goal_completed"),
        eq(friendActivityEventsTable.eventDate, today),
      ))
      .limit(1);

    if (existing) {
      logger.info({ userId, today }, "[DailyGoalNotify] already sent — skipping");
      return;
    }

    logger.info({ userId }, "[DailyGoalNotify] fetching eligible friends");
    const eligibleIds = await getEligibleFriendIds(userId);
    logger.info({ userId, eligibleFriends: eligibleIds.length }, "[DailyGoalNotify] eligible friends");

    if (eligibleIds.length === 0) return;

    const [senderProfile] = await db
      .select({ username: profilesTable.username })
      .from(profilesTable)
      .where(eq(profilesTable.id, userId))
      .limit(1);
    const username = senderProfile?.username ?? "A friend";

    // Insert event record first — unique index prevents duplicate sends under
    // concurrent step-sync requests (race condition guard).
    try {
      await db.insert(friendActivityEventsTable).values({
        userId,
        eventType: "daily_goal_completed",
        eventDate: today,
        stepCount: currentSteps,
        goalSteps,
        notifiedCount: eligibleIds.length,
        sentAt: new Date(),
      });
    } catch {
      logger.info({ userId, today }, "[DailyGoalNotify] already sent (unique constraint race) — skipping");
      return;
    }

    const title = `${username} hit their walking goal 🎉`;
    const body = `${currentSteps.toLocaleString()} steps done today — send a cheer!`;

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const friendId of eligibleIds) {
      try {
        // Respect recipient's notification preference
        const [recipientPrefs] = await db
          .select({ receiveFriendActivityNotifications: userPreferencesTable.receiveFriendActivityNotifications })
          .from(userPreferencesTable)
          .where(eq(userPreferencesTable.userId, friendId))
          .limit(1);

        if (recipientPrefs?.receiveFriendActivityNotifications === false) {
          logger.info({ userId, friendId }, "[DailyGoalNotify] recipient disabled friend notifications — skipping");
          skipped++;
          continue;
        }

        // sendNotification creates an in-app record AND fires OneSignal push
        await sendNotification(
          friendId,
          "friend_daily_goal_completed",
          title,
          body,
          { senderUserId: userId, deepLink: `/public-profile/${userId}` },
        );
        sent++;
      } catch (err) {
        failed++;
        logger.warn({ userId, friendId, err }, "[DailyGoalNotify] push failed");
      }
    }

    logger.info(
      { userId, sent, skipped, failed, total: eligibleIds.length },
      "[DailyGoalNotify] push sent",
    );
  } catch (err) {
    logger.warn({ err, userId }, "[DailyGoalNotify] notification failed");
  }
}

