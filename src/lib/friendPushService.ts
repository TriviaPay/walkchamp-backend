import { db } from "@db";
import { blockedUsersTable, notificationsTable } from "@db/schema";
import { and, eq, or } from "drizzle-orm";
import { sendOneSignalNotification } from "./oneSignalService";

const FRIEND_REQUEST_RECEIVED_DEEP_LINK = "walkchamp://chat/requests";
const FRIEND_REQUEST_ACCEPTED_DEEP_LINK = "walkchamp://chat/friends";

async function areUsersBlocked(userA: string, userB: string): Promise<boolean> {
  const [blocked] = await db
    .select({ id: blockedUsersTable.id })
    .from(blockedUsersTable)
    .where(
      or(
        and(eq(blockedUsersTable.blockerId, userA), eq(blockedUsersTable.blockedId, userB)),
        and(eq(blockedUsersTable.blockerId, userB), eq(blockedUsersTable.blockedId, userA)),
      ),
    )
    .limit(1);
  return !!blocked;
}

export async function sendFriendRequestReceivedPush({
  friendRequestId,
  senderUserId,
  receiverUserId,
  senderUsername,
}: {
  friendRequestId: string;
  senderUserId: string;
  receiverUserId: string;
  senderUsername: string;
}): Promise<void> {
  if (senderUserId === receiverUserId) return;

  if (await areUsersBlocked(senderUserId, receiverUserId)) {
    console.info("[FriendPush] skipped friend_request_received — users blocked", {
      friendRequestId,
      senderUserId,
      receiverUserId,
    });
    return;
  }

  const title = "👋 New friend request";
  const body = `${senderUsername} wants to connect with you on Walk Champ.`;
  const pushData = {
    type: "friend_request_received",
    friendRequestId,
    senderUserId,
    receiverUserId,
    deepLink: FRIEND_REQUEST_RECEIVED_DEEP_LINK,
  };

  await db.insert(notificationsTable).values({
    userId: receiverUserId,
    type: "friend_request",
    title,
    body,
    data: { requestId: friendRequestId, ...pushData },
  });

  await sendOneSignalNotification({
    recipientUserIds: [receiverUserId],
    title,
    body,
    url: FRIEND_REQUEST_RECEIVED_DEEP_LINK,
    data: pushData,
    checkInvitePreference: true,
    idempotencyKey: {
      eventType: "friend_request_received",
      entityId: friendRequestId,
      recipientUserId: receiverUserId,
    },
  });
}

export async function sendFriendRequestAcceptedPush({
  friendRequestId,
  requesterUserId,
  acceptedByUserId,
  acceptedByUsername,
}: {
  friendRequestId: string;
  requesterUserId: string;
  acceptedByUserId: string;
  acceptedByUsername: string;
}): Promise<void> {
  if (requesterUserId === acceptedByUserId) return;

  if (await areUsersBlocked(requesterUserId, acceptedByUserId)) {
    console.info("[FriendPush] skipped friend_request_accepted — users blocked", {
      friendRequestId,
      requesterUserId,
      acceptedByUserId,
    });
    return;
  }

  const title = "✅ Friend request accepted";
  const body = `${acceptedByUsername} accepted your friend request. Start walking together!`;
  const pushData = {
    type: "friend_request_accepted",
    friendRequestId,
    acceptedByUserId,
    requesterUserId,
    deepLink: FRIEND_REQUEST_ACCEPTED_DEEP_LINK,
  };

  await db.insert(notificationsTable).values({
    userId: requesterUserId,
    type: "friend_request_accepted",
    title,
    body,
    data: { friendId: acceptedByUserId, ...pushData },
  });

  await sendOneSignalNotification({
    recipientUserIds: [requesterUserId],
    title,
    body,
    url: FRIEND_REQUEST_ACCEPTED_DEEP_LINK,
    data: pushData,
    checkInvitePreference: true,
    idempotencyKey: {
      eventType: "friend_request_accepted",
      entityId: friendRequestId,
      recipientUserId: requesterUserId,
    },
  });
}
