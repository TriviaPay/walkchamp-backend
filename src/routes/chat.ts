import { Router } from "express";
import { db } from "../../db/src/index.js";
import {
  globalChatMessagesTable,
  profilesTable,
  conversationsTable,
  privateChatMessagesTable,
  friendsTable,
  friendRequestsTable,
  chatReactionsTable,
  userPresenceTable,
} from "../../db/src/schema/index.js";
import { eq, and, desc, or, sql, inArray, lt } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import { triggerEvent } from "../lib/pusher.js";
import { z } from "zod";
import { sanitizePlainText } from "../lib/text.js";
import { config } from "../lib/config.js";
import { notifyChatMessageReceived } from "../lib/pushNotificationService.js";

const router = Router();

const MAX_MESSAGE_LENGTH = 300;
const CHAT_PAGE_SIZE = 50;
const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏", "😁", "🔥", "👏"];

// ── GET /api/chat/global ──────────────────────────────────────────────────────
// Supports cursor pagination via ?before=<ISO-timestamp> (exclusive upper bound).
// Client fetches next page by passing the `nextCursor` from the previous response.
router.get("/chat/global", requireAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || CHAT_PAGE_SIZE, config.runtime.maxPaginationLimit);
  const before = req.query.before as string | undefined;
  const beforeDate = before ? new Date(before) : null;

  const rows = await db
    .select()
    .from(globalChatMessagesTable)
    .where(
      beforeDate
        ? and(eq(globalChatMessagesTable.isDeleted, false), lt(globalChatMessagesTable.createdAt, beforeDate))
        : eq(globalChatMessagesTable.isDeleted, false),
    )
    .orderBy(desc(globalChatMessagesTable.createdAt))
    .limit(limit);

  const msgIds = rows.map((m) => m.id);
  const reactions = msgIds.length
    ? await db
        .select()
        .from(chatReactionsTable)
        .where(and(inArray(chatReactionsTable.messageId, msgIds), eq(chatReactionsTable.messageType, "global")))
    : [];

  const reactionsByMsg = groupReactions(reactions);

  // Build reply preview map
  const replyIds = rows.map((m) => m.replyToId).filter(Boolean) as string[];
  const replyMap = await buildReplyMap(replyIds, "global");

  // Batch-fetch current avatarUrl for each unique author
  const authorIds = [...new Set(rows.map((m) => m.userId))];
  const authorProfiles = authorIds.length
    ? await db
        .select({ id: profilesTable.id, avatarUrl: profilesTable.avatarUrl, updatedAt: profilesTable.updatedAt })
        .from(profilesTable)
        .where(inArray(profilesTable.id, authorIds))
    : [];
  const avatarUrlMap = Object.fromEntries(authorProfiles.map((p) => [p.id, p.avatarUrl ?? null]));
  const avatarVersionMap = Object.fromEntries(authorProfiles.map((p) => [p.id, p.updatedAt?.getTime() ?? 0]));

  const nextCursor =
    rows.length === limit && rows.length > 0
      ? rows[rows.length - 1].createdAt.toISOString()
      : null;

  return res.json({
    messages: rows.reverse().map((m) => ({
      id: m.id,
      userId: m.userId,
      username: m.username,
      flag: m.countryFlag,
      avatarColor: m.avatarColor,
      avatarUrl: avatarUrlMap[m.userId] ?? null,
      avatarVersion: avatarVersionMap[m.userId] ?? 0,
      text: m.text,
      time: formatTime(m.createdAt),
      createdAt: m.createdAt.toISOString(),
      replyToId: m.replyToId ?? null,
      replyPreview: m.replyToId ? replyMap[m.replyToId] ?? null : null,
      reactions: reactionsByMsg[m.id] ?? {},
    })),
    nextCursor,
  });
});

// ── POST /api/chat/global ─────────────────────────────────────────────────────
const sendGlobalSchema = z.object({
  text: z.string().min(1).max(MAX_MESSAGE_LENGTH).trim(),
  replyToId: z.string().min(1).optional(),
});

router.post("/chat/global", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = sendGlobalSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid message" });
  const text = sanitizePlainText(parsed.data.text);
  if (!text) return res.status(400).json({ error: "Invalid message" });

  const [profile] = await db
    .select({
      username: profilesTable.username,
      countryFlag: profilesTable.countryFlag,
      avatarColor: profilesTable.avatarColor,
      avatarUrl: profilesTable.avatarUrl,
      accountStatus: profilesTable.accountStatus,
    })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);

  if (!profile) return res.status(404).json({ error: "Profile not found" });
  if (profile.accountStatus === "suspended" || profile.accountStatus === "banned") {
    return res.status(403).json({ error: "Account is restricted from chat." });
  }

  const [msg] = await db
    .insert(globalChatMessagesTable)
    .values({
      userId,
      username: profile.username,
      countryFlag: profile.countryFlag ?? "🏳️",
      avatarColor: profile.avatarColor ?? "#00E676",
      text,
      replyToId: parsed.data.replyToId ?? null,
    })
    .returning();

  let replyPreview: { username: string; text: string } | null = null;
  if (msg.replyToId) {
    const map = await buildReplyMap([msg.replyToId], "global");
    replyPreview = map[msg.replyToId] ?? null;
  }

  const payload = {
    id: msg.id,
    userId: msg.userId,
    username: msg.username,
    flag: msg.countryFlag,
    avatarColor: msg.avatarColor,
    avatarUrl: profile.avatarUrl ?? null,
    text: msg.text,
    time: formatTime(msg.createdAt),
    createdAt: msg.createdAt.toISOString(),
    replyToId: msg.replyToId ?? null,
    replyPreview,
    reactions: {},
  };

  await triggerEvent("public-global-chat", "chat:new_message", payload);
  return res.status(201).json({ message: payload });
});

// ── POST /api/chat/global/react ───────────────────────────────────────────────
router.post("/chat/global/react", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = z.object({ messageId: z.string().min(1), emoji: z.string() }).safeParse(req.body);
  if (!parsed.success || !REACTION_EMOJIS.includes(parsed.data.emoji)) {
    return res.status(400).json({ error: "Invalid reaction" });
  }

  await db
    .insert(chatReactionsTable)
    .values({ messageId: parsed.data.messageId, messageType: "global", userId, emoji: parsed.data.emoji })
    .onConflictDoUpdate({
      target: [chatReactionsTable.messageId, chatReactionsTable.messageType, chatReactionsTable.userId],
      set: { emoji: parsed.data.emoji },
    });

  const reactions = await getReactionsForMessage(parsed.data.messageId, "global");
  await triggerEvent("public-global-chat", "chat:reactions_updated", { messageId: parsed.data.messageId, reactions });
  return res.json({ reactions });
});

// ── DELETE /api/chat/global/react ─────────────────────────────────────────────
router.delete("/chat/global/react", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = z.object({ messageId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "messageId required" });

  await db
    .delete(chatReactionsTable)
    .where(
      and(
        eq(chatReactionsTable.messageId, parsed.data.messageId),
        eq(chatReactionsTable.messageType, "global"),
        eq(chatReactionsTable.userId, userId),
      ),
    );

  const reactions = await getReactionsForMessage(parsed.data.messageId, "global");
  await triggerEvent("public-global-chat", "chat:reactions_updated", { messageId: parsed.data.messageId, reactions });
  return res.json({ reactions });
});

// ── GET /api/chat/private/conversations ──────────────────────────────────────
router.get("/chat/private/conversations", requireAuth, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const convs = await db
    .select()
    .from(conversationsTable)
    .where(or(eq(conversationsTable.user1Id, userId), eq(conversationsTable.user2Id, userId)))
    .orderBy(desc(conversationsTable.lastMessageAt));

  if (convs.length === 0) return res.json({ conversations: [] });

  const result = await Promise.all(
    convs.map(async (conv) => {
      const friendId = conv.user1Id === userId ? conv.user2Id : conv.user1Id;

      const [profile] = await db
        .select({
          username: profilesTable.username,
          countryFlag: profilesTable.countryFlag,
          avatarColor: profilesTable.avatarColor,
          avatarUrl: profilesTable.avatarUrl,
          updatedAt: profilesTable.updatedAt,
        })
        .from(profilesTable)
        .where(eq(profilesTable.id, friendId))
        .limit(1);

      const [lastMsg] = await db
        .select({ text: privateChatMessagesTable.text, senderId: privateChatMessagesTable.senderId })
        .from(privateChatMessagesTable)
        .where(
          and(eq(privateChatMessagesTable.conversationId, conv.id), eq(privateChatMessagesTable.isDeleted, false)),
        )
        .orderBy(desc(privateChatMessagesTable.createdAt))
        .limit(1);

      const [unreadRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(privateChatMessagesTable)
        .where(
          and(
            eq(privateChatMessagesTable.conversationId, conv.id),
            eq(privateChatMessagesTable.recipientId, userId),
            eq(privateChatMessagesTable.isRead, false),
            eq(privateChatMessagesTable.isDeleted, false),
          ),
        );

      const [presence] = await db
        .select({ lastSeenAt: userPresenceTable.lastSeenAt })
        .from(userPresenceTable)
        .where(eq(userPresenceTable.userId, friendId))
        .limit(1);

      const onlineAfter = new Date(Date.now() - 90_000);

      return {
        conversationId: conv.id,
        friendId,
        friendUsername: profile?.username ?? "Unknown",
        friendFlag: profile?.countryFlag ?? "🏳️",
        friendAvatarColor: profile?.avatarColor ?? "#00E676",
        friendAvatarUrl: profile?.avatarUrl ?? null,
        friendAvatarVersion: profile?.updatedAt?.getTime() ?? 0,
        lastMessage: lastMsg?.text ?? null,
        lastMessageAt: conv.lastMessageAt?.toISOString() ?? null,
        unreadCount: unreadRow?.count ?? 0,
        isOnline: presence?.lastSeenAt != null && presence.lastSeenAt >= onlineAfter,
      };
    }),
  );

  return res.json({ conversations: result });
});

// ── GET /api/chat/private/:friendId ──────────────────────────────────────────
// Supports cursor pagination via ?before=<ISO-timestamp> (exclusive upper bound).
router.get("/chat/private/:friendId", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const friendId = String(req.params.friendId);
  const limit = Math.min(Number(req.query.limit) || CHAT_PAGE_SIZE, config.runtime.maxPaginationLimit);
  const before = req.query.before as string | undefined;
  const beforeDate = before ? new Date(before) : null;

  const [friendship] = await db
    .select()
    .from(friendsTable)
    .where(and(eq(friendsTable.userId, userId), eq(friendsTable.friendId, friendId)))
    .limit(1);

  if (!friendship) return res.status(403).json({ error: "You must be friends to view this conversation." });

  const conv = await getOrCreateConversation(userId, friendId);

  // Mark as read
  await db
    .update(privateChatMessagesTable)
    .set({ isRead: true })
    .where(
      and(
        eq(privateChatMessagesTable.conversationId, conv.id),
        eq(privateChatMessagesTable.recipientId, userId),
        eq(privateChatMessagesTable.isRead, false),
      ),
    );

  const rows = await db
    .select()
    .from(privateChatMessagesTable)
    .where(
      beforeDate
        ? and(
            eq(privateChatMessagesTable.conversationId, conv.id),
            eq(privateChatMessagesTable.isDeleted, false),
            lt(privateChatMessagesTable.createdAt, beforeDate),
          )
        : and(eq(privateChatMessagesTable.conversationId, conv.id), eq(privateChatMessagesTable.isDeleted, false)),
    )
    .orderBy(desc(privateChatMessagesTable.createdAt))
    .limit(limit);

  const msgIds = rows.map((m) => m.id);
  const reactions = msgIds.length
    ? await db
        .select()
        .from(chatReactionsTable)
        .where(and(inArray(chatReactionsTable.messageId, msgIds), eq(chatReactionsTable.messageType, "private")))
    : [];

  const reactionsByMsg = groupReactions(reactions);

  const replyIds = rows.map((m) => m.replyToId).filter(Boolean) as string[];
  const replyMap = await buildReplyMap(replyIds, "private");

  const nextCursor =
    rows.length === limit && rows.length > 0
      ? rows[rows.length - 1].createdAt.toISOString()
      : null;

  return res.json({
    conversationId: conv.id,
    messages: rows.reverse().map((m) => ({
      id: m.id,
      senderId: m.senderId,
      recipientId: m.recipientId,
      text: m.text,
      isRead: m.isRead,
      createdAt: m.createdAt.toISOString(),
      time: formatTime(m.createdAt),
      replyToId: m.replyToId ?? null,
      replyPreview: m.replyToId ? replyMap[m.replyToId] ?? null : null,
      reactions: reactionsByMsg[m.id] ?? {},
    })),
    nextCursor,
  });
});

// ── POST /api/chat/private/:friendId ─────────────────────────────────────────
const sendPrivateSchema = z.object({
  text: z.string().min(1).max(MAX_MESSAGE_LENGTH).trim(),
  replyToId: z.string().min(1).optional(),
});

router.post("/chat/private/:friendId", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const friendId = String(req.params.friendId);

  const parsed = sendPrivateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid message" });
  const text = sanitizePlainText(parsed.data.text);
  if (!text) return res.status(400).json({ error: "Invalid message" });

  const [friendship] = await db
    .select()
    .from(friendsTable)
    .where(and(eq(friendsTable.userId, userId), eq(friendsTable.friendId, friendId)))
    .limit(1);

  if (!friendship) return res.status(403).json({ error: "You must be friends to send messages." });

  const conv = await getOrCreateConversation(userId, friendId);

  const [msg] = await db.transaction(async (tx) => {
    const [m] = await tx
      .insert(privateChatMessagesTable)
      .values({
        conversationId: conv.id,
        senderId: userId,
        recipientId: friendId,
        text,
        replyToId: parsed.data.replyToId ?? null,
      })
      .returning();

    await tx
      .update(conversationsTable)
      .set({ lastMessageAt: new Date() })
      .where(eq(conversationsTable.id, conv.id));

    return [m];
  });

  let replyPreview: { username: string; text: string } | null = null;
  if (msg.replyToId) {
    const map = await buildReplyMap([msg.replyToId], "private");
    replyPreview = map[msg.replyToId] ?? null;
  }

  const [senderProfile] = await db
    .select({ username: profilesTable.username })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);

  const payload = {
    id: msg.id,
    conversationId: msg.conversationId,
    senderId: msg.senderId,
    recipientId: msg.recipientId,
    text: msg.text,
    createdAt: msg.createdAt.toISOString(),
    time: formatTime(msg.createdAt),
    replyToId: msg.replyToId ?? null,
    replyPreview,
    reactions: {},
    senderUsername: senderProfile?.username ?? "Unknown",
  };

  await triggerEvent(`private-chat-${conv.id}`, "chat:new_message", payload);
  await triggerEvent(`private-user-${friendId}`, "chat:new_message", { ...payload, isPrivate: true });

  void notifyChatMessageReceived({
    conversationId: conv.id,
    messageId: msg.id,
    senderUserId: userId,
    senderUsername: senderProfile?.username ?? "Someone",
    receiverUserId: friendId,
    messagePreview: text,
  });

  return res.status(201).json({ message: payload });
});

// ── POST /api/chat/private/react ──────────────────────────────────────────────
router.post("/chat/private/react", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = z.object({ messageId: z.string().min(1), emoji: z.string(), conversationId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success || !REACTION_EMOJIS.includes(parsed.data.emoji)) {
    return res.status(400).json({ error: "Invalid reaction" });
  }

  // Verify the caller is a member of the conversation AND that the message
  // actually belongs to it, before writing a reaction or broadcasting to the
  // conversation channel. Otherwise any user could pollute reactions and spam
  // realtime events on conversations they are not part of.
  const [conv] = await db
    .select({ id: conversationsTable.id })
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.id, parsed.data.conversationId),
        or(eq(conversationsTable.user1Id, userId), eq(conversationsTable.user2Id, userId)),
      ),
    )
    .limit(1);
  if (!conv) return res.status(403).json({ error: "Not a member of this conversation" });

  const [message] = await db
    .select({ id: privateChatMessagesTable.id })
    .from(privateChatMessagesTable)
    .where(
      and(
        eq(privateChatMessagesTable.id, parsed.data.messageId),
        eq(privateChatMessagesTable.conversationId, parsed.data.conversationId),
      ),
    )
    .limit(1);
  if (!message) return res.status(404).json({ error: "Message not found in this conversation" });

  await db
    .insert(chatReactionsTable)
    .values({ messageId: parsed.data.messageId, messageType: "private", userId, emoji: parsed.data.emoji })
    .onConflictDoUpdate({
      target: [chatReactionsTable.messageId, chatReactionsTable.messageType, chatReactionsTable.userId],
      set: { emoji: parsed.data.emoji },
    });

  const reactions = await getReactionsForMessage(parsed.data.messageId, "private");
  await triggerEvent(`private-chat-${parsed.data.conversationId}`, "chat:reactions_updated", {
    messageId: parsed.data.messageId,
    reactions,
  });
  return res.json({ reactions });
});

// ── DELETE /api/chat/private/conversations/:conversationId ────────────────────
router.delete("/chat/private/conversations/:conversationId", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const conversationId = String(req.params.conversationId);

  const [conv] = await db
    .select({ id: conversationsTable.id })
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.id, conversationId),
        or(eq(conversationsTable.user1Id, userId), eq(conversationsTable.user2Id, userId)),
      ),
    )
    .limit(1);

  if (!conv) return res.status(404).json({ error: "Conversation not found" });

  try {
    await db.transaction(async (tx) => {
      await tx.delete(privateChatMessagesTable).where(eq(privateChatMessagesTable.conversationId, conversationId));
      await tx.delete(conversationsTable).where(eq(conversationsTable.id, conversationId));
    });
  } catch (err) {
    req.log.error({ err }, "[PrivateChatDelete] delete conversation failed");
    return res.status(500).json({ error: "Failed to delete conversation" });
  }

  req.log.info({ conversationId }, "[PrivateChatDelete] backend success");
  return res.json({ success: true, conversationId, deleted: true, message: "Private chat deleted successfully." });
});

// ── DELETE /api/chat/private/react ────────────────────────────────────────────
router.delete("/chat/private/react", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = z.object({ messageId: z.string().min(1), conversationId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "messageId required" });

  await db
    .delete(chatReactionsTable)
    .where(
      and(
        eq(chatReactionsTable.messageId, parsed.data.messageId),
        eq(chatReactionsTable.messageType, "private"),
        eq(chatReactionsTable.userId, userId),
      ),
    );

  const reactions = await getReactionsForMessage(parsed.data.messageId, "private");
  await triggerEvent(`private-chat-${parsed.data.conversationId}`, "chat:reactions_updated", {
    messageId: parsed.data.messageId,
    reactions,
  });
  return res.json({ reactions });
});

// ── GET /api/races/:id/comments ───────────────────────────────────────────────
router.get("/races/:id/comments", requireAuth, async (req, res) => {
  const { liveRaceCommentsTable } = await import("../../db/src/schema/index.js");
  const raceId = String(req.params.id);
  const limit = Math.min(Number(req.query.limit) || 50, config.runtime.maxPaginationLimit);

  const rows = await db
    .select()
    .from(liveRaceCommentsTable)
    .where(eq(liveRaceCommentsTable.raceRoomId, raceId))
    .orderBy(desc(liveRaceCommentsTable.createdAt))
    .limit(limit);

  return res.json({
    comments: rows.reverse().map((c) => ({
      id: c.id,
      username: c.username,
      countryFlag: c.countryFlag,
      avatarColor: c.avatarColor,
      text: c.text,
      timestamp: formatRelative(c.createdAt),
    })),
  });
});

// ── POST /api/races/:id/comments ──────────────────────────────────────────────
router.post("/races/:id/comments", requireAuth, async (req, res) => {
  const { liveRaceCommentsTable } = await import("../../db/src/schema/index.js");
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const raceId = String(req.params.id);

  const parsed = z.object({ text: z.string().min(1).max(300).trim() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid comment" });
  const text = sanitizePlainText(parsed.data.text);
  if (!text) return res.status(400).json({ error: "Invalid comment" });

  const [profile] = await db
    .select({ username: profilesTable.username, countryFlag: profilesTable.countryFlag, avatarColor: profilesTable.avatarColor })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);

  if (!profile) return res.status(404).json({ error: "Profile not found" });

  const [comment] = await db
    .insert(liveRaceCommentsTable)
    .values({
      raceRoomId: raceId,
      userId,
      username: profile.username,
      countryFlag: profile.countryFlag ?? "🏳️",
      avatarColor: profile.avatarColor ?? "#00E676",
      text,
    })
    .returning();

  const payload = {
    id: comment.id,
    username: comment.username,
    countryFlag: comment.countryFlag,
    avatarColor: comment.avatarColor,
    text: comment.text,
    timestamp: "just now",
  };

  await triggerEvent(`public-live-race-${raceId}`, "race:comment_added", payload);
  return res.status(201).json({ comment: payload });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getOrCreateConversation(userA: string, userB: string) {
  const [u1, u2] = [userA, userB].sort();

  const [existing] = await db
    .select()
    .from(conversationsTable)
    .where(and(eq(conversationsTable.user1Id, u1), eq(conversationsTable.user2Id, u2)))
    .limit(1);

  if (existing) return existing;

  const [created] = await db.insert(conversationsTable).values({ user1Id: u1, user2Id: u2 }).returning();
  return created;
}

function groupReactions(rows: { messageId: string; emoji: string }[]): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    if (!result[r.messageId]) result[r.messageId] = {};
    result[r.messageId][r.emoji] = (result[r.messageId][r.emoji] ?? 0) + 1;
  }
  return result;
}

async function getReactionsForMessage(messageId: string, type: "global" | "private"): Promise<Record<string, number>> {
  const rows = await db
    .select({ emoji: chatReactionsTable.emoji })
    .from(chatReactionsTable)
    .where(and(eq(chatReactionsTable.messageId, messageId), eq(chatReactionsTable.messageType, type)));

  const result: Record<string, number> = {};
  for (const r of rows) result[r.emoji] = (result[r.emoji] ?? 0) + 1;
  return result;
}

async function buildReplyMap(
  ids: string[],
  type: "global" | "private",
): Promise<Record<string, { username: string; text: string }>> {
  if (!ids.length) return {};
  const map: Record<string, { username: string; text: string }> = {};

  if (type === "global") {
    const rows = await db
      .select({ id: globalChatMessagesTable.id, username: globalChatMessagesTable.username, text: globalChatMessagesTable.text })
      .from(globalChatMessagesTable)
      .where(inArray(globalChatMessagesTable.id, ids));
    for (const r of rows) map[r.id] = { username: r.username, text: r.text.slice(0, 80) };
  } else {
    const rows = await db
      .select({ id: privateChatMessagesTable.id, senderId: privateChatMessagesTable.senderId, text: privateChatMessagesTable.text })
      .from(privateChatMessagesTable)
      .where(inArray(privateChatMessagesTable.id, ids));
    const senderIds = [...new Set(rows.map((r) => r.senderId))];
    const profiles = senderIds.length
      ? await db
          .select({ id: profilesTable.id, username: profilesTable.username })
          .from(profilesTable)
          .where(inArray(profilesTable.id, senderIds))
      : [];
    const profileMap = Object.fromEntries(profiles.map((p) => [p.id, p.username]));
    for (const r of rows) map[r.id] = { username: profileMap[r.senderId] ?? "Unknown", text: r.text.slice(0, 80) };
  }

  return map;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatRelative(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 5000) return "just now";
  if (diffMs < 60000) return `${Math.floor(diffMs / 1000)}s ago`;
  if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m ago`;
  return `${Math.floor(diffMs / 3600000)}h ago`;
}

// ── GET /api/chat/summary ─────────────────────────────────────────────────────
router.get("/chat/summary", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const [privRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(privateChatMessagesTable)
    .where(
      and(
        eq(privateChatMessagesTable.recipientId, userId),
        eq(privateChatMessagesTable.isRead, false),
        eq(privateChatMessagesTable.isDeleted, false),
      ),
    );

  // Only count unseen pending requests (seenAt IS NULL = user hasn't viewed the request list)
  const [reqRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(friendRequestsTable)
    .where(
      and(
        eq(friendRequestsTable.recipientId, userId),
        eq(friendRequestsTable.status, "pending"),
        sql`${friendRequestsTable.seenAt} IS NULL`,
      ),
    );

  const privateUnread = privRow?.count ?? 0;
  const requestCount = reqRow?.count ?? 0;

  return res.json({
    privateUnread,
    requestCount,
    total: privateUnread + requestCount,
  });
});

export default router;
