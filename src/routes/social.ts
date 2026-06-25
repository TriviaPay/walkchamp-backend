import { Router } from "express";
import { db } from "@db";
import {
  friendsTable,
  friendRequestsTable,
  blockedUsersTable,
  profilesTable,
  conversationsTable,
  privateChatMessagesTable,
  userPresenceTable,
} from "@db/schema";
import { eq, and, or, desc, inArray, sql, gte, ne } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth";
import { sendNotification } from "./notifications";
import { triggerEvent } from "../lib/pusher";
import { z } from "zod";
import { grantCoinReward } from "../lib/coinRewardService";

const router = Router();

// ── GET /api/friends ─────────────────────────────────────────────────────────
router.get("/friends", requireAuth, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const onlineAfter = new Date(Date.now() - 90_000);

  const rows = await db
    .select({
      friendId: friendsTable.friendId,
      createdAt: friendsTable.createdAt,
      username: profilesTable.username,
      countryFlag: profilesTable.countryFlag,
      avatarColor: profilesTable.avatarColor,
      avatarUrl: profilesTable.avatarUrl,
      updatedAt: profilesTable.updatedAt,
      lastSeenAt: userPresenceTable.lastSeenAt,
    })
    .from(friendsTable)
    .innerJoin(profilesTable, eq(profilesTable.id, friendsTable.friendId))
    .leftJoin(userPresenceTable, eq(userPresenceTable.userId, friendsTable.friendId))
    .where(eq(friendsTable.userId, userId))
    .orderBy(desc(friendsTable.createdAt));

  return res.json({
    friends: rows.map((r) => ({
      id: r.friendId,
      username: r.username,
      flag: r.countryFlag ?? "🏳️",
      avatarColor: r.avatarColor ?? "#00E676",
      avatarUrl: r.avatarUrl ?? null,
      avatarVersion: r.updatedAt?.getTime() ?? 0,
      friendedAt: r.createdAt.toISOString(),
      isOnline: r.lastSeenAt != null && r.lastSeenAt >= onlineAfter,
    })),
  });
});

// ── GET /api/friends/requests ────────────────────────────────────────────────
router.get("/friends/requests", requireAuth, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const pendingReceived = await db
    .select({
      id: friendRequestsTable.id,
      senderId: friendRequestsTable.senderId,
      createdAt: friendRequestsTable.createdAt,
      username: profilesTable.username,
      countryFlag: profilesTable.countryFlag,
      avatarColor: profilesTable.avatarColor,
      avatarUrl: profilesTable.avatarUrl,
      updatedAt: profilesTable.updatedAt,
    })
    .from(friendRequestsTable)
    .innerJoin(profilesTable, eq(profilesTable.id, friendRequestsTable.senderId))
    .where(
      and(
        eq(friendRequestsTable.recipientId, userId),
        eq(friendRequestsTable.status, "pending"),
      ),
    )
    .orderBy(desc(friendRequestsTable.createdAt));

  const pendingSent = await db
    .select({
      id: friendRequestsTable.id,
      recipientId: friendRequestsTable.recipientId,
      createdAt: friendRequestsTable.createdAt,
      username: profilesTable.username,
      countryFlag: profilesTable.countryFlag,
      avatarColor: profilesTable.avatarColor,
      avatarUrl: profilesTable.avatarUrl,
      updatedAt: profilesTable.updatedAt,
    })
    .from(friendRequestsTable)
    .innerJoin(profilesTable, eq(profilesTable.id, friendRequestsTable.recipientId))
    .where(
      and(
        eq(friendRequestsTable.senderId, userId),
        eq(friendRequestsTable.status, "pending"),
      ),
    )
    .orderBy(desc(friendRequestsTable.createdAt));

  return res.json({
    received: pendingReceived.map((r) => ({
      id: r.id,
      type: "received",
      userId: r.senderId,
      username: r.username,
      flag: r.countryFlag ?? "🏳️",
      avatarColor: r.avatarColor ?? "#00E676",
      avatarUrl: r.avatarUrl ?? null,
      avatarVersion: r.updatedAt?.getTime() ?? 0,
      createdAt: r.createdAt.toISOString(),
    })),
    sent: pendingSent.map((r) => ({
      id: r.id,
      type: "sent",
      userId: r.recipientId,
      username: r.username,
      flag: r.countryFlag ?? "🏳️",
      avatarColor: r.avatarColor ?? "#00E676",
      avatarUrl: r.avatarUrl ?? null,
      avatarVersion: r.updatedAt?.getTime() ?? 0,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

// ── POST /api/friends/request ────────────────────────────────────────────────
router.post("/friends/request", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = z.object({ targetUserId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "targetUserId required" });

  const targetId = parsed.data.targetUserId;
  if (targetId === userId) return res.status(400).json({ error: "Cannot send request to yourself" });

  const [alreadyFriend] = await db
    .select({ id: friendsTable.id })
    .from(friendsTable)
    .where(and(eq(friendsTable.userId, userId), eq(friendsTable.friendId, targetId)))
    .limit(1);
  if (alreadyFriend) return res.status(409).json({ error: "Already friends" });

  const [blocked] = await db
    .select({ id: blockedUsersTable.id })
    .from(blockedUsersTable)
    .where(
      or(
        and(eq(blockedUsersTable.blockerId, userId), eq(blockedUsersTable.blockedId, targetId)),
        and(eq(blockedUsersTable.blockerId, targetId), eq(blockedUsersTable.blockedId, userId)),
      ),
    )
    .limit(1);
  if (blocked) return res.status(403).json({ error: "Cannot send friend request" });

  const [existing] = await db
    .select({ id: friendRequestsTable.id, status: friendRequestsTable.status, senderId: friendRequestsTable.senderId })
    .from(friendRequestsTable)
    .where(
      or(
        and(eq(friendRequestsTable.senderId, userId), eq(friendRequestsTable.recipientId, targetId)),
        and(eq(friendRequestsTable.senderId, targetId), eq(friendRequestsTable.recipientId, userId)),
      ),
    )
    .limit(1);
  if (existing && existing.status === "pending") {
    return res.status(200).json({ request: { id: existing.id, status: "pending" } });
  }

  // Explicit insert-or-update without onConflictDoUpdate (avoids Drizzle unique-index bug)
  let request: { id: string; status: string; createdAt: Date };
  if (existing) {
    if (existing.senderId === userId) {
      // Re-activate own previous rejected/accepted request
      const [updated] = await db
        .update(friendRequestsTable)
        .set({ status: "pending", updatedAt: new Date() })
        .where(eq(friendRequestsTable.id, existing.id))
        .returning();
      request = updated!;
    } else {
      // Reverse-direction request exists — delete it and create the correct one
      await db.delete(friendRequestsTable).where(eq(friendRequestsTable.id, existing.id));
      const [inserted] = await db
        .insert(friendRequestsTable)
        .values({ senderId: userId, recipientId: targetId })
        .returning();
      request = inserted!;
    }
  } else {
    const [inserted] = await db
      .insert(friendRequestsTable)
      .values({ senderId: userId, recipientId: targetId })
      .returning();
    request = inserted!;
  }

  const [senderProfile] = await db
    .select({ username: profilesTable.username })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);

  sendNotification(
    targetId,
    "friend_request",
    "Friend request received",
    `@${senderProfile?.username ?? "Someone"} sent you a friend request`,
    {
      requestId: request.id,
      senderUserId: userId,
      senderUsername: senderProfile?.username ?? "Someone",
      deepLink: "walkchamp://chat/requests",
    },
  ).catch(() => {});

  const senderSummary = {
    id: userId,
    username: senderProfile?.username ?? "Unknown",
    avatarColor: "#00E676",
    flag: "🌍",
  };

  // Notify receiver of new incoming request
  triggerEvent(`private-user-${targetId}`, "friend_request:new", {
    id: request.id,
    userId,
    username: senderSummary.username,
    avatarColor: senderSummary.avatarColor,
    flag: senderSummary.flag,
    createdAt: request.createdAt.toISOString(),
  }).catch(() => {});

  // Confirm to sender
  triggerEvent(`private-user-${userId}`, "friend_request:sent", {
    requestId: request.id,
    recipientId: targetId,
  }).catch(() => {});

  return res.status(201).json({ request: { id: request.id, status: request.status } });
});

// ── POST /api/friends/accept ─────────────────────────────────────────────────
router.post("/friends/accept", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = z.object({ requestId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "requestId required" });

  const [request] = await db
    .select()
    .from(friendRequestsTable)
    .where(
      and(
        eq(friendRequestsTable.id, parsed.data.requestId),
        eq(friendRequestsTable.recipientId, userId),
        eq(friendRequestsTable.status, "pending"),
      ),
    )
    .limit(1);

  if (!request) return res.status(404).json({ error: "Request not found" });

  await db.transaction(async (tx) => {
    await tx
      .update(friendRequestsTable)
      .set({ status: "accepted", updatedAt: new Date() })
      .where(eq(friendRequestsTable.id, request.id));

    await tx
      .insert(friendsTable)
      .values([
        { userId, friendId: request.senderId },
        { userId: request.senderId, friendId: userId },
      ])
      .onConflictDoNothing();
  });

  // ── Friend accept coin rewards (+5 each, fire-and-forget) ────────────────────
  void Promise.all([
    grantCoinReward(request.senderId, "FRIEND_ACCEPT", `friendship:${request.id}`, "Friend request accepted"),
    grantCoinReward(userId, "FRIEND_ACCEPT", `friendship:${request.id}`, "Friend request accepted"),
  ]).catch(() => {});

  const [[receiverProfile], [senderProfile]] = await Promise.all([
    db.select({ username: profilesTable.username, countryFlag: profilesTable.countryFlag, avatarColor: profilesTable.avatarColor })
      .from(profilesTable).where(eq(profilesTable.id, userId)).limit(1),
    db.select({ username: profilesTable.username, countryFlag: profilesTable.countryFlag, avatarColor: profilesTable.avatarColor })
      .from(profilesTable).where(eq(profilesTable.id, request.senderId)).limit(1),
  ]);

  req.log.info({ requestId: request.id, senderId: request.senderId, receiverId: userId }, "friend request accepted — friendship rows inserted for both directions");

  sendNotification(
    request.senderId,
    "friend_request_accepted",
    "Friend request accepted",
    `@${receiverProfile?.username ?? "Someone"} accepted your friend request`,
    {
      requestId: request.id,
      friendId: userId,
      friendUsername: receiverProfile?.username ?? "Someone",
      deepLink: "walkchamp://chat/friends",
    },
  ).catch(() => {});

  sendNotification(
    userId,
    "friend_request_accepted",
    "You're now friends",
    `You and @${senderProfile?.username ?? "Someone"} are now friends`,
    {
      requestId: request.id,
      friendId: request.senderId,
      friendUsername: senderProfile?.username ?? "Someone",
      deepLink: "walkchamp://chat/friends",
    },
  ).catch(() => {});

  const acceptPayload = {
    requestId: request.id,
    sender: {
      id: request.senderId,
      username: senderProfile?.username ?? "Unknown",
      flag: senderProfile?.countryFlag ?? "🌍",
      avatarColor: senderProfile?.avatarColor ?? "#00E676",
    },
    receiver: {
      id: userId,
      username: receiverProfile?.username ?? "Unknown",
      flag: receiverProfile?.countryFlag ?? "🌍",
      avatarColor: receiverProfile?.avatarColor ?? "#00E676",
    },
    acceptedAt: new Date().toISOString(),
  };

  triggerEvent(`private-user-${request.senderId}`, "friend_request:accepted", acceptPayload).catch(() => {});
  triggerEvent(`private-user-${userId}`, "friend_request:accepted", acceptPayload).catch(() => {});
  triggerEvent(`private-user-${request.senderId}`, "friend:list_updated", { friendId: userId }).catch(() => {});
  triggerEvent(`private-user-${userId}`, "friend:list_updated", { friendId: request.senderId }).catch(() => {});

  return res.json({ ok: true });
});

// ── POST /api/friends/reject ─────────────────────────────────────────────────
router.post("/friends/reject", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = z.object({ requestId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "requestId required" });

  await db
    .update(friendRequestsTable)
    .set({ status: "rejected", updatedAt: new Date() })
    .where(
      and(
        eq(friendRequestsTable.id, parsed.data.requestId),
        eq(friendRequestsTable.recipientId, userId),
        eq(friendRequestsTable.status, "pending"),
      ),
    );

  return res.json({ ok: true });
});

// ── GET /api/friends/status ───────────────────────────────────────────────────
router.get("/friends/status", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const userIdsParam = String(req.query.userIds ?? "");
  const userIds = userIdsParam.split(",").filter(Boolean).slice(0, 50);

  if (userIds.length === 0) return res.json({ status: {} });

  const [friendRows, requestRows] = await Promise.all([
    db
      .select({ friendId: friendsTable.friendId })
      .from(friendsTable)
      .where(and(eq(friendsTable.userId, userId), inArray(friendsTable.friendId, userIds))),
    db
      .select({ senderId: friendRequestsTable.senderId, recipientId: friendRequestsTable.recipientId })
      .from(friendRequestsTable)
      .where(
        and(
          eq(friendRequestsTable.status, "pending"),
          or(
            and(eq(friendRequestsTable.senderId, userId), inArray(friendRequestsTable.recipientId, userIds)),
            and(eq(friendRequestsTable.recipientId, userId), inArray(friendRequestsTable.senderId, userIds)),
          ),
        ),
      ),
  ]);

  const friendSet = new Set(friendRows.map((r) => r.friendId));
  const statusMap: Record<string, "none" | "sent" | "received" | "friends"> = {};

  for (const uid of userIds) {
    if (friendSet.has(uid)) {
      statusMap[uid] = "friends";
    } else {
      const row = requestRows.find((r) => r.senderId === uid || r.recipientId === uid);
      if (row) {
        statusMap[uid] = row.senderId === userId ? "sent" : "received";
      } else {
        statusMap[uid] = "none";
      }
    }
  }

  return res.json({ status: statusMap });
});

// ── POST /api/friends/cancel ─────────────────────────────────────────────────
router.post("/friends/cancel", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = z.object({ requestId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "requestId required" });

  await db
    .update(friendRequestsTable)
    .set({ status: "rejected", updatedAt: new Date() })
    .where(
      and(
        eq(friendRequestsTable.id, parsed.data.requestId),
        eq(friendRequestsTable.senderId, userId),
        eq(friendRequestsTable.status, "pending"),
      ),
    );

  return res.json({ ok: true });
});

// ── POST /api/friends/remove ─────────────────────────────────────────────────
router.post("/friends/remove", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = z.object({ friendId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "friendId required" });

  const fId = parsed.data.friendId;
  let deletedConversationId: string | null = null;

  try {
    await db.transaction(async (tx) => {
      const [conv] = await tx
        .select({ id: conversationsTable.id })
        .from(conversationsTable)
        .where(
          or(
            and(eq(conversationsTable.user1Id, userId), eq(conversationsTable.user2Id, fId)),
            and(eq(conversationsTable.user1Id, fId), eq(conversationsTable.user2Id, userId)),
          ),
        )
        .limit(1);

      if (conv) {
        deletedConversationId = conv.id;
        await tx.delete(privateChatMessagesTable).where(eq(privateChatMessagesTable.conversationId, conv.id));
        await tx.delete(conversationsTable).where(eq(conversationsTable.id, conv.id));
        req.log.info({ conversationId: conv.id }, "unfriend: private conversation deleted");
      }

      await tx.delete(friendsTable).where(
        or(
          and(eq(friendsTable.userId, userId), eq(friendsTable.friendId, fId)),
          and(eq(friendsTable.userId, fId), eq(friendsTable.friendId, userId)),
        ),
      );
    });
  } catch (err) {
    req.log.error({ err }, "unfriend transaction failed");
    return res.status(500).json({ error: "Failed to unfriend" });
  }

  triggerEvent(`private-user-${fId}`, "friendship:removed", {
    friendId: userId,
    conversationId: deletedConversationId,
  }).catch(() => {});

  return res.json({
    ok: true,
    conversationId: deletedConversationId,
  });
});

// ── POST /api/friends/requests/mark-seen ────────────────────────────────────
router.post("/friends/requests/mark-seen", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  await db
    .update(friendRequestsTable)
    .set({ seenAt: new Date() })
    .where(
      and(
        eq(friendRequestsTable.recipientId, userId),
        eq(friendRequestsTable.status, "pending"),
        sql`${friendRequestsTable.seenAt} IS NULL`,
      ),
    );
  return res.json({ ok: true });
});

// ── POST /api/users/:userId/block ────────────────────────────────────────────
router.post("/users/:userId/block", requireAuth, async (req, res) => {
  const myId = (req as AuthenticatedRequest).descopeUserId;
  const targetId = String(req.params.userId);
  if (targetId === myId) return res.status(400).json({ error: "Cannot block yourself" });

  await db
    .insert(blockedUsersTable)
    .values({ blockerId: myId, blockedId: targetId })
    .onConflictDoNothing();

  await db.delete(friendsTable).where(
    or(
      and(eq(friendsTable.userId, myId), eq(friendsTable.friendId, targetId)),
      and(eq(friendsTable.userId, targetId), eq(friendsTable.friendId, myId)),
    ),
  );

  return res.json({ ok: true });
});

// ── GET /api/users/search ──────────────────────────────────────────────────────
router.get("/users/search", requireAuth, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const raw = String(req.query.query ?? "").trim();
  if (raw.length < 3) return res.json({ users: [] });

  const pattern = `%${raw.toLowerCase()}%`;

  const profiles = await db
    .select({
      id: profilesTable.id,
      username: profilesTable.username,
      fullName: profilesTable.fullName,
      countryFlag: profilesTable.countryFlag,
      avatarColor: profilesTable.avatarColor,
      avatarUrl: profilesTable.avatarUrl,
      updatedAt: profilesTable.updatedAt,
    })
    .from(profilesTable)
    .where(and(sql`LOWER(${profilesTable.username}) LIKE ${pattern}`, ne(profilesTable.id, userId)))
    .limit(20);

  if (profiles.length === 0) return res.json({ users: [] });

  const targetIds = profiles.map((p) => p.id);

  const [friendRows, requestRows, blockedRows] = await Promise.all([
    db
      .select({ userId: friendsTable.userId, friendId: friendsTable.friendId })
      .from(friendsTable)
      .where(
        or(
          and(eq(friendsTable.userId, userId), inArray(friendsTable.friendId, targetIds)),
          and(inArray(friendsTable.userId, targetIds), eq(friendsTable.friendId, userId)),
        ),
      ),
    db
      .select({
        id: friendRequestsTable.id,
        senderId: friendRequestsTable.senderId,
        recipientId: friendRequestsTable.recipientId,
      })
      .from(friendRequestsTable)
      .where(
        and(
          eq(friendRequestsTable.status, "pending"),
          or(
            and(eq(friendRequestsTable.senderId, userId), inArray(friendRequestsTable.recipientId, targetIds)),
            and(inArray(friendRequestsTable.senderId, targetIds), eq(friendRequestsTable.recipientId, userId)),
          ),
        ),
      ),
    db
      .select({ blockerId: blockedUsersTable.blockerId, blockedId: blockedUsersTable.blockedId })
      .from(blockedUsersTable)
      .where(
        or(
          and(eq(blockedUsersTable.blockerId, userId), inArray(blockedUsersTable.blockedId, targetIds)),
          and(inArray(blockedUsersTable.blockerId, targetIds), eq(blockedUsersTable.blockedId, userId)),
        ),
      ),
  ]);

  const friendSet = new Set(friendRows.map((r) => (r.userId === userId ? r.friendId : r.userId)));
  const sentMap = new Map(requestRows.filter((r) => r.senderId === userId).map((r) => [r.recipientId, r.id]));
  const receivedMap = new Map(requestRows.filter((r) => r.recipientId === userId).map((r) => [r.senderId, r.id]));
  const blockedSet = new Set([...blockedRows.map((r) => r.blockedId), ...blockedRows.map((r) => r.blockerId)]);

  const users = profiles
    .filter((p) => !blockedSet.has(p.id))
    .map((p) => {
      const isFriend = friendSet.has(p.id);
      const isSent = sentMap.has(p.id);
      const isReceived = receivedMap.has(p.id);
      const friendStatus = isFriend
        ? "friends"
        : isSent
        ? "pending_sent"
        : isReceived
        ? "pending_received"
        : "none";
      return {
        id: p.id,
        username: p.username ?? "",
        fullName: p.fullName ?? null,
        flag: p.countryFlag ?? "🏳️",
        avatarColor: p.avatarColor ?? "#00E676",
        avatarUrl: p.avatarUrl ?? null,
        avatarVersion: p.updatedAt?.getTime() ?? 0,
        friendStatus,
        requestId: isSent ? (sentMap.get(p.id) ?? null) : isReceived ? (receivedMap.get(p.id) ?? null) : null,
      };
    });

  return res.json({ users });
});

// ── POST /api/users/:userId/unblock ──────────────────────────────────────────
router.post("/users/:userId/unblock", requireAuth, async (req, res) => {
  const myId = (req as AuthenticatedRequest).descopeUserId;
  const targetId = String(req.params.userId);

  await db
    .delete(blockedUsersTable)
    .where(and(eq(blockedUsersTable.blockerId, myId), eq(blockedUsersTable.blockedId, targetId)));

  return res.json({ ok: true });
});

export default router;
