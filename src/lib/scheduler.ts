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
import { lockRaceRoom } from "./raceIntegrity.js";
import { sendPushToUser } from "../routes/push.js";
import { reconcileWaitingRooms } from "./waitingRoomJobs.js";
import { reconcileUnlimitedChallenges } from "./unlimitedChallengeJobs.js";
import { config } from "./config.js";
import { getSchedulerNextDueAtMs, setSchedulerNextDueAtMs } from "./idleGate.js";

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

// startScheduledRoom was replaced by the shared Waiting Room lifecycle: scheduled rooms now
// auto-start into an ACTIVE race (or cancel when the minimum isn't met) via
// waitingRoomJobs.evaluateScheduledStart, invoked by reconcileWaitingRooms + the durable job.

async function finalizeDurationRoom(roomId: string): Promise<void> {
  try {
    const [room] = await db
      .select({ id: raceRoomsTable.id, status: raceRoomsTable.status, challengeEndAt: raceRoomsTable.challengeEndAt })
      .from(raceRoomsTable)
      .where(eq(raceRoomsTable.id, roomId))
      .limit(1);

    if (!room || room.status !== "in_progress") return;

    // Duration / soft-end races must go through the race finalizer so standings,
    // results, payouts, and realtime finish events are all produced consistently.
    logger.info({ roomId, challengeEndAt: room.challengeEndAt?.toISOString() ?? null }, "[ScheduleRoomJob] duration due; completing via race finalizer");
    const { autoCompleteRace } = await import("../routes/races.js");
    await autoCompleteRace(roomId, "duration_expired");
  } catch (err) {
    logger.error({ err, roomId }, "[ScheduleRoomJob] error finalizing duration room");
  }
}

/** Rooms stuck in "starting" are recovered this long after their last update. */
const STUCK_STARTING_GRACE_MS = 2 * 60_000;
/** The reminder scan is only productive once a user's local hour reaches this. */
const DAILY_GOAL_REMINDER_LOCAL_HOUR = 18;

function msUntilNextLocalHour(now: Date, timezone: string, targetHour: number): number | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      hourCycle: "h23",
    });
    const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
    const h = Number(p.hour);
    const m = Number(p.minute);
    const s = Number(p.second);
    if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return null;

    const secondsIntoDay = h * 3600 + m * 60 + s;
    const targetSeconds = targetHour * 3600;
    // Already past the boundary today → the scan for this timezone has had its chance; the
    // next productive moment is tomorrow's boundary.
    const deltaSeconds = secondsIntoDay < targetSeconds
      ? targetSeconds - secondsIntoDay
      : 24 * 3600 - secondsIntoDay + targetSeconds;
    return now.getTime() + deltaSeconds * 1000;
  } catch {
    return null; // invalid timezone → ignore this one rather than pinning the gate open
  }
}

/**
 * Earliest epoch-ms at which the scheduler could next have work, derived entirely from
 * Postgres. `null` means nothing is pending anywhere. Runs only at the tail of a pass that
 * has already woken the database, so its cost rides along with work that was happening anyway.
 */
export async function computeSchedulerNextDueAtMs(now = new Date()): Promise<number | null> {
  const graceMs = config.unlimitedGoal.graceMs;

  const rows = await db.execute(sql`
    select
      (select min(scheduled_start_at) from race_rooms
        where status = 'scheduled' and type <> 'sponsored')                       as next_scheduled_start,
      (select min(room_expires_at) from race_rooms
        where status in ('open','full') and mode = 'open_window')                 as next_room_expiry,
      (select min(updated_at) from race_rooms where status = 'starting')          as oldest_starting,
      (select min(challenge_end_at) from race_rooms where status = 'in_progress') as next_challenge_end,
      (select min(start_at_utc) from unlimited_challenges where status = 'waiting')            as next_unlimited_start,
      (select count(*)::int from unlimited_challenges where status = 'starting')               as unlimited_starting,
      (select min(settlement_not_before_utc) from unlimited_challenges
        where status in ('active','settling'))                                    as next_unlimited_settle,
      (select min(window_end_utc) from unlimited_challenge_days
        where status in ('pending','in_progress'))                                as next_day_window_end,
      (select min(window_end_utc) from unlimited_challenge_days
        where status in ('pending','in_progress','pending_verification'))         as next_day_finalize_base
  `);

  const r = ((rows as unknown as { rows?: Record<string, unknown>[] }).rows ?? (rows as unknown as Record<string, unknown>[]))[0] ?? {};
  const at = (v: unknown): number | null => {
    if (v == null) return null;
    const t = v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
    return Number.isFinite(t) ? t : null;
  };

  const candidates: (number | null)[] = [
    at(r.next_scheduled_start),
    at(r.next_room_expiry),
    at(r.oldest_starting) == null ? null : at(r.oldest_starting)! + STUCK_STARTING_GRACE_MS,
    at(r.next_challenge_end),
    at(r.next_unlimited_start),
    Number(r.unlimited_starting ?? 0) > 0 ? now.getTime() : null,
    at(r.next_unlimited_settle),
    at(r.next_day_window_end),
    at(r.next_day_finalize_base) == null ? null : at(r.next_day_finalize_base)! + graceMs,
  ];

  // Daily-goal reminders are wall-clock work: wake at the next 18:00 local among the
  // timezones users actually have, instead of polling every 10 minutes forever.
  try {
    const tzRows = await db
      .selectDistinct({ timezone: userPreferencesTable.timezone })
      .from(userPreferencesTable);
    const zones = tzRows.map((x) => x.timezone).filter(Boolean);
    for (const tz of zones.length > 0 ? zones : [DEFAULT_TIMEZONE]) {
      candidates.push(msUntilNextLocalHour(now, tz, DAILY_GOAL_REMINDER_LOCAL_HOUR));
    }
  } catch (err) {
    logger.warn({ err }, "[ScheduleRoomJob] timezone scan failed — keeping gate open");
    return now.getTime(); // unknown → do not suppress the next tick
  }

  const due = candidates.filter((x): x is number => x != null);
  return due.length === 0 ? null : Math.min(...due);
}

export async function runSchedulerTick(opts?: { force?: boolean }): Promise<void> {
  try {
    const now = new Date();

    // Idle gate: skip the whole Postgres pass until the earliest moment work could exist.
    // A missing/unreadable hint reads as `null` → run anyway. `force` is the hourly
    // maintenance pass, which always runs and re-derives the hint from DB truth.
    if (!opts?.force) {
      const nextDueAtMs = await getSchedulerNextDueAtMs();
      if (nextDueAtMs != null && now.getTime() < nextDueAtMs) return;
    }

    // Shared Waiting Room reconciliation: scheduled rooms past their start time auto-start (or
    // cancel when the minimum isn't met), open-window rooms past their 30-minute window expire,
    // and rooms stuck mid-start are recovered. Idempotent — a safety net behind the durable jobs.
    await reconcileWaitingRooms(now);

    // Unlimited Challenge reconciliation: start past-due challenges, finalize due participant-days,
    // and settle challenges past their settlement time. Safety net behind the durable jobs.
    await reconcileUnlimitedChallenges(now);

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

    // Re-derive the gate from DB truth now that the pass is complete. Done in a nested try so
    // a failure here can never mask or abort the work above — it just leaves the gate open.
    try {
      await setSchedulerNextDueAtMs(await computeSchedulerNextDueAtMs(new Date()));
    } catch (err) {
      logger.warn({ err }, "[ScheduleRoomJob] next-due refresh failed (non-fatal)");
    }
  } catch (err) {
    logger.error({ err }, "[ScheduleRoomJob] tick error");
  }
}

export function startScheduler(): void {
  setInterval(() => { runSchedulerTick().catch(() => {}); }, 60_000);
  // Boot pass is unconditional: it seeds the gate from DB truth after a restart or a Redis flush.
  runSchedulerTick({ force: true }).catch(() => {});
}
