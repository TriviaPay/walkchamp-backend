import { db } from "../../db/src/index.js";
import {
  notificationDeliveryTable,
  profilesTable,
  raceRoomsTable,
  scheduledRoomRegistrationsTable,
  stepDailyTotalsTable,
  userPreferencesTable,
} from "../../db/src/schema/index.js";
import { eq, and, lte, sql, ne, inArray } from "drizzle-orm";
import { triggerEvent } from "./pusher.js";
import { logger } from "./logger.js";
import { deriveOpenRoomStatus, joinOrReviveParticipant, lockRaceRoom } from "./raceIntegrity.js";
import { sendPushToUser } from "../routes/push.js";

const DAILY_GOAL_REMINDER_TEMPLATE = "daily_goal_reminder";
const DAILY_GOAL_REMINDER_SCAN_INTERVAL_MS = 10 * 60 * 1000;
const DAILY_GOAL_REMINDER_TITLE = "Complete Your Daily Goal";
const DAILY_GOAL_REMINDER_BODY = "You still have time to complete your daily step goal today!";
const DAILY_GOAL_REMINDER_URL = "walkchamp://walk";
const DEFAULT_DAILY_GOAL = 10000;
const DEFAULT_TIMEZONE = "UTC";

let nextDailyGoalReminderScanAt = 0;

export interface DailyGoalReminderTickResult {
  scanned: number;
  eligible: number;
  inserted: number;
  sent: number;
  skipped: number;
  failed: number;
}

interface LocalReminderTime {
  localDate: string;
  hour: number;
}

function getLocalReminderTime(now: Date, timezone: string): LocalReminderTime {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  return {
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
  };
}

function safeLocalReminderTime(userId: string, timezone: string | null, now: Date): LocalReminderTime {
  const tz = timezone || DEFAULT_TIMEZONE;
  try {
    return getLocalReminderTime(now, tz);
  } catch (err) {
    logger.warn({ err, userId, timezone: tz }, "[DailyGoalReminderJob] invalidTimezone");
    return getLocalReminderTime(now, DEFAULT_TIMEZONE);
  }
}

function emptyDailyGoalReminderResult(): DailyGoalReminderTickResult {
  return { scanned: 0, eligible: 0, inserted: 0, sent: 0, skipped: 0, failed: 0 };
}

function classifyPushStatus(result: DailyGoalReminderTickResult, status: string): void {
  if (status === "sent") {
    result.sent += 1;
  } else if (status.startsWith("skipped_")) {
    result.skipped += 1;
  } else {
    result.failed += 1;
  }
}

export async function runDailyGoalReminderTick(now = new Date()): Promise<DailyGoalReminderTickResult> {
  const result = emptyDailyGoalReminderResult();

  try {
    const users = await db
      .select({
        userId: profilesTable.id,
        dailyGoal: userPreferencesTable.dailyStepGoal,
        timezone: userPreferencesTable.timezone,
      })
      .from(profilesTable)
      .leftJoin(userPreferencesTable, eq(userPreferencesTable.userId, profilesTable.id))
      .where(eq(profilesTable.accountStatus, "active"));

    result.scanned = users.length;
    if (users.length === 0) return result;

    const candidateUsers = users
      .map((user) => ({
        userId: user.userId,
        dailyGoal: user.dailyGoal ?? DEFAULT_DAILY_GOAL,
        ...safeLocalReminderTime(user.userId, user.timezone, now),
      }))
      .filter((user) => user.hour >= 18);

    if (candidateUsers.length === 0) return result;

    const stepsByUserAndDate = new Map<string, number>();
    const localDates = [...new Set(candidateUsers.map((user) => user.localDate))];

    for (const localDate of localDates) {
      const userIdsForDate = candidateUsers
        .filter((user) => user.localDate === localDate)
        .map((user) => user.userId);
      if (userIdsForDate.length === 0) continue;

      const stepRows = await db
        .select({
          userId: stepDailyTotalsTable.userId,
          steps: stepDailyTotalsTable.steps,
          date: stepDailyTotalsTable.date,
        })
        .from(stepDailyTotalsTable)
        .where(
          and(
            eq(stepDailyTotalsTable.date, localDate),
            inArray(stepDailyTotalsTable.userId, userIdsForDate),
          ),
        );

      for (const row of stepRows) {
        stepsByUserAndDate.set(`${row.userId}:${row.date}`, row.steps);
      }
    }

    for (const user of candidateUsers) {
      const todaySteps = stepsByUserAndDate.get(`${user.userId}:${user.localDate}`) ?? 0;
      if (todaySteps >= user.dailyGoal) continue;

      result.eligible += 1;

      const payload = {
        type: DAILY_GOAL_REMINDER_TEMPLATE,
        screen: "walk",
        localDate: user.localDate,
        todaySteps,
        dailyGoal: user.dailyGoal,
      };

      const insertedRows = await db
        .insert(notificationDeliveryTable)
        .values({
          userId: user.userId,
          template: DAILY_GOAL_REMINDER_TEMPLATE,
          entityId: user.localDate,
          status: "pending",
          payload,
        })
        .onConflictDoNothing()
        .returning({ id: notificationDeliveryTable.id });

      if (insertedRows.length === 0) {
        result.skipped += 1;
        continue;
      }

      result.inserted += 1;

      const sendStatus = await sendPushToUser(
        user.userId,
        DAILY_GOAL_REMINDER_TITLE,
        DAILY_GOAL_REMINDER_BODY,
        payload,
        {
          url: DAILY_GOAL_REMINDER_URL,
          dedupeKey: `${DAILY_GOAL_REMINDER_TEMPLATE}:${user.userId}:${user.localDate}`,
        },
      );

      classifyPushStatus(result, sendStatus);

      await db
        .update(notificationDeliveryTable)
        .set({
          status: sendStatus,
          deliveredAt: sendStatus === "sent" ? new Date() : null,
        })
        .where(eq(notificationDeliveryTable.id, insertedRows[0]!.id));
    }
  } catch (err) {
    logger.error({ err }, "[DailyGoalReminderJob] tick error");
    result.failed += 1;
  }

  if (result.eligible > 0 || result.failed > 0) {
    logger.info(result, "[DailyGoalReminderJob] tick complete");
  }

  return result;
}

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
      .select({ id: raceRoomsTable.id, status: raceRoomsTable.status, challengeEndAt: raceRoomsTable.challengeEndAt })
      .from(raceRoomsTable)
      .where(eq(raceRoomsTable.id, roomId))
      .limit(1);

    if (!room || room.status !== "in_progress") return;

    // Duration races must go through the race finalizer so standings, results,
    // payouts, and realtime finish events are all produced consistently.
    logger.info({ roomId, challengeEndAt: room.challengeEndAt?.toISOString() ?? null }, "[ScheduleRoomJob] duration due; race finalizer will complete");
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

    if (now.getTime() >= nextDailyGoalReminderScanAt) {
      nextDailyGoalReminderScanAt = now.getTime() + DAILY_GOAL_REMINDER_SCAN_INTERVAL_MS;
      await runDailyGoalReminderTick(now);
    }
  } catch (err) {
    logger.error({ err }, "[ScheduleRoomJob] tick error");
  }
}

export function startScheduler(): void {
  setInterval(() => { runSchedulerTick().catch(() => {}); }, 60_000);
  runSchedulerTick().catch(() => {});
}
