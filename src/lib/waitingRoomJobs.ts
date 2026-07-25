import { and, eq, inArray, lt, lte, ne, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import { raceRoomsTable, scheduledRoomRegistrationsTable } from "../../db/src/schema/races.js";
import { activateRoomAndStart } from "../routes/races.js";
import { terminateWaitingRoom } from "./waitingRoom.js";
import { sendNotification } from "../routes/notifications.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * Orchestration for the shared Waiting Room lifecycle: scheduled auto-start, open-window expiry,
 * the T-30 reminder, and a reconciliation sweep that recovers rooms whose durable job was missed
 * (worker restart/outage/multi-worker race). Every function is idempotent — the underlying
 * activate/terminate transitions are compare-and-set, so duplicate firings never double-process.
 *
 * Lives separate from waitingRoom.ts because it imports the race activation path (routes/races.ts);
 * routes/races.ts must not import this module (keeps the dependency graph acyclic).
 */

const STUCK_STARTING_GRACE_MS = 2 * 60_000;

/** Count distinct still-registered users for a scheduled room. */
async function countRegisteredParticipants(roomId: string): Promise<number> {
  const [{ cnt }] = await db
    .select({ cnt: sql<number>`count(distinct ${scheduledRoomRegistrationsTable.userId})::int` })
    .from(scheduledRoomRegistrationsTable)
    .where(and(
      eq(scheduledRoomRegistrationsTable.raceRoomId, roomId),
      eq(scheduledRoomRegistrationsTable.status, "registered"),
    ));
  return cnt ?? 0;
}

/**
 * At scheduledStartAt: if enough players registered, atomically auto-start into an active race
 * (charging paid entries once); otherwise cancel with MINIMUM_PARTICIPANTS_NOT_MET. Idempotent.
 */
export async function evaluateScheduledStart(roomId: string): Promise<void> {
  const [room] = await db.select().from(raceRoomsTable).where(eq(raceRoomsTable.id, roomId)).limit(1);
  if (!room || room.status !== "scheduled") return; // already started/cancelled/expired

  const minimum = room.minimumParticipants ?? config.waitingRoom.minimumParticipants;
  const registered = await countRegisteredParticipants(roomId);

  if (registered >= minimum) {
    const result = await activateRoomAndStart(roomId, { fromStatuses: ["scheduled"], materializeRegistrations: true });
    if (!result.ok) {
      // Charge failure reverts the claim back to "scheduled"; the reconciler will retry.
      logger.error({ roomId, body: result.body }, "[WaitingRoom] scheduled auto-start failed; will retry via reconciler");
    } else {
      logger.info({ roomId, registered }, "[WaitingRoom] scheduled room auto-started");
    }
  } else {
    await terminateWaitingRoom(roomId, { terminalStatus: "cancelled", reason: "MINIMUM_PARTICIPANTS_NOT_MET" });
    logger.info({ roomId, registered, minimum }, "[WaitingRoom] scheduled room cancelled — minimum not met");
  }
}

/**
 * At roomExpiresAt: if an open-window room never started, close it. Reason distinguishes whether
 * the minimum was never met vs. met-but-host-never-started. Never auto-starts the race. Idempotent.
 */
export async function expireOpenWindow(roomId: string): Promise<void> {
  const [room] = await db.select().from(raceRoomsTable).where(eq(raceRoomsTable.id, roomId)).limit(1);
  if (!room) return;
  if (room.status !== "open" && room.status !== "full") return; // started / starting / terminal
  if (room.roomExpiresAt && Date.now() < room.roomExpiresAt.getTime()) return; // too early

  const minimum = room.minimumParticipants ?? config.waitingRoom.minimumParticipants;
  const reason = room.currentPlayers >= minimum
    ? "HOST_DID_NOT_START_BEFORE_EXPIRATION"
    : "MINIMUM_PARTICIPANTS_NOT_MET";
  await terminateWaitingRoom(roomId, { terminalStatus: "expired", reason });
}

/** Optional T-30 reminder for scheduled rooms. Deduped per room. */
export async function sendScheduledReminder(roomId: string): Promise<void> {
  const [room] = await db.select().from(raceRoomsTable).where(eq(raceRoomsTable.id, roomId)).limit(1);
  if (!room || room.status !== "scheduled") return;
  const regs = await db
    .select({ userId: scheduledRoomRegistrationsTable.userId })
    .from(scheduledRoomRegistrationsTable)
    .where(and(eq(scheduledRoomRegistrationsTable.raceRoomId, roomId), eq(scheduledRoomRegistrationsTable.status, "registered")));
  for (const userId of [...new Set(regs.map((r) => r.userId))]) {
    sendNotification(userId, "race_starting", "Your race starts soon", "Your race starts in 30 minutes.", {
      raceId: roomId,
      dedupeKey: `scheduled_reminder:${roomId}`,
    }).catch(() => {});
  }
}

/**
 * Periodic reconciliation. Recovers rooms whose durable job never ran (missed/crashed/multi-worker):
 * scheduled rooms past their start time, open-window rooms past expiry, and rooms stuck mid-start.
 * All handlers are idempotent so this is safe to run alongside the delayed jobs.
 */
export async function reconcileWaitingRooms(now: Date = new Date()): Promise<void> {
  try {
    const dueScheduled = await db
      .select({ id: raceRoomsTable.id })
      .from(raceRoomsTable)
      .where(and(
        eq(raceRoomsTable.status, "scheduled"),
        ne(raceRoomsTable.type, "sponsored"),
        lte(raceRoomsTable.scheduledStartAt, now),
      ));
    for (const room of dueScheduled) await evaluateScheduledStart(room.id);

    const dueExpiry = await db
      .select({ id: raceRoomsTable.id })
      .from(raceRoomsTable)
      .where(and(
        inArray(raceRoomsTable.status, ["open", "full"]),
        eq(raceRoomsTable.mode, "open_window"),
        lte(raceRoomsTable.roomExpiresAt, now),
      ));
    for (const room of dueExpiry) await expireOpenWindow(room.id);

    // Rooms stuck in "starting" (process died mid-charge) → revert to a startable status so the
    // host can retry or the window can expire. Uses the frozen currentPlayers to pick open/full.
    const stuckCutoff = new Date(now.getTime() - STUCK_STARTING_GRACE_MS);
    await db
      .update(raceRoomsTable)
      .set({ status: sql`case when ${raceRoomsTable.currentPlayers} >= ${raceRoomsTable.maxPlayers} then 'full'::race_status else 'open'::race_status end`, updatedAt: now })
      .where(and(eq(raceRoomsTable.status, "starting"), lt(raceRoomsTable.updatedAt, stuckCutoff)));
  } catch (err) {
    logger.error({ err }, "[WaitingRoom] reconcile tick failed");
  }
}
