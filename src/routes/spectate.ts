import { Router } from "express";
import { db } from "../../db/src/index.js";
import {
  spectateSessionsTable,
  raceParticipantsTable,
  raceRoomsTable,
} from "../../db/src/schema/index.js";
import { and, eq } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import { z } from "zod";
import { grantCoinReward } from "../lib/coinRewardService.js";

const router = Router();

// ── POST /api/spectate/start ──────────────────────────────────────────────────
// Records the start of a spectate session. The client must call this when they
// open a race as a spectator. Returns a sessionId used to claim the reward.
router.post("/spectate/start", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = z.object({ raceRoomId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "raceRoomId required" });

  const { raceRoomId } = parsed.data;

  // Race must exist and be in progress
  const [room] = await db
    .select({ id: raceRoomsTable.id, status: raceRoomsTable.status })
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.id, raceRoomId))
    .limit(1);

  if (!room) return res.status(404).json({ error: "Race not found" });
  if (room.status !== "in_progress") {
    return res.status(400).json({ error: "Race is not currently in progress" });
  }

  // User must not be a participant (any status)
  const [participant] = await db
    .select({ id: raceParticipantsTable.id })
    .from(raceParticipantsTable)
    .where(
      and(
        eq(raceParticipantsTable.raceRoomId, raceRoomId),
        eq(raceParticipantsTable.userId, userId),
      ),
    )
    .limit(1);

  if (participant) {
    return res.status(400).json({ error: "Race participants cannot earn spectate rewards" });
  }

  const [session] = await db
    .insert(spectateSessionsTable)
    .values({ userId, raceRoomId })
    .returning();

  req.log.info({ userId, raceRoomId, sessionId: session.id }, "spectate session started");
  return res.json({ sessionId: session.id });
});

// ── POST /api/spectate/complete ───────────────────────────────────────────────
// Marks the spectate session as complete and grants +2 coins if the user
// watched for at least 60 seconds and has not already claimed this reward.
router.post("/spectate/complete", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = z.object({ sessionId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "sessionId required" });

  const { sessionId } = parsed.data;

  const [session] = await db
    .select()
    .from(spectateSessionsTable)
    .where(
      and(
        eq(spectateSessionsTable.id, sessionId),
        eq(spectateSessionsTable.userId, userId),
      ),
    )
    .limit(1);

  if (!session) return res.status(404).json({ error: "Session not found" });

  if (session.rewardGranted) {
    return res.json({ coinsEarned: 0, alreadyClaimed: true });
  }

  const now = new Date();
  const durationSeconds = (now.getTime() - session.startedAt.getTime()) / 1000;

  if (durationSeconds < 60) {
    await db
      .update(spectateSessionsTable)
      .set({ completedAt: now })
      .where(eq(spectateSessionsTable.id, sessionId));
    return res.json({
      coinsEarned: 0,
      message: `Watched ${Math.round(durationSeconds)}s — minimum 60s required`,
    });
  }

  // Key the reward on the RACE, not the session. grantCoinReward is idempotent
  // on (userId, rewardCode, sourceId); using sessionId let a user farm unlimited
  // rewards by opening many sessions for the same race. raceRoomId caps it to
  // one SPECTATE_MATCH reward per race.
  const coins = await grantCoinReward(userId, "SPECTATE_MATCH", session.raceRoomId, "Spectated a match");

  await db
    .update(spectateSessionsTable)
    .set({ completedAt: now, rewardGranted: coins != null && coins > 0 })
    .where(eq(spectateSessionsTable.id, sessionId));

  req.log.info({ userId, sessionId, durationSeconds: Math.round(durationSeconds), coins }, "spectate session completed");
  return res.json({ coinsEarned: coins ?? 0 });
});

export default router;
