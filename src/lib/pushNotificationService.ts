/**
 * Typed OneSignal push helpers — production payloads per Walk Champ dashboard.
 * All sends go through sendPushToUser / sendPushToUsers in routes/push.ts.
 */

import { db } from "../../db/src/index.js";
import {
  blockedUsersTable,
  groupDailyGoalNotificationEventsTable,
  notificationDevicesTable,
  notificationsTable,
  pushNotificationLogsTable,
  userNotificationPreferencesTable,
  userPreferencesTable,
  walkingGroupMembersTable,
  walkingGroupsTable,
  profilesTable,
} from "../../db/src/schema/index.js";
import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import { sendPushToUser, sendPushToUsers, type PushCategory } from "../routes/push.js";
import { logger } from "./logger.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

export async function areUsersBlocked(userA: string, userB: string): Promise<boolean> {
  const [row] = await db
    .select({ id: blockedUsersTable.id })
    .from(blockedUsersTable)
    .where(
      or(
        and(eq(blockedUsersTable.blockerId, userA), eq(blockedUsersTable.blockedId, userB)),
        and(eq(blockedUsersTable.blockerId, userB), eq(blockedUsersTable.blockedId, userA)),
      ),
    )
    .limit(1);
  return !!row;
}

async function wasRecentlySent(userId: string, dedupeKey: string, windowMs = 120_000): Promise<boolean> {
  const since = new Date(Date.now() - windowMs);
  const [row] = await db
    .select({ id: pushNotificationLogsTable.id })
    .from(pushNotificationLogsTable)
    .where(
      and(
        eq(pushNotificationLogsTable.userId, userId),
        eq(pushNotificationLogsTable.status, "sent"),
        gt(pushNotificationLogsTable.createdAt, since),
        sql`${pushNotificationLogsTable.data}->>'dedupeKey' = ${dedupeKey}`,
      ),
    )
    .limit(1);
  return !!row;
}

async function filterDedupedRecipients(userIds: string[], dedupeKey: string): Promise<string[]> {
  const out: string[] = [];
  for (const uid of userIds) {
    if (!(await wasRecentlySent(uid, dedupeKey))) out.push(uid);
  }
  return out;
}

async function safeSend(
  userId: string,
  title: string,
  body: string,
  data: Record<string, unknown>,
  options: { url?: string; category?: PushCategory; dedupeKey?: string },
): Promise<void> {
  if (!userId) return;
  if (options.dedupeKey && (await wasRecentlySent(userId, options.dedupeKey))) return;
  await sendPushToUser(userId, title, body, { ...data, dedupeKey: options.dedupeKey }, options);
}

export async function getGroupAdminUserIds(groupId: string, excludeUserId?: string): Promise<string[]> {
  const [group] = await db
    .select({ adminUserId: walkingGroupsTable.adminUserId, status: walkingGroupsTable.status })
    .from(walkingGroupsTable)
    .where(eq(walkingGroupsTable.id, groupId))
    .limit(1);
  if (!group || group.status !== "active") return [];

  const adminMembers = await db
    .select({ userId: walkingGroupMembersTable.userId })
    .from(walkingGroupMembersTable)
    .where(
      and(
        eq(walkingGroupMembersTable.groupId, groupId),
        eq(walkingGroupMembersTable.role, "admin"),
        eq(walkingGroupMembersTable.status, "active"),
      ),
    );

  const ids = new Set<string>([group.adminUserId, ...adminMembers.map((m) => m.userId)]);
  if (excludeUserId) ids.delete(excludeUserId);
  return [...ids];
}

export function buildChatMessagePreview(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 120) return trimmed;
  return `${trimmed.slice(0, 117)}...`;
}

async function getPromotionalRecipientIds(excludeUserId?: string, cap = 500): Promise<string[]> {
  const deviceRows = await db
    .selectDistinct({ userId: notificationDevicesTable.userId })
    .from(notificationDevicesTable)
    .where(eq(notificationDevicesTable.active, true));

  let userIds = deviceRows.map((r) => r.userId).filter((id) => id && id !== excludeUserId);
  if (userIds.length === 0) return [];

  const prefs = await db
    .select()
    .from(userNotificationPreferencesTable)
    .where(inArray(userNotificationPreferencesTable.userId, userIds));
  const prefMap = new Map(prefs.map((p) => [p.userId, p]));

  userIds = userIds.filter((uid) => {
    const p = prefMap.get(uid);
    if (!p) return true;
    return p.pushNotificationsEnabled && p.raceUpdatesEnabled;
  });

  return userIds.slice(0, cap);
}

// ── Walking groups ────────────────────────────────────────────────────────────

export interface GroupDailyGoalNotificationResult {
  groupsFound: number;
  eventsCreated: number;
  sentGroups: number;
  skippedDuplicate: number;
  skippedNoRecipients: number;
  failedGroups: number;
}

async function getEligibleGroupGoalRecipientIds(
  completedUserId: string,
  groupId: string,
): Promise<string[]> {
  const memberRows = await db
    .select({ userId: walkingGroupMembersTable.userId })
    .from(walkingGroupMembersTable)
    .where(
      and(
        eq(walkingGroupMembersTable.groupId, groupId),
        eq(walkingGroupMembersTable.status, "active"),
      ),
    );

  let recipientIds = [...new Set(memberRows.map((m) => m.userId).filter((id) => id !== completedUserId))];
  if (recipientIds.length === 0) return [];

  const prefRows = await db
    .select({
      userId: userPreferencesTable.userId,
      receiveFriendActivityNotifications: userPreferencesTable.receiveFriendActivityNotifications,
    })
    .from(userPreferencesTable)
    .where(inArray(userPreferencesTable.userId, recipientIds));
  const prefMap = new Map(prefRows.map((p) => [p.userId, p]));
  recipientIds = recipientIds.filter((id) => prefMap.get(id)?.receiveFriendActivityNotifications !== false);
  if (recipientIds.length === 0) return [];

  const blockedRows = await db
    .select({ blockerId: blockedUsersTable.blockerId, blockedId: blockedUsersTable.blockedId })
    .from(blockedUsersTable)
    .where(
      or(
        and(eq(blockedUsersTable.blockerId, completedUserId), inArray(blockedUsersTable.blockedId, recipientIds)),
        and(inArray(blockedUsersTable.blockerId, recipientIds), eq(blockedUsersTable.blockedId, completedUserId)),
      ),
    );

  const blockedRecipientIds = new Set<string>();
  for (const row of blockedRows) {
    blockedRecipientIds.add(row.blockerId === completedUserId ? row.blockedId : row.blockerId);
  }

  return recipientIds.filter((id) => !blockedRecipientIds.has(id));
}

export async function notifyGroupsOnDailyGoalCompletion(params: {
  completedUserId: string;
  currentSteps: number;
  goalSteps: number;
  localDate: string;
  timezone: string;
}): Promise<GroupDailyGoalNotificationResult> {
  const { completedUserId, currentSteps, goalSteps, localDate, timezone } = params;
  const result: GroupDailyGoalNotificationResult = {
    groupsFound: 0,
    eventsCreated: 0,
    sentGroups: 0,
    skippedDuplicate: 0,
    skippedNoRecipients: 0,
    failedGroups: 0,
  };

  try {
    logger.info({ userId: completedUserId, localDate }, "[GroupGoalNotification] checkStarted");

    const [profile] = await db
      .select({ username: profilesTable.username })
      .from(profilesTable)
      .where(eq(profilesTable.id, completedUserId))
      .limit(1);
    const username = profile?.username ?? "Someone";

    const groupRows = await db
      .select({ groupId: walkingGroupsTable.id, groupName: walkingGroupsTable.groupName })
      .from(walkingGroupMembersTable)
      .innerJoin(walkingGroupsTable, eq(walkingGroupMembersTable.groupId, walkingGroupsTable.id))
      .where(
        and(
          eq(walkingGroupMembersTable.userId, completedUserId),
          eq(walkingGroupMembersTable.status, "active"),
          eq(walkingGroupsTable.status, "active"),
        ),
      );

    result.groupsFound = groupRows.length;
    logger.info(
      { userId: completedUserId, localDate, todaySteps: currentSteps, dailyGoal: goalSteps, groupsFound: result.groupsFound },
      "[GroupGoalNotification] groupsFound",
    );

    for (const group of groupRows) {
      const deepLink = `walkchamp://walking-groups/${group.groupId}`;
      const notificationType = "group_daily_goal_completed" as const;
      const dedupeKey = `group_daily_goal_completed:${completedUserId}:${group.groupId}:${localDate}`;
      const title = "🏆 Daily Goal Completed";
      const body = `${username} completed their daily goal in ${group.groupName}!`;
      const dataPayload: Record<string, unknown> = {
        type: notificationType,
        groupId: group.groupId,
        completedUserId,
        username,
        groupName: group.groupName,
        deepLink,
        dedupeKey,
      };

      try {
        const recipientIds = await getEligibleGroupGoalRecipientIds(completedUserId, group.groupId);
        logger.info(
          {
            userId: completedUserId,
            groupId: group.groupId,
            recipientsCount: recipientIds.length,
            excludedCompletedUser: true,
          },
          "[GroupGoalNotification] recipientsSelected",
        );

        const inserted = await db
          .insert(groupDailyGoalNotificationEventsTable)
          .values({
            completedUserId,
            groupId: group.groupId,
            localDate,
            timezone,
            recipientUserIds: recipientIds,
            title,
            body,
            dataPayload,
            status: recipientIds.length === 0 ? "skipped_no_recipients" : "pending",
          })
          .onConflictDoNothing()
          .returning({ id: groupDailyGoalNotificationEventsTable.id });

        if (inserted.length === 0) {
          result.skippedDuplicate++;
          logger.info(
            { userId: completedUserId, groupId: group.groupId, localDate, alreadySent: true },
            "[GroupGoalNotification] duplicateSkipped",
          );
          continue;
        }

        result.eventsCreated++;

        if (recipientIds.length === 0) {
          result.skippedNoRecipients++;
          logger.info(
            { userId: completedUserId, groupId: group.groupId, skippedNoRecipients: true },
            "[GroupGoalNotification] skippedNoRecipients",
          );
          continue;
        }

        await db.insert(notificationsTable).values(
          recipientIds.map((userId) => ({
            userId,
            type: notificationType,
            title,
            body,
            data: dataPayload,
          })),
        );

        const delivery = await sendPushToUsers(recipientIds, title, body, dataPayload, {
          url: deepLink,
          dedupeKey,
        });

        const status =
          delivery.batches.length > 0 && delivery.batches.every((batch) => batch.status === "sent")
            ? "sent"
            : delivery.skippedReason ?? "failed";

        await db
          .update(groupDailyGoalNotificationEventsTable)
          .set({
            status,
            providerResponse: delivery as unknown as Record<string, unknown>,
            sentAt: status === "sent" ? new Date() : undefined,
            updatedAt: new Date(),
          })
          .where(eq(groupDailyGoalNotificationEventsTable.id, inserted[0].id));

        if (status === "sent") {
          result.sentGroups++;
        } else {
          result.failedGroups++;
        }

        logger.info(
          { userId: completedUserId, groupId: group.groupId, recipientsCount: recipientIds.length, sent: status === "sent" },
          "[GroupGoalNotification] sendCompleted",
        );
      } catch (err) {
        result.failedGroups++;
        logger.warn({ err, userId: completedUserId, groupId: group.groupId }, "[GroupGoalNotification] groupFailed");
      }
    }
  } catch (err) {
    logger.warn({ err, userId: completedUserId }, "[GroupGoalNotification] notificationFailed");
  }

  return result;
}

export async function notifyWalkingGroupInviteReceived(params: {
  invitedUserId: string;
  inviterUserId: string;
  inviterUsername: string;
  walkingGroupId: string;
  walkingGroupName: string;
  walkingGroupInviteId: string;
}): Promise<void> {
  const {
    invitedUserId,
    inviterUserId,
    inviterUsername,
    walkingGroupId,
    walkingGroupName,
    walkingGroupInviteId,
  } = params;

  if (invitedUserId === inviterUserId) return;
  if (await areUsersBlocked(invitedUserId, inviterUserId)) return;

  const deepLink = `walkchamp://walking-groups/${walkingGroupId}`;
  await safeSend(
    invitedUserId,
    "👥 Walking group invite",
    `${inviterUsername} invited you to join ${walkingGroupName}.`,
    {
      type: "walking_group_invite_received",
      walkingGroupId,
      walkingGroupName,
      walkingGroupInviteId,
      inviterUserId,
      invitedUserId,
      deepLink,
    },
    {
      url: deepLink,
      category: "invite",
      dedupeKey: `walking_group_invite:${walkingGroupInviteId}`,
    },
  );
}

export async function notifyWalkingGroupJoinRequestReceived(params: {
  walkingGroupId: string;
  walkingGroupName: string;
  walkingGroupJoinRequestId: string;
  requesterUserId: string;
  requesterUsername: string;
}): Promise<void> {
  const { walkingGroupId, walkingGroupName, walkingGroupJoinRequestId, requesterUserId, requesterUsername } =
    params;

  const adminIds = await getGroupAdminUserIds(walkingGroupId, requesterUserId);
  const deepLink = `walkchamp://walking-groups/${walkingGroupId}/requests`;

  await Promise.all(
    adminIds.map((adminUserId) =>
      safeSend(
        adminUserId,
        "New walking group request",
        `${requesterUsername} requested to join ${walkingGroupName}.`,
        {
          type: "walking_group_join_request_received",
          walkingGroupId,
          walkingGroupName,
          walkingGroupJoinRequestId,
          requesterUserId,
          adminUserId,
          deepLink,
        },
        {
          url: deepLink,
          category: "invite",
          dedupeKey: `walking_group_join_request:${walkingGroupJoinRequestId}:${adminUserId}`,
        },
      ),
    ),
  );
}

export async function notifyWalkingGroupRequestAccepted(params: {
  walkingGroupId: string;
  walkingGroupName: string;
  walkingGroupJoinRequestId: string;
  acceptedUserId: string;
  acceptedByAdminUserId: string;
}): Promise<void> {
  const { walkingGroupId, walkingGroupName, walkingGroupJoinRequestId, acceptedUserId, acceptedByAdminUserId } =
    params;

  if (acceptedUserId === acceptedByAdminUserId) return;

  const deepLink = `walkchamp://walking-groups/${walkingGroupId}`;
  await safeSend(
    acceptedUserId,
    `✅ You joined ${walkingGroupName}`,
    "Your walking group request was accepted. Start competing with the group!",
    {
      type: "walking_group_request_accepted",
      walkingGroupId,
      walkingGroupName,
      walkingGroupJoinRequestId,
      acceptedUserId,
      acceptedByAdminUserId,
      deepLink,
    },
    {
      url: deepLink,
      category: "invite",
      dedupeKey: `walking_group_request_accepted:${walkingGroupJoinRequestId}`,
    },
  );
}

export async function notifyWalkingGroupRequestRejected(params: {
  walkingGroupId: string;
  walkingGroupName: string;
  walkingGroupJoinRequestId: string;
  requesterUserId: string;
}): Promise<void> {
  const { walkingGroupId, walkingGroupName, walkingGroupJoinRequestId, requesterUserId } = params;
  const deepLink = `walkchamp://walking-groups/${walkingGroupId}`;

  await safeSend(
    requesterUserId,
    "Walking group request declined",
    `Your request to join ${walkingGroupName} was not accepted.`,
    {
      type: "walking_group_request_rejected",
      walkingGroupId,
      walkingGroupName,
      walkingGroupJoinRequestId,
      requesterUserId,
      deepLink,
    },
    {
      url: deepLink,
      category: "invite",
      dedupeKey: `walking_group_request_rejected:${walkingGroupJoinRequestId}`,
    },
  );
}

// ── Chat ──────────────────────────────────────────────────────────────────────

export async function notifyChatMessageReceived(params: {
  conversationId: string;
  messageId: string;
  senderUserId: string;
  senderUsername: string;
  receiverUserId: string;
  messagePreview: string;
}): Promise<void> {
  const { conversationId, messageId, senderUserId, senderUsername, receiverUserId, messagePreview } = params;

  if (senderUserId === receiverUserId) return;
  if (await areUsersBlocked(senderUserId, receiverUserId)) return;

  const preview = buildChatMessagePreview(messagePreview);
  if (!preview) return;

  const deepLink = `walkchamp://chat/private/${conversationId}`;
  await safeSend(
    receiverUserId,
    `💬 New message from ${senderUsername}`,
    preview,
    {
      type: "chat_message_received",
      conversationId,
      messageId,
      senderUserId,
      receiverUserId,
      deepLink,
    },
    {
      url: deepLink,
      category: "chat",
      dedupeKey: `chat_message:${messageId}`,
    },
  );
}

// ── Private room invite ───────────────────────────────────────────────────────
// DISABLED: Race-Private Room Invitation push (temporarily removed from product)

export async function notifyPrivateRoomInvitation(params: {
  roomId: string;
  roomCode: string;
  challengeType: string;
  inviterUserId: string;
  inviterUsername: string;
  invitedUserId: string;
  roomInviteId: string;
}): Promise<void> {
  void params;
  return;

  /* const { roomId, roomCode, challengeType, inviterUserId, inviterUsername, invitedUserId, roomInviteId } =
    params;

  if (inviterUserId === invitedUserId) return;
  if (await areUsersBlocked(inviterUserId, invitedUserId)) return;
  if (!roomCode) return;

  const deepLink = `walkchamp://rooms/join-code?code=${encodeURIComponent(roomCode)}`;
  await safeSend(
    invitedUserId,
    "🔒 Private room invite",
    `${inviterUsername} invited you to a private ${challengeType} room. Use code ${roomCode} to join.`,
    {
      type: "private_room_invitation",
      roomId,
      roomCode,
      challengeType,
      inviterUserId,
      invitedUserId,
      roomInviteId,
      deepLink,
    },
    {
      url: deepLink,
      category: "invite",
      dedupeKey: `private_room_invite:${roomInviteId}`,
    },
  ); */
}

// ── Promotional (eligible users with active devices + race updates on) ────────
// DISABLED: Host-Rooms Available Now push (temporarily removed from product)

export async function notifyPromotionalRoomsAvailable(roomsCount: number, excludeUserId?: string): Promise<void> {
  void roomsCount;
  void excludeUserId;
  return;

  /* if (roomsCount <= 0) return;
  const recipients = await filterDedupedRecipients(
    await getPromotionalRecipientIds(excludeUserId),
    `promo_rooms_available:${roomsCount}`,
  );
  if (recipients.length === 0) return;

  const deepLink = "walkchamp://rooms";
  await sendPushToUsers(
    recipients,
    "🏃 Rooms available now",
    `${roomsCount} rooms are open. Join a challenge before they fill up!`,
    { type: "promotional_rooms_available", roomsCount, deepLink },
    { url: deepLink, category: "race", dedupeKey: `promo_rooms_available:${roomsCount}` },
  ); */
}

// DISABLED: Host-Free Challenge Available push (temporarily removed from product)

export async function notifyPromotionalFreeChallenge(params: {
  roomId: string;
  challengeType: string;
  hostUserId: string;
}): Promise<void> {
  void params;
  return;

  /* const dedupeKey = `promo_free_challenge:${params.roomId}`;
  const recipients = await filterDedupedRecipients(await getPromotionalRecipientIds(params.hostUserId), dedupeKey);
  if (recipients.length === 0) return;

  const deepLink = `walkchamp://rooms/${params.roomId}`;
  await sendPushToUsers(
    recipients,
    "🏁 New free challenge",
    `A new ${params.challengeType} room is open. Join now and start walking!`,
    { type: "promotional_free_challenge", roomId: params.roomId, challengeType: params.challengeType, deepLink },
    { url: deepLink, category: "race", dedupeKey },
  ); */
}

// DISABLED: Host-Coins Battle Open push (temporarily removed from product)

export async function notifyPromotionalCoinsBattle(params: {
  roomId: string;
  coinsEntry: number;
  hostUserId: string;
}): Promise<void> {
  void params;
  return;

  /* const dedupeKey = `promo_coins_battle:${params.roomId}`;
  const recipients = await filterDedupedRecipients(await getPromotionalRecipientIds(params.hostUserId), dedupeKey);
  if (recipients.length === 0) return;

  const deepLink = `walkchamp://rooms/${params.roomId}`;
  await sendPushToUsers(
    recipients,
    "⚔️ Coins Battle open",
    `Join a ${params.coinsEntry} coins battle and compete for the prize pool.`,
    { type: "promotional_coins_battle", roomId: params.roomId, coinsEntry: params.coinsEntry, deepLink },
    { url: deepLink, category: "race", dedupeKey },
  ); */
}

// DISABLED: Host-Cash Challenge Open push (temporarily removed from product)

export async function notifyPromotionalCashChallenge(params: {
  roomId: string;
  entryFee: string;
  hostUserId: string;
}): Promise<void> {
  void params;
  return;

  /* const dedupeKey = `promo_cash_challenge:${params.roomId}`;
  const recipients = await filterDedupedRecipients(await getPromotionalRecipientIds(params.hostUserId), dedupeKey);
  if (recipients.length === 0) return;

  const deepLink = `walkchamp://rooms/${params.roomId}`;
  await sendPushToUsers(
    recipients,
    "💵 Cash challenge open",
    `A ${params.entryFee} skill-based walking challenge is available. Review and join now.`,
    { type: "promotional_cash_challenge", roomId: params.roomId, entryFee: params.entryFee, deepLink },
    { url: deepLink, category: "race", dedupeKey },
  ); */
}

// ── Promotional sponsored events ──────────────────────────────────────────────

export async function notifyPromotionalSponsoredEvent(params: {
  eventId: string;
  eventName: string;
  coinsEntry: number;
  excludeUserId?: string;
}): Promise<void> {
  const dedupeKey = `promo_sponsored_event:${params.eventId}`;
  const recipients = await filterDedupedRecipients(
    await getPromotionalRecipientIds(params.excludeUserId),
    dedupeKey,
  );
  if (recipients.length === 0) return;

  const deepLink = `walkchamp://sponsored-events/${params.eventId}`;
  await sendPushToUsers(
    recipients,
    "🎁 Sponsored event open",
    `Join ${params.eventName} for ${params.coinsEntry} coins and compete for sponsored prizes.`,
    {
      type: "promotional_sponsored_event",
      eventId: params.eventId,
      eventName: params.eventName,
      coinsEntry: params.coinsEntry,
      deepLink,
    },
    { url: deepLink, category: "race", dedupeKey },
  );
}

export async function notifyFriendRequestRejected(params: {
  senderUserId: string;
  receiverUsername: string;
  requestId: string;
}): Promise<void> {
  const deepLink = "walkchamp://chat/friends";
  await safeSend(
    params.senderUserId,
    "Friend request declined",
    `@${params.receiverUsername} declined your friend request.`,
    {
      type: "friend_request_rejected",
      requestId: params.requestId,
      deepLink,
    },
    { url: deepLink, category: "invite", dedupeKey: `friend_request_rejected:${params.requestId}` },
  );
}

export async function notifyFriendRequestReceived(params: {
  recipientUserId: string;
  senderUserId: string;
  senderUsername: string;
  requestId: string;
}): Promise<void> {
  if (params.recipientUserId === params.senderUserId) return;
  if (await areUsersBlocked(params.recipientUserId, params.senderUserId)) return;

  const deepLink = "walkchamp://chat/requests";
  await safeSend(
    params.recipientUserId,
    "👋 New friend request",
    `${params.senderUsername} wants to connect with you on Walk Champ.`,
    {
      type: "friend_request",
      requestId: params.requestId,
      senderUserId: params.senderUserId,
      senderUsername: params.senderUsername,
      deepLink,
    },
    { url: deepLink, category: "invite", dedupeKey: `friend_request:${params.requestId}` },
  );
}

export async function notifyFriendRequestAccepted(params: {
  senderUserId: string;
  acceptedByUserId: string;
  acceptedByUsername: string;
  requestId: string;
}): Promise<void> {
  if (params.senderUserId === params.acceptedByUserId) return;
  if (await areUsersBlocked(params.senderUserId, params.acceptedByUserId)) return;

  const deepLink = "walkchamp://chat/friends";
  await safeSend(
    params.senderUserId,
    "✅ Friend request accepted",
    `${params.acceptedByUsername} accepted your friend request. Start walking together!`,
    {
      type: "friend_request_accepted",
      requestId: params.requestId,
      friendId: params.acceptedByUserId,
      friendUsername: params.acceptedByUsername,
      deepLink,
    },
    { url: deepLink, category: "invite", dedupeKey: `friend_request_accepted:${params.requestId}` },
  );
}

export async function getUsername(userId: string): Promise<string> {
  const [p] = await db
    .select({ username: profilesTable.username })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);
  return p?.username ?? "Someone";
}
