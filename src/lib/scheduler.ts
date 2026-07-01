import { db } from "@db";
import { raceRoomsTable, raceParticipantsTable, scheduledRoomRegistrationsTable } from "@db/schema";
import { eq, and, lte, sql, ne } from "drizzle-orm";
import { triggerEvent } from "./pusher.js";
import { logger } from "./logger.js";
import { deriveOpenRoomStatus, joinOrReviveParticipant, lockRaceRoom } from "./raceIntegrity.js";

async function startScheduledRoom(roomId: string): Promise<void> {
  try {
    let regs: Array<{ userId: string }> = [];
    let finalStatus: "open" | "full" | "cancelled" = "cancelled";
    let playerCount = 0;

    const now = new Date();
    await db.transaction(async (tx) => {
      const room = await lockRaceRoom(tx, roomId);
      if (!room || room.status !== "scheduled") return;

      regs = await tx
        .select({ userId: scheduledRoomRegistrationsTable.userId })
        .from(scheduledRoomRegistrationsTable)
        .where(
          and(
            eq(scheduledRoomRegistrationsTable.raceRoomId, roomId),
            eq(scheduledRoomRegistrationsTable.status, "registered"),
          ),
        );

      if (regs.length < 2) {
        await tx
          .update(raceRoomsTable)
          .set({ status: "cancelled", updatedAt: now })
          .where(eq(raceRoomsTable.id, roomId));
        finalStatus = "cancelled";
        return;
      }

      await tx
        .update(scheduledRoomRegistrationsTable)
        .set({ status: "activated", activatedAt: now })
        .where(
          and(
            eq(scheduledRoomRegistrationsTable.raceRoomId, roomId),
            eq(scheduledRoomRegistrationsTable.status, "registered"),
          ),
        );

      let activatedPlayers = 0;
      for (const reg of regs) {
        const participantResult = await joinOrReviveParticipant(tx, {
          raceRoomId: roomId,
          userId: reg.userId,
          currentSteps: 0,
          raceBaselineSteps: 0,
        });
        if (participantResult.changed) {
          activatedPlayers += 1;
        }
      }

      playerCount = activatedPlayers;
      finalStatus = deriveOpenRoomStatus(activatedPlayers, room.maxPlayers);

      await tx
        .update(raceRoomsTable)
        .set({
          status: finalStatus,
          startedAt: now,
          currentPlayers: activatedPlayers,
          updatedAt: now,
        })
        .where(eq(raceRoomsTable.id, roomId));
    });

    if (finalStatus === "cancelled") {
      logger.info({ roomId, registrations: regs.length }, "[ScheduleRoomJob] roomCancelledInsufficientPlayers");

      triggerEvent("public-rooms-available", "room:cancelled", { room_id: roomId }).catch(() => {});
      for (const reg of regs) {
        triggerEvent(`private-user-${reg.userId}`, "notification", {
          type: "room_cancelled",
          room_id: roomId,
          message: "Scheduled challenge was cancelled because not enough players joined.",
        }).catch(() => {});
      }
      return;
    }

    logger.info({ roomId, players: playerCount }, "[ScheduleRoomJob] roomStarted");

    triggerEvent("public-rooms-available", "room:created", { room_id: roomId }).catch(() => {});
    triggerEvent("public-presence", "race:started", { raceId: roomId }).catch(() => {});
    for (const reg of regs) {
      triggerEvent(`private-user-${reg.userId}`, "notification", {
        type: "room_started",
        room_id: roomId,
        message: "Your challenge has started!",
      }).catch(() => {});
    }
  } catch (err) {
    logger.error({ err, roomId }, "[ScheduleRoomJob] error starting room");
  }
}

async function finalizeDurationRoom(roomId: string): Promise<void> {
  try {
    const [room] = await db
      .select()
      .from(raceRoomsTable)
      .where(eq(raceRoomsTable.id, roomId))
      .limit(1);

    if (!room || room.status !== "in_progress") return;

    await db
      .update(raceRoomsTable)
      .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(raceRoomsTable.id, roomId));

    logger.info({ roomId }, "[ScheduleRoomJob] challengeEnded");

    triggerEvent(`public-live-race-${roomId}`, "race:finished", {
      room_id: roomId,
      reason: "duration_expired",
    }).catch(() => {});
  } catch (err) {
    logger.error({ err, roomId }, "[ScheduleRoomJob] error finalizing duration room");
  }
}

export async function runSchedulerTick(): Promise<void> {
  try {
    const now = new Date();

    const dueToStart = await db
      .select({ id: raceRoomsTable.id })
      .from(raceRoomsTable)
      .where(
        and(
          eq(raceRoomsTable.status, "scheduled"),
          ne(raceRoomsTable.type, "sponsored"),
          lte(raceRoomsTable.scheduledStartAt, now)
        )
      );

    if (dueToStart.length > 0) {
      logger.info({ count: dueToStart.length }, "[ScheduleRoomJob] roomsDueToStart");
    }
    for (const room of dueToStart) {
      await startScheduledRoom(room.id);
    }

    const dueToEnd = await db
      .select({ id: raceRoomsTable.id })
      .from(raceRoomsTable)
      .where(
        and(
          eq(raceRoomsTable.status, "in_progress"),
          sql`${raceRoomsTable.challengeEndAt} IS NOT NULL`,
          lte(raceRoomsTable.challengeEndAt, now)
        )
      );

    for (const room of dueToEnd) {
      await finalizeDurationRoom(room.id);
    }
  } catch (err) {
    logger.error({ err }, "[ScheduleRoomJob] tick error");
  }
}

export function startScheduler(): void {
  setInterval(() => { runSchedulerTick().catch(() => {}); }, 60_000);
  runSchedulerTick().catch(() => {});
}
