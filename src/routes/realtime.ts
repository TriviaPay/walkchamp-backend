import { Router } from "express";
import { db } from "@db";
import { conversationsTable, raceParticipantsTable, scheduledRoomRegistrationsTable, spectateSessionsTable } from "@db/schema";
import { and, eq, or } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth";
import { getPusher, isPusherConfigured } from "../lib/pusher";
import { z } from "zod";
import { requireActiveAccount } from "../middleware/requireActiveAccount";

const router = Router();

// ── POST /api/realtime/pusher/auth ────────────────────────────────────────────
// Authenticates private and presence Pusher channels.
// Called automatically by the Pusher client SDK when subscribing to private/presence channels.
const pusherAuthSchema = z.object({
  socket_id: z.string(),
  channel_name: z.string(),
});

async function canAccessPrivateChat(userId: string, conversationId: string): Promise<boolean> {
  const [conversation] = await db
    .select({ id: conversationsTable.id })
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.id, conversationId),
        or(
          eq(conversationsTable.user1Id, userId),
          eq(conversationsTable.user2Id, userId),
        ),
      ),
    )
    .limit(1);

  return !!conversation;
}

async function canAccessRaceChannel(userId: string, raceId: string): Promise<boolean> {
  const [participant] = await db
    .select({ id: raceParticipantsTable.id })
    .from(raceParticipantsTable)
    .where(
      and(
        eq(raceParticipantsTable.raceRoomId, raceId),
        eq(raceParticipantsTable.userId, userId),
      ),
    )
    .limit(1);

  if (participant) return true;

  const [registration] = await db
    .select({ id: scheduledRoomRegistrationsTable.id })
    .from(scheduledRoomRegistrationsTable)
    .where(
      and(
        eq(scheduledRoomRegistrationsTable.raceRoomId, raceId),
        eq(scheduledRoomRegistrationsTable.userId, userId),
      ),
    )
    .limit(1);

  if (registration) return true;

  const [spectatorSession] = await db
    .select({ id: spectateSessionsTable.id })
    .from(spectateSessionsTable)
    .where(
      and(
        eq(spectateSessionsTable.raceRoomId, raceId),
        eq(spectateSessionsTable.userId, userId),
      ),
    )
    .limit(1);

  return !!spectatorSession;
}

router.post("/realtime/pusher/auth", requireAuth, requireActiveAccount, async (req, res) => {
  if (!isPusherConfigured()) {
    return res.status(503).json({ error: "Realtime not configured" });
  }

  const parsed = pusherAuthSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "socket_id and channel_name are required" });
  }

  const { socket_id, channel_name } = parsed.data;
  const userId = (req as AuthenticatedRequest).descopeUserId;

  // ── Channel access rules ────────────────────────────────────────────────────
  if (channel_name.startsWith("private-user-")) {
    const channelUserId = channel_name.replace("private-user-", "");
    if (channelUserId !== userId) {
      return res.status(403).json({ error: "Not authorized for this channel" });
    }
  } else if (channel_name.startsWith("private-chat-")) {
    const conversationId = channel_name.replace("private-chat-", "");
    if (!(await canAccessPrivateChat(userId, conversationId))) {
      return res.status(403).json({ error: "Not authorized for this conversation" });
    }
  } else if (channel_name.startsWith("private-race-")) {
    const raceId = channel_name.replace("private-race-", "");
    if (!(await canAccessRaceChannel(userId, raceId))) {
      return res.status(403).json({ error: "Not authorized for this race" });
    }
  } else if (channel_name === "presence-global-chat") {
    // Authenticated users may join shared presence channels.
  } else if (channel_name.startsWith("presence-race-")) {
    const raceId = channel_name.replace("presence-race-", "");
    if (!(await canAccessRaceChannel(userId, raceId))) {
      return res.status(403).json({ error: "Not authorized for this race" });
    }
  } else {
    return res.status(403).json({ error: "Unknown or unauthorized channel" });
  }

  const pusher = getPusher();

  if (channel_name.startsWith("presence-")) {
    // Presence channel auth — includes user info in the payload
    const presenceData = {
      user_id: userId,
      user_info: { userId },
    };
    const auth = pusher.authorizeChannel(socket_id, channel_name, presenceData);
    return res.json(auth);
  }

  // Private channel auth
  const auth = pusher.authorizeChannel(socket_id, channel_name);
  return res.json(auth);
});

export default router;
