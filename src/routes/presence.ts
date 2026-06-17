import { Router } from "express";
import { db } from "@db";
import { userPresenceTable, profilesTable, raceRoomsTable, raceParticipantsTable } from "@db/schema";
import { eq, gte, ne, inArray, sql } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth";
import { triggerEvent } from "../lib/pusher";
import { z } from "zod";

const router = Router();

// Online  = last_seen_at within 90 seconds
// Walking = last_walk_activity_at within 5 minutes
// Racing  = participant in an in_progress race (computed from race tables, not flags)
const ONLINE_THRESHOLD_MS  = 90_000;
const WALKING_THRESHOLD_MS = 5 * 60_000;

function onlineAfter():  Date { return new Date(Date.now() - ONLINE_THRESHOLD_MS); }
function walkingAfter(): Date { return new Date(Date.now() - WALKING_THRESHOLD_MS); }

// ── Shared count calculator ────────────────────────────────────────────────────
async function computeCounts() {
  // 1. Online: users with recent heartbeat
  const onlineRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userPresenceTable)
    .where(gte(userPresenceTable.lastSeenAt, onlineAfter()));
  const online = onlineRows[0]?.count ?? 0;

  // 2. Walking: users who had step activity in the last 5 minutes
  const walkingRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userPresenceTable)
    .where(gte(userPresenceTable.lastWalkActivityAt, walkingAfter()));
  const walking = walkingRows[0]?.count ?? 0;

  // 3. Racing: distinct participants in active (in_progress) races who haven't left
  const racingRows = await db
    .selectDistinct({ userId: raceParticipantsTable.userId })
    .from(raceParticipantsTable)
    .innerJoin(raceRoomsTable, eq(raceParticipantsTable.raceRoomId, raceRoomsTable.id))
    .where(
      sql`${raceRoomsTable.status} = 'in_progress' AND ${raceParticipantsTable.status} != 'left'`,
    );
  const racing = racingRows.length;

  // 4. Active races count (for context)
  const activeRacesRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.status, "in_progress"));
  const activeRaces = activeRacesRows[0]?.count ?? 0;

  return { online, walking, racing, activeRaces };
}

// ── GET /api/presence/online-ids ──────────────────────────────────────────────
// Returns the array of user IDs with a heartbeat in the last 90 seconds.
// Used by global chat to show per-user online/offline dots.
router.get("/presence/online-ids", requireAuth, async (_req, res) => {
  const rows = await db
    .select({ userId: userPresenceTable.userId })
    .from(userPresenceTable)
    .where(gte(userPresenceTable.lastSeenAt, onlineAfter()));
  return res.json({ userIds: rows.map((r) => r.userId) });
});

// ── GET /api/presence/summary ─────────────────────────────────────────────────
router.get("/presence/summary", requireAuth, async (_req, res) => {
  const { online, walking, racing } = await computeCounts();
  return res.json({
    counts: { online, walking, racing, spectating: 0 },
  });
});

// ── GET /api/activity/summary ─────────────────────────────────────────────────
router.get("/activity/summary", requireAuth, async (_req, res) => {
  const { online, walking, racing, activeRaces } = await computeCounts();
  return res.json({
    online_count: online,
    walking_count: walking,
    racing_live_count: racing,
    active_races_count: activeRaces,
    updated_at: new Date().toISOString(),
  });
});

// ── POST /api/presence/heartbeat ──────────────────────────────────────────────
const heartbeatSchema = z.object({
  status: z.enum(["online", "walking", "racing", "spectating", "away"]).default("online"),
});

router.post("/presence/heartbeat", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = heartbeatSchema.safeParse(req.body);
  const status = parsed.success ? parsed.data.status : "online";
  const now = new Date();

  await db
    .insert(userPresenceTable)
    .values({ userId, status, lastSeenAt: now })
    .onConflictDoUpdate({
      target: [userPresenceTable.userId],
      set: { status, lastSeenAt: now },
    });

  // Broadcast updated summary (fire and forget)
  computeCounts()
    .then(({ online, walking, racing }) => {
      const counts = { online, walking, racing, spectating: 0 };
      return triggerEvent("public-presence", "presence:summary_updated", { counts });
    })
    .catch(() => {});

  return res.json({ ok: true, status });
});

// ── POST /api/presence/offline ────────────────────────────────────────────────
router.post("/presence/offline", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  await db
    .update(userPresenceTable)
    .set({ status: "offline" })
    .where(eq(userPresenceTable.userId, userId));
  return res.json({ ok: true });
});

export default router;
