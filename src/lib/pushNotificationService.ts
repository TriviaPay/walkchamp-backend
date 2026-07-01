/**
 * Typed OneSignal push helpers — production payloads per Walk Champ dashboard.
 * All sends go through sendPushToUser / sendPushToUsers in routes/push.ts.
 */

import { db } from "@db";
import {
  blockedUsersTable,
  notificationDevicesTable,
  pushNotificationLogsTable,
  raceRoomsTable,
  userNotificationPreferencesTable,
  walkingGroupMembersTable,
  walkingGroupsTable,
  profilesTable,
} from "@db/schema";
import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import { sendPushToUser, sendPushToUsers, type PushCategory } from "../routes/push.js";

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

function entryTypeDisplay(entryType: string, entryAmountCents = 0): string {
  const map: Record<string, string> = {
    free: "Free",
    paid_1: "$1",
    paid_3: "$3",
    paid_5: "$5",
    paid_usd: `$${entryAmountCents / 100}`,
    coins_battle: "Coins Battle",
  };
  return map[entryType] ?? entryType;
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

export async function notifyPrivateRoomInvitation(params: {
  roomId: string;
  roomCode: string;
  challengeType: string;
  inviterUserId: string;
  inviterUsername: string;
  invitedUserId: string;
  roomInviteId: string;
}): Promise<void> {
  const { roomId, roomCode, challengeType, inviterUserId, inviterUsername, invitedUserId, roomInviteId } =
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
  );
}

// ── Promotional (eligible users with active devices + race updates on) ────────

export async function notifyPromotionalRoomsAvailable(roomsCount: number, excludeUserId?: string): Promise<void> {
  if (roomsCount <= 0) return;
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
  );
}

export async function notifyPromotionalFreeChallenge(params: {
  roomId: string;
  challengeType: string;
  hostUserId: string;
}): Promise<void> {
  const dedupeKey = `promo_free_challenge:${params.roomId}`;
  const recipients = await filterDedupedRecipients(await getPromotionalRecipientIds(params.hostUserId), dedupeKey);
  if (recipients.length === 0) return;

  const deepLink = `walkchamp://rooms/${params.roomId}`;
  await sendPushToUsers(
    recipients,
    "🏁 New free challenge",
    `A new ${params.challengeType} room is open. Join now and start walking!`,
    { type: "promotional_free_challenge", roomId: params.roomId, challengeType: params.challengeType, deepLink },
    { url: deepLink, category: "race", dedupeKey },
  );
}

export async function notifyPromotionalCoinsBattle(params: {
  roomId: string;
  coinsEntry: number;
  hostUserId: string;
}): Promise<void> {
  const dedupeKey = `promo_coins_battle:${params.roomId}`;
  const recipients = await filterDedupedRecipients(await getPromotionalRecipientIds(params.hostUserId), dedupeKey);
  if (recipients.length === 0) return;

  const deepLink = `walkchamp://rooms/${params.roomId}`;
  await sendPushToUsers(
    recipients,
    "⚔️ Coins Battle open",
    `Join a ${params.coinsEntry} coins battle and compete for the prize pool.`,
    { type: "promotional_coins_battle", roomId: params.roomId, coinsEntry: params.coinsEntry, deepLink },
    { url: deepLink, category: "race", dedupeKey },
  );
}

export async function notifyPromotionalCashChallenge(params: {
  roomId: string;
  entryFee: string;
  hostUserId: string;
}): Promise<void> {
  const dedupeKey = `promo_cash_challenge:${params.roomId}`;
  const recipients = await filterDedupedRecipients(await getPromotionalRecipientIds(params.hostUserId), dedupeKey);
  if (recipients.length === 0) return;

  const deepLink = `walkchamp://rooms/${params.roomId}`;
  await sendPushToUsers(
    recipients,
    "💵 Cash challenge open",
    `A ${params.entryFee} skill-based walking challenge is available. Review and join now.`,
    { type: "promotional_cash_challenge", roomId: params.roomId, entryFee: params.entryFee, deepLink },
    { url: deepLink, category: "race", dedupeKey },
  );
}

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

/** Fire promotional pushes when a public room is hosted (non-scheduled). */
export async function firePromotionalRoomHosted(params: {
  roomId: string;
  entryType: string;
  isPrivate: boolean;
  hostUserId: string;
  coinEntryAmount?: number;
  entryAmountCents?: number;
  isScheduledFuture?: boolean;
}): Promise<void> {
  if (params.isPrivate || params.isScheduledFuture) return;

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(raceRoomsTable)
    .where(and(eq(raceRoomsTable.status, "open"), eq(raceRoomsTable.isPrivate, false)));

  const roomsCount = countRow?.count ?? 0;
  void notifyPromotionalRoomsAvailable(roomsCount, params.hostUserId);

  if (params.entryType === "free") {
    void notifyPromotionalFreeChallenge({
      roomId: params.roomId,
      challengeType: "Free",
      hostUserId: params.hostUserId,
    });
  } else if (params.entryType === "coins_battle" && params.coinEntryAmount) {
    void notifyPromotionalCoinsBattle({
      roomId: params.roomId,
      coinsEntry: params.coinEntryAmount,
      hostUserId: params.hostUserId,
    });
  } else if (["paid_1", "paid_3", "paid_5", "paid_usd"].includes(params.entryType)) {
    void notifyPromotionalCashChallenge({
      roomId: params.roomId,
      entryFee: entryTypeDisplay(params.entryType, params.entryAmountCents ?? 0),
      hostUserId: params.hostUserId,
    });
  }
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

export async function getUsername(userId: string): Promise<string> {
  const [p] = await db
    .select({ username: profilesTable.username })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);
  return p?.username ?? "Someone";
}
