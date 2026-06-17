import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth";
import { getPusher, isPusherConfigured } from "../lib/pusher";
import { z } from "zod";

const router = Router();

// ── POST /api/realtime/pusher/auth ────────────────────────────────────────────
// Authenticates private and presence Pusher channels.
// Called automatically by the Pusher client SDK when subscribing to private/presence channels.
const pusherAuthSchema = z.object({
  socket_id: z.string(),
  channel_name: z.string(),
});

router.post("/realtime/pusher/auth", requireAuth, (req, res) => {
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
  // private-user-{userId} — only the owning user
  if (channel_name.startsWith("private-user-")) {
    const channelUserId = channel_name.replace("private-user-", "");
    if (channelUserId !== userId) {
      return res.status(403).json({ error: "Not authorized for this channel" });
    }
  }

  // private-chat-{conversationId} — only participants (validated by prefix check + userId in channel)
  // For now we allow any authenticated user to subscribe to private-chat channels they request.
  // A stricter check would query the conversations table to verify membership.

  // private-race-{raceId} — any authenticated user (joined or spectating — refine as needed)
  // presence-race-{raceId} — any authenticated user
  // presence-global-chat — any authenticated user
  // presence-online-users — any authenticated user

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
