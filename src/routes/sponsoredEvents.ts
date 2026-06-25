import { Router } from "express";
import { db } from "@db";
import {
  raceRoomsTable,
  scheduledRoomRegistrationsTable,
  raceParticipantsTable,
} from "@db/schema";
import { sendPushToUser } from "./push";
import { requireAdminKey } from "../middleware/requireAdminKey";
import { profilesTable } from "@db/schema";
import { eq, and, sql, inArray, lte, or, gte, asc, ne, desc } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth";
import { triggerEvent } from "../lib/pusher";
import { spendCoins, getCoinBalance, recordCoinLedgerEntry } from "../lib/coinsService";
import { grantVariableCoinReward } from "../lib/coinRewardService";
import { logger } from "../lib/logger";
import { joinOrReviveParticipant, lockRaceRoom, lockScheduledRegistration } from "../lib/raceIntegrity";
import { notifyPromotionalSponsoredEvent } from "../lib/pushNotificationService";

const router = Router();

// ── Constants ──────────────────────────────────────────────────────────────────
const ENTRY_COINS = 5000;
const PRIZE_CENTS = 1000;          // $10 total pool
const WINNER_COUNT = 2;            // Top 2 winners
const PRIZE_PER_WINNER_CENTS = 500; // $5 Amazon gift card per winner (tie → split equally)
const TARGET_STEPS = 10000;
const MAX_SLOTS = 10;
const MIN_PARTICIPANTS = 2;
// America/Chicago CDT (UTC-5 in summer). Adjust to UTC-6 in winter if needed.
const TZ_OFFSET_HOURS = -5;
const PUSHER_CHANNEL = "public-sponsored-events";

// ── Helpers ────────────────────────────────────────────────────────────────────
function makeEventTime(baseDate: Date, localHour: number): Date {
  const d = new Date(baseDate);
  // Convert local hour → UTC: utcHour = localHour - tzOffset
  const utcHour = localHour - TZ_OFFSET_HOURS; // e.g. 10 AM CDT → 15 UTC
  d.setUTCHours(utcHour, 0, 0, 0);
  return d;
}

function padDate(n: number) { return String(n).padStart(2, "0"); }

function eventInviteCode(day: "sat" | "sun", slot: "morning" | "evening", date: Date): string {
  return `sponsored_${day}_${slot}_${date.getUTCFullYear()}_${padDate(date.getUTCMonth() + 1)}_${padDate(date.getUTCDate())}`;
}

// Rotate track themes so each weekend slot looks visually distinct.
// Saturday Morning cycles through one set; Sunday Evening through another.
function pickTrackLayout(day: "sat" | "sun", date: Date): string {
  // Week index in the month (0–4) gives us the rotation axis
  const weekIndex = Math.floor((date.getUTCDate() - 1) / 7);
  const satTracks = ["bg1", "bg3", "bg5", "bg", "bg2"] as const;
  const sunTracks = ["bg2", "bg4", "bg", "bg1", "bg3"] as const;
  return day === "sat"
    ? satTracks[weekIndex % satTracks.length]
    : sunTracks[weekIndex % sunTracks.length];
}

// Returns next N weekend pairs (Sat+Sun), rolling forward from the next upcoming Saturday.
// If today is Sunday, we skip to the Saturday one week out so Sunday events that may be
// active aren't accidentally re-generated, but we still let the idempotency guard handle it.
function getUpcomingWeekends(count = 2): Array<{ sat: Date; sun: Date }> {
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 6=Sat
  // Days until NEXT Saturday: if today is Sat (6) → 0; Sun (0) → 6; Mon (1) → 5; etc.
  const daysToSat = dayOfWeek === 6 ? 0 : (6 - dayOfWeek + 7) % 7;
  const weekends: Array<{ sat: Date; sun: Date }> = [];
  for (let i = 0; i < count; i++) {
    const sat = new Date(now);
    sat.setUTCDate(now.getUTCDate() + daysToSat + i * 7);
    sat.setUTCHours(0, 0, 0, 0);
    const sun = new Date(sat);
    sun.setUTCDate(sat.getUTCDate() + 1);
    weekends.push({ sat, sun });
  }
  return weekends;
}


async function refundCoins(userId: string, amount: number, roomId: string, description: string) {
  try {
    await db.transaction(async (tx) => {
      await recordCoinLedgerEntry(tx, {
        userId,
        amount,
        transactionType: "refund",
        source: "sponsored_event_refund",
        sourceId: roomId,
        rewardCode: null,
        reasonCode: "sponsored_event_refund",
        idempotencyKey: `sponsored-refund:${userId}:${roomId}:${amount}`,
        description,
        metadata: { roomId },
      });
    });
  } catch (err) {
    logger.error({ err, userId, roomId }, "[SponsoredEvents] refundCoins failed");
  }
}

// ── Background: auto-generate the next 8 weekends (~2 months) of events ───────
// Idempotent — skips events that already exist (keyed by inviteCode).
// Reuses the creatorId of the most recent sponsored event to avoid needing a
// system account. If no sponsored events exist yet the fill is a no-op.
async function autoFillSchedule(): Promise<void> {
  // Find a creator ID to attribute new rooms to
  const [recent] = await db
    .select({ creatorId: raceRoomsTable.creatorId })
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.type, "sponsored"))
    .orderBy(raceRoomsTable.createdAt)
    .limit(1);

  if (!recent) {
    logger.info("[SponsoredEventsJob] autoFill skipped — no creator found yet");
    return;
  }

  const weekends = getUpcomingWeekends(8);
  const schedule: Array<{ day: "sat" | "sun"; slot: "morning" | "evening"; date: Date; localHour: number; title: string }> = [];
  for (const { sat, sun } of weekends) {
    const satLabel = sat.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const sunLabel = sun.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    schedule.push(
      { day: "sat", slot: "morning", date: sat, localHour: 8, title: `Saturday Morning Walk (${satLabel})` },
      { day: "sun", slot: "evening", date: sun, localHour: 18, title: `Sunday Evening Walk (${sunLabel})` },
    );
  }

  let created = 0;
  for (const ev of schedule) {
    const inviteCode = eventInviteCode(ev.day, ev.slot, ev.date);
    const startAt = makeEventTime(ev.date, ev.localHour);

    const existing = await db
      .select({ id: raceRoomsTable.id })
      .from(raceRoomsTable)
      .where(eq(raceRoomsTable.inviteCode, inviteCode))
      .limit(1);

    if (existing.length > 0) continue;

    const [inserted] = await db.insert(raceRoomsTable).values({
      creatorId: recent.creatorId,
      title: ev.title,
      type: "sponsored",
      entryType: "free",
      entryAmountCents: 0,
      targetSteps: TARGET_STEPS,
      maxPlayers: MAX_SLOTS,
      status: "scheduled",
      scheduleType: "scheduled",
      scheduledStartAt: startAt,
      prizePoolCents: PRIZE_CENTS,
      inviteCode,
      isPrivate: false,
      trackLayout: pickTrackLayout(ev.day, ev.date),
    }).returning({ id: raceRoomsTable.id });

    if (inserted) {
      void notifyPromotionalSponsoredEvent({
        eventId: inserted.id,
        eventName: ev.title,
        coinsEntry: ENTRY_COINS,
        excludeUserId: recent.creatorId,
      });
    }

    created++;
    logger.info({ inviteCode, startAt }, "[SponsoredEventsJob] autoFill: created event");
  }

  if (created > 0) {
    logger.info({ created }, "[SponsoredEventsJob] autoFill: new events created");
    triggerEvent(PUSHER_CHANNEL, "sponsored_event.created", { created }).catch(() => {});
  }
}

// ── Background job: auto-start/cancel due events ───────────────────────────────
async function processSponsuredEvents() {
  try {
    const now = new Date();
    const dueRooms = await db
      .select()
      .from(raceRoomsTable)
      .where(
        and(
          eq(raceRoomsTable.type, "sponsored"),
          eq(raceRoomsTable.scheduleType, "scheduled"),
          eq(raceRoomsTable.status, "scheduled"),
          lte(raceRoomsTable.scheduledStartAt, now),
        ),
      );

    logger.info({ count: dueRooms.length }, "[SponsoredEventsJob] due events");

    for (const room of dueRooms) {
      // Get all registered users
      const regs = await db
        .select()
        .from(scheduledRoomRegistrationsTable)
        .where(
          and(
            eq(scheduledRoomRegistrationsTable.raceRoomId, room.id),
            eq(scheduledRoomRegistrationsTable.status, "registered"),
          ),
        );

      // ── Coins are charged at registration time, not here ──
      // All "registered" users have already paid. Just treat them all as paid.
      const paidUserIds: string[] = regs.map((r) => r.userId);
      logger.info({ roomId: room.id, count: paidUserIds.length }, "[SponsoredEventsJob] all registered users pre-paid");

      // ── Require at least 1 registered player before starting ──
      const MIN_PLAYERS = 1;
      if (paidUserIds.length < MIN_PLAYERS) {
        logger.info({ roomId: room.id, count: paidUserIds.length }, "[SponsoredEventsJob] skipped — no players registered");
        continue;
      }

      logger.info({ roomId: room.id, count: paidUserIds.length }, "[SponsoredEventsJob] event started");
      await db.transaction(async (tx) => {
        const lockedRoom = await lockRaceRoom(tx, room.id);
        if (!lockedRoom || lockedRoom.status !== "scheduled") return;

        await tx
          .update(raceRoomsTable)
          .set({
            status: "in_progress",
            startedAt: now,
            updatedAt: now,
            registeredCount: paidUserIds.length,
          })
          .where(eq(raceRoomsTable.id, room.id));

        if (paidUserIds.length === 0) {
          await tx
            .update(raceRoomsTable)
            .set({ currentPlayers: 0, updatedAt: now })
            .where(eq(raceRoomsTable.id, room.id));
          return;
        }

        await tx
          .update(scheduledRoomRegistrationsTable)
          .set({ status: "active", activatedAt: now })
          .where(
            and(
              eq(scheduledRoomRegistrationsTable.raceRoomId, room.id),
              inArray(scheduledRoomRegistrationsTable.userId, paidUserIds),
            ),
          );

        let insertedCount = 0;
        for (const uid of paidUserIds) {
          const [existingActive] = await tx
            .select({ id: raceParticipantsTable.id })
            .from(raceParticipantsTable)
            .innerJoin(raceRoomsTable, eq(raceRoomsTable.id, raceParticipantsTable.raceRoomId))
            .where(
              and(
                eq(raceParticipantsTable.userId, uid),
                inArray(raceParticipantsTable.status, ["joined", "active"]),
                inArray(raceRoomsTable.status, ["open", "full", "in_progress"]),
                ne(raceRoomsTable.id, room.id),
              ),
            )
            .limit(1);

          if (existingActive) {
            logger.info({ roomId: room.id, uid }, "[SponsoredEventsJob] skip user — already in active race");
            continue;
          }

          const lockedReg = await lockScheduledRegistration(tx, room.id, uid);
          if (!lockedReg || (lockedReg.status !== "active" && lockedReg.status !== "registered")) {
            continue;
          }

          const participantResult = await joinOrReviveParticipant(tx, {
            raceRoomId: room.id,
            userId: uid,
            currentSteps: 0,
            raceBaselineSteps: 0,
          });
          if (participantResult.changed) {
            insertedCount += 1;
          }
        }

        await tx
          .update(raceRoomsTable)
          .set({ currentPlayers: insertedCount, updatedAt: now })
          .where(eq(raceRoomsTable.id, room.id));
      });

      triggerEvent(PUSHER_CHANNEL, "sponsored_event.started", { room_id: room.id }).catch(() => {});
      for (const uid of paidUserIds) {
        sendPushToUser(
          uid,
          "🏆 Sponsored Race Started!",
          `${room.title} has started! Compete for the $${(PRIZE_CENTS / 100).toFixed(0)} prize pool.`,
          { type: "sponsored_event_started", room_id: room.id },
        );
      }
    }
    // ── Phase 2: Finalize in_progress events whose 3-hour window has elapsed ──
    await finalizeSponsoredEvents(now);

    // Always keep 8 weekends ahead populated after processing
    await autoFillSchedule();
  } catch (err) {
    logger.error({ err }, "[SponsoredEventsJob] processSponsuredEvents failed");
  }
}

// ── Finalize sponsored events that have run their full 3-hour window ──────────
// Winners = participants who hit targetSteps (finishedGoal=true).
// Non-winners get 100 consolation coins. Room is marked completed.
const CONSOLATION_COINS = 100;

async function finalizeSponsoredEvents(now: Date) {
  const RACE_DURATION_MS = 3 * 60 * 60 * 1000;

  const dueRooms = await db
    .select()
    .from(raceRoomsTable)
    .where(
      and(
        eq(raceRoomsTable.type, "sponsored"),
        eq(raceRoomsTable.status, "in_progress"),
        lte(raceRoomsTable.startedAt, new Date(now.getTime() - RACE_DURATION_MS)),
      ),
    );

  if (dueRooms.length === 0) return;
  logger.info({ count: dueRooms.length }, "[SponsoredEventsJob] finalizing expired events");

  for (const room of dueRooms) {
    // Get all active participants
    const parts = await db
      .select({
        userId:       raceParticipantsTable.userId,
        currentSteps: raceParticipantsTable.currentSteps,
        finishedGoal: raceParticipantsTable.finishedGoal,
        finishedAt:   raceParticipantsTable.finishedAt,
        finishRank:   raceParticipantsTable.finishRank,
      })
      .from(raceParticipantsTable)
      .where(eq(raceParticipantsTable.raceRoomId, room.id));

    // Identify winners (reached target steps)
    const winnerIds = new Set(
      parts
        .filter((p) => p.finishedGoal && p.finishedAt)
        .sort((a, b) => (a.finishedAt?.getTime() ?? 0) - (b.finishedAt?.getTime() ?? 0))
        .slice(0, WINNER_COUNT)
        .map((p) => p.userId),
    );

    // Non-winners: grant 100 consolation coins (idempotent)
    const nonWinners = parts.filter((p) => !winnerIds.has(p.userId));
    for (const p of nonWinners) {
      await grantVariableCoinReward({
        userId:      p.userId,
        amount:      CONSOLATION_COINS,
        rewardCode:  "sponsored_consolation",
        sourceId:    room.id,
        description: "Sponsored event consolation prize",
      });
    }

    // Mark room completed
    await db
      .update(raceRoomsTable)
      .set({ status: "completed", completedAt: now, updatedAt: now })
      .where(eq(raceRoomsTable.id, room.id));

    // Mark participants inactive
    await db
      .update(raceParticipantsTable)
      .set({ status: "completed" })
      .where(eq(raceParticipantsTable.raceRoomId, room.id));

    // Broadcast race finished
    triggerEvent("public-presence", "race:finished", { room_id: room.id }).catch(() => {});
    triggerEvent(PUSHER_CHANNEL, "sponsored_event.completed", { room_id: room.id }).catch(() => {});

    // Push notifications
    const prizeDisplay = `$${(PRIZE_PER_WINNER_CENTS / 100).toFixed(0)}`;
    for (const p of parts) {
      const isWinner = winnerIds.has(p.userId);
      if (isWinner) {
        sendPushToUser(
          p.userId,
          "🏆 You won a gift card!",
          `Congratulations! You finished ${room.title} and won a ${prizeDisplay} Amazon gift card. We'll email you shortly.`,
          { type: "sponsored_event_winner", room_id: room.id },
        );
        triggerEvent(`private-user-${p.userId}`, "sponsored:won", {
          room_id:   room.id,
          title:     room.title,
          prize:     prizeDisplay,
        }).catch(() => {});
      } else {
        sendPushToUser(
          p.userId,
          "Sponsored Race Ended",
          `${room.title} has ended. You earned ${CONSOLATION_COINS} coins for participating! Keep walking! 🚶`,
          { type: "sponsored_event_consolation", room_id: room.id, coins: CONSOLATION_COINS },
        );
      }
    }

    logger.info(
      { roomId: room.id, winners: winnerIds.size, consolation: nonWinners.length },
      "[SponsoredEventsJob] finalized",
    );
  }
}

let sponsoredEventsJobStarted = false;

export function startSponsoredEventsJob(): void {
  if (sponsoredEventsJobStarted) return;
  sponsoredEventsJobStarted = true;

  setInterval(() => { processSponsuredEvents().catch(() => {}); }, 60_000);
  setTimeout(() => { processSponsuredEvents().catch(() => {}); }, 5_000);
}

// ── GET /api/sponsored-events ──────────────────────────────────────────────────
router.get("/sponsored-events", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  req.log.info({ userId }, "[SponsoredEvents] fetch events");

  try {
    const now = new Date();

    // Show: scheduled (future), in_progress, completed/cancelled within last 48h
    const cutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const rooms = await db
      .select()
      .from(raceRoomsTable)
      .where(
        and(
          eq(raceRoomsTable.type, "sponsored"),
          eq(raceRoomsTable.scheduleType, "scheduled"),
          or(
            eq(raceRoomsTable.status, "scheduled"),
            eq(raceRoomsTable.status, "in_progress"),
            and(
              or(eq(raceRoomsTable.status, "completed"), eq(raceRoomsTable.status, "cancelled")),
              gte(raceRoomsTable.scheduledStartAt, cutoff),
            ),
          ),
        ),
      )
      .orderBy(raceRoomsTable.scheduledStartAt);

    const roomIds = rooms.map((r) => r.id);

    // Derive a badge label from total steps (mirrors leaderboard logic without needing a rank)
    function stepsBadge(totalSteps: number): string {
      if (totalSteps >= 500_000) return "Global Champion";
      if (totalSteps >= 200_000) return "Elite Walker";
      if (totalSteps >= 100_000) return "Daily Champion";
      if (totalSteps >= 50_000)  return "Fast Walker";
      if (totalSteps >= 10_000)  return "Beginner Walker";
      return "Walker";
    }

    // Fetch all registrations + profiles for all rooms in one query
    type RegRow = {
      raceRoomId: string; regUserId: string;
      username: string; avatarUrl: string | null;
      avatarColor: string; countryFlag: string | null; totalSteps: number;
    };
    let allRegs: RegRow[] = [];
    let myRegRoomIds = new Set<string>();
    if (roomIds.length > 0) {
      const regsWithProfile = await db
        .select({
          raceRoomId: scheduledRoomRegistrationsTable.raceRoomId,
          regUserId: scheduledRoomRegistrationsTable.userId,
          username: profilesTable.username,
          avatarUrl: profilesTable.avatarUrl,
          avatarColor: profilesTable.avatarColor,
          countryFlag: profilesTable.countryFlag,
          totalSteps: profilesTable.totalSteps,
        })
        .from(scheduledRoomRegistrationsTable)
        .innerJoin(profilesTable, eq(profilesTable.id, scheduledRoomRegistrationsTable.userId))
        .where(
          and(
            inArray(scheduledRoomRegistrationsTable.raceRoomId, roomIds),
            // Include both "registered" (upcoming) and "active" (event in_progress)
            inArray(scheduledRoomRegistrationsTable.status, ["registered", "active"]),
          ),
        );
      allRegs = regsWithProfile as RegRow[];
      myRegRoomIds = new Set(
        allRegs.filter((r) => r.regUserId === userId).map((r) => r.raceRoomId),
      );
    }

    // Get coin balance
    const balance = await getCoinBalance(userId);
    req.log.info({ userId, balance: balance.currentBalance }, "[SponsoredEvents] coin balance");

    // Build registrants map keyed by roomId
    const registrantsMap = new Map<string, Array<{
      userId: string; username: string; avatarUrl: string | null;
      avatarColor: string; countryFlag: string | null; badge: string;
    }>>();
    for (const reg of allRegs) {
      if (!registrantsMap.has(reg.raceRoomId)) registrantsMap.set(reg.raceRoomId, []);
      registrantsMap.get(reg.raceRoomId)!.push({
        userId: reg.regUserId,
        username: reg.username,
        avatarUrl: reg.avatarUrl,
        avatarColor: reg.avatarColor ?? "#00E676",
        countryFlag: reg.countryFlag,
        badge: stepsBadge(reg.totalSteps ?? 0),
      });
    }

    const RACE_DURATION_MS = 3 * 60 * 60 * 1000; // 3 hours
    const JOIN_WINDOW_MS  = 10 * 60 * 1000;       // 10 min join window before race

    // Fetch active participant rows for the current user (racing status)
    const myActiveRoomIds = new Set<string>();
    if (roomIds.length > 0) {
      const myParts = await db
        .select({ raceRoomId: raceParticipantsTable.raceRoomId })
        .from(raceParticipantsTable)
        .where(
          and(
            eq(raceParticipantsTable.userId, userId),
            inArray(raceParticipantsTable.raceRoomId, roomIds),
            inArray(raceParticipantsTable.status, ["joined", "active"]),
          ),
        );
      myParts.forEach((p) => myActiveRoomIds.add(p.raceRoomId));
    }

    const events = rooms.map((r) => {
      // Compute when the race ends (3 hours from start / scheduled start)
      const endsAtDate = r.status === "in_progress" && r.startedAt
        ? new Date(r.startedAt.getTime() + RACE_DURATION_MS)
        : r.scheduledStartAt
          ? new Date(r.scheduledStartAt.getTime() + RACE_DURATION_MS)
          : null;

      // Join window is open during the 10 minutes before scheduled start
      const joinWindowOpen = r.status === "scheduled" &&
        r.scheduledStartAt !== null &&
        now.getTime() >= (r.scheduledStartAt.getTime() - JOIN_WINDOW_MS) &&
        now.getTime() < r.scheduledStartAt.getTime();

      return {
        id: r.id,
        title: r.title,
        status: r.status,
        scheduledStartAt: r.scheduledStartAt?.toISOString() ?? null,
        startedAt: r.startedAt?.toISOString() ?? null,
        endsAt: endsAtDate?.toISOString() ?? null,
        targetSteps: r.targetSteps,
        maxSlots: r.maxPlayers,
        registeredCount: r.registeredCount,
        prizePoolCents: r.prizePoolCents,
        prizePerWinnerCents: PRIZE_PER_WINNER_CENTS,
        winnerCount: WINNER_COUNT,
        entryCoinFee: ENTRY_COINS,
        isRegistered: myRegRoomIds.has(r.id),
        isActive: myActiveRoomIds.has(r.id),
        joinWindowOpen,
        isFull: r.registeredCount >= r.maxPlayers,
        canRegister:
          !myRegRoomIds.has(r.id) &&
          r.registeredCount < r.maxPlayers &&
          r.status === "scheduled" &&
          joinWindowOpen,
        registeredUsers: (registrantsMap.get(r.id) ?? []) as Array<{
          userId: string; username: string; avatarUrl: string | null;
          avatarColor: string; countryFlag: string | null; badge: string;
        }>,
      };
    });

    return res.json({ success: true, events, coinBalance: balance.currentBalance });
  } catch (err) {
    req.log.error({ err }, "[SponsoredEvents] fetch failed");
    return res.status(500).json({ error: "Failed to fetch sponsored events" });
  }
});

// ── POST /api/sponsored-events/generate-weekend ───────────────────────────────
// Generates events for the next 8 upcoming weekends (~2 months, 16 events total).
// Idempotent — skips any that already exist.
router.post("/sponsored-events/generate-weekend", requireAuth, requireAdminKey, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  req.log.info({ userId }, "[SponsoredEventsJob] generate weekend events");

  try {
    const weekends = getUpcomingWeekends(8);

    // Build full schedule for all weekends
    const schedule: Array<{ day: "sat" | "sun"; slot: "morning" | "evening"; date: Date; localHour: number; title: string }> = [];
    for (const { sat, sun } of weekends) {
      const satLabel = sat.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
      const sunLabel = sun.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
      schedule.push(
        { day: "sat", slot: "morning", date: sat, localHour: 8, title: `Saturday Morning Walk (${satLabel})` },
        { day: "sun", slot: "evening", date: sun, localHour: 18, title: `Sunday Evening Walk (${sunLabel})` },
      );
    }

    const created: string[] = [];
    const skipped: string[] = [];

    for (const ev of schedule) {
      const inviteCode = eventInviteCode(ev.day, ev.slot, ev.date);
      const startAt = makeEventTime(ev.date, ev.localHour);

      // Skip if already exists (idempotent by inviteCode unique constraint)
      const existing = await db
        .select({ id: raceRoomsTable.id })
        .from(raceRoomsTable)
        .where(eq(raceRoomsTable.inviteCode, inviteCode))
        .limit(1);

      if (existing.length > 0) {
        skipped.push(inviteCode);
        continue;
      }

      const [inserted] = await db.insert(raceRoomsTable).values({
        creatorId: userId,
        title: ev.title,
        type: "sponsored",
        entryType: "free",
        entryAmountCents: 0,
        targetSteps: TARGET_STEPS,
        maxPlayers: MAX_SLOTS,
        status: "scheduled",
        scheduleType: "scheduled",
        scheduledStartAt: startAt,
        prizePoolCents: PRIZE_CENTS,
        inviteCode,
        isPrivate: false,
        trackLayout: pickTrackLayout(ev.day, ev.date),
      }).returning({ id: raceRoomsTable.id });

      if (inserted) {
        void notifyPromotionalSponsoredEvent({
          eventId: inserted.id,
          eventName: ev.title,
          coinsEntry: ENTRY_COINS,
          excludeUserId: userId,
        });
      }

      created.push(inviteCode);
      req.log.info({ inviteCode, startAt }, "[SponsoredEventsJob] generated weekend events");
    }

    triggerEvent(PUSHER_CHANNEL, "sponsored_event.created", { created }).catch(() => {});

    return res.json({ success: true, created, skipped });
  } catch (err) {
    req.log.error({ err }, "[SponsoredEventsJob] generate failed");
    return res.status(500).json({ error: "Failed to generate weekend events" });
  }
});

// ── POST /api/sponsored-events/:roomId/register ───────────────────────────────
router.post("/sponsored-events/:roomId/register", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const roomId = String(req.params.roomId);

  req.log.info({ userId, roomId }, "[SponsoredEvents] register clicked");

  try {
    // Load event
    const [room] = await db
      .select()
      .from(raceRoomsTable)
      .where(
        and(
          eq(raceRoomsTable.id, roomId),
          eq(raceRoomsTable.type, "sponsored"),
        ),
      )
      .limit(1);

    if (!room) return res.status(404).json({ error: "Event not found." });

    const now = new Date();
    const RACE_DURATION_MS = 3 * 60 * 60 * 1000;

    // Registration only allowed for scheduled (not yet started) events
    if (room.status !== "scheduled") {
      return res.status(409).json({ error: "Registration is closed — this event has already started." });
    }

    if (room.registeredCount >= room.maxPlayers) {
      return res.status(409).json({ error: "This event is full." });
    }

    // Registration only opens in the 10-minute window before start
    const JOIN_WINDOW_MS = 10 * 60 * 1000;
    if (room.scheduledStartAt) {
      const msToStart = room.scheduledStartAt.getTime() - now.getTime();
      if (msToStart > JOIN_WINDOW_MS) {
        return res.status(409).json({ error: "Registration opens 10 minutes before the race starts." });
      }
    }

    // Check already registered (registered or active)
    const existing = await db
      .select({ id: scheduledRoomRegistrationsTable.id })
      .from(scheduledRoomRegistrationsTable)
      .where(
        and(
          eq(scheduledRoomRegistrationsTable.raceRoomId, roomId),
          eq(scheduledRoomRegistrationsTable.userId, userId),
          inArray(scheduledRoomRegistrationsTable.status, ["registered", "active"]),
        ),
      )
      .limit(1);

    if (existing.length > 0) return res.status(409).json({ error: "You are already registered for this event." });

    // Deduct coins immediately at registration time
    const spendResult = await spendCoins({
      userId,
      amount: ENTRY_COINS,
      source: "sponsored_event_entry",
      sourceId: roomId,
      description: `Entry fee: ${room.title}`,
    });

    if (!spendResult.success) {
      const balance = await getCoinBalance(userId);
      return res.status(402).json({
        error: `You need ${ENTRY_COINS.toLocaleString()} coins to register. You have ${balance.currentBalance.toLocaleString()} coins.`,
        coinsNeeded: ENTRY_COINS - balance.currentBalance,
        currentBalance: balance.currentBalance,
      });
    }

    // Create registration and increment count
    const newCount = room.registeredCount + 1;
    await db.transaction(async (tx) => {
      await tx.insert(scheduledRoomRegistrationsTable).values({
        raceRoomId: roomId,
        userId,
        status: "registered",
      });
      await tx
        .update(raceRoomsTable)
        .set({ registeredCount: newCount, updatedAt: new Date() })
        .where(eq(raceRoomsTable.id, roomId));
    });

    req.log.info({ userId, roomId }, "[SponsoredEvents] registered — coins deducted immediately");

    // Broadcast slot update
    triggerEvent(PUSHER_CHANNEL, "sponsored_event.registration_updated", {
      room_id: roomId,
      registered_count: newCount,
      max_slots: room.maxPlayers,
    }).catch(() => {});

    const updatedBalance = await getCoinBalance(userId);

    sendPushToUser(
      userId,
      "🎟️ Registered!",
      `You're in for ${room.title}! ${ENTRY_COINS.toLocaleString()} coins deducted. Leave anytime before start for a full refund.`,
      { type: "sponsored_event_registered", room_id: roomId },
    );

    return res.json({
      success: true,
      registered: true,
      registeredCount: newCount,
      coinBalance: updatedBalance.currentBalance,
    });
  } catch (err) {
    req.log.error({ err }, "[SponsoredEvents] register failed");
    return res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

// ── POST /api/sponsored-events/:roomId/cancel-registration ────────────────────
router.post("/sponsored-events/:roomId/cancel-registration", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const roomId = String(req.params.roomId);

  try {
    const [room] = await db
      .select()
      .from(raceRoomsTable)
      .where(and(eq(raceRoomsTable.id, roomId), eq(raceRoomsTable.type, "sponsored")))
      .limit(1);

    if (!room) return res.status(404).json({ error: "Event not found." });

    const [reg] = await db
      .select()
      .from(scheduledRoomRegistrationsTable)
      .where(
        and(
          eq(scheduledRoomRegistrationsTable.raceRoomId, roomId),
          eq(scheduledRoomRegistrationsTable.userId, userId),
          eq(scheduledRoomRegistrationsTable.status, "registered"),
        ),
      )
      .limit(1);

    if (!reg) return res.status(404).json({ error: "Registration not found." });

    const now = new Date();
    if (room.scheduledStartAt && room.scheduledStartAt <= now) {
      return res.status(409).json({ error: "Cannot cancel after the event has started." });
    }

    // Refund coins — coins were charged at registration time
    const newCount = Math.max(0, room.registeredCount - 1);
    await db.transaction(async (tx) => {
      await tx
        .update(scheduledRoomRegistrationsTable)
        .set({ status: "cancelled", cancelledAt: now })
        .where(eq(scheduledRoomRegistrationsTable.id, reg.id));
      await tx
        .update(raceRoomsTable)
        .set({ registeredCount: newCount, updatedAt: new Date() })
        .where(eq(raceRoomsTable.id, roomId));
    });

    // Refund the entry fee
    await refundCoins(userId, ENTRY_COINS, roomId, `Refund: left ${room.title} before start`);

    const balance = await getCoinBalance(userId);

    triggerEvent(PUSHER_CHANNEL, "sponsored_event.registration_updated", {
      room_id: roomId,
      registered_count: newCount,
      max_slots: room.maxPlayers,
    }).catch(() => {});

    sendPushToUser(
      userId,
      "💰 Coins Refunded",
      `You left ${room.title}. ${ENTRY_COINS.toLocaleString()} coins have been refunded to your wallet.`,
      { type: "sponsored_event_left", room_id: roomId },
    );

    req.log.info({ userId, roomId }, "[SponsoredEvents] registration cancelled — coins refunded");
    return res.json({ success: true, coinBalance: balance.currentBalance });
  } catch (err) {
    req.log.error({ err }, "[SponsoredEvents] cancel-registration failed");
    return res.status(500).json({ error: "Failed to cancel registration." });
  }
});

// ── POST /api/sponsored-events/:roomId/steps/sync ────────────────────────────
// Dedicated step sync for sponsored races. Uses baseline-delta approach:
// First call establishes baseline (raw device steps at race start).
// Subsequent calls compute progress = latestDeviceSteps - baseline.
router.post("/sponsored-events/:roomId/steps/sync", requireAuth, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).descopeUserId;
    const roomId = String(req.params.roomId);
    const { latestDeviceSteps } = req.body as { latestDeviceSteps?: number };

    if (typeof latestDeviceSteps !== "number" || latestDeviceSteps < 0) {
      return res.status(400).json({ error: "latestDeviceSteps must be a non-negative number." });
    }

    const [room] = await db.select().from(raceRoomsTable)
      .where(and(eq(raceRoomsTable.id, roomId), eq(raceRoomsTable.type, "sponsored")))
      .limit(1);
    if (!room) return res.status(404).json({ error: "Event not found." });
    if (room.status !== "in_progress") return res.status(409).json({ error: "Race is not in progress." });

    const now = new Date();
    const RACE_DURATION_MS = 3 * 60 * 60 * 1000;
    if (room.startedAt) {
      const endsAt = new Date(room.startedAt.getTime() + RACE_DURATION_MS);
      if (now >= endsAt) return res.status(409).json({ error: "Race window has ended." });
    }

    // Load or auto-create participant if user is registered
    let [participant] = await db.select().from(raceParticipantsTable)
      .where(and(eq(raceParticipantsTable.raceRoomId, roomId), eq(raceParticipantsTable.userId, userId)))
      .limit(1);

    if (!participant) {
      const [reg] = await db.select().from(scheduledRoomRegistrationsTable)
        .where(and(
          eq(scheduledRoomRegistrationsTable.raceRoomId, roomId),
          eq(scheduledRoomRegistrationsTable.userId, userId),
          inArray(scheduledRoomRegistrationsTable.status, ["registered", "active"]),
        )).limit(1);
      if (!reg) return res.status(403).json({ error: "Not registered for this event." });
      await db.transaction(async (tx) => {
        const lockedRoom = await lockRaceRoom(tx, roomId);
        if (!lockedRoom || lockedRoom.status !== "in_progress") return;

        const lockedReg = await lockScheduledRegistration(tx, roomId, userId);
        if (!lockedReg || (lockedReg.status !== "registered" && lockedReg.status !== "active")) return;

        const participantResult = await joinOrReviveParticipant(tx, {
          raceRoomId: roomId,
          userId,
          currentSteps: 0,
          raceBaselineSteps: latestDeviceSteps,
          latestDeviceSteps,
        });
        if (participantResult.changed) {
          await tx
            .update(raceRoomsTable)
            .set({ currentPlayers: sql`${raceRoomsTable.currentPlayers} + 1`, updatedAt: now })
            .where(eq(raceRoomsTable.id, roomId));
        }
      });

      const [created] = await db.select().from(raceParticipantsTable)
        .where(and(eq(raceParticipantsTable.raceRoomId, roomId), eq(raceParticipantsTable.userId, userId)))
        .limit(1);
      participant = created;
    }

    const existingBaseline = participant.raceBaselineSteps ?? 0;
    const baseline = (existingBaseline === 0 && participant.currentSteps === 0)
      ? latestDeviceSteps
      : existingBaseline;

    const rawProgress = latestDeviceSteps - baseline;
    const calculated = Math.max(0, rawProgress);
    const clamped = Math.min(calculated, room.targetSteps ?? TARGET_STEPS);
    const newProgress = Math.max(participant.currentSteps, clamped);

    const justFinished = newProgress >= (room.targetSteps ?? TARGET_STEPS) && !participant.finishedGoal;

    await db.update(raceParticipantsTable)
      .set({
        currentSteps: newProgress,
        latestDeviceSteps,
        ...(existingBaseline === 0 && participant.currentSteps === 0 ? { raceBaselineSteps: baseline } : {}),
        ...(justFinished ? { finishedGoal: true, finishedAt: now, status: "completed" } : {}),
      })
      .where(and(eq(raceParticipantsTable.raceRoomId, roomId), eq(raceParticipantsTable.userId, userId)));

    triggerEvent(`public-live-race-${roomId}`, "participant.progress.updated", {
      userId,
      steps: newProgress,
      finished: justFinished,
    }).catch(() => {});

    req.log.info({ roomId, userId, newProgress, justFinished }, "[SponsoredStepSync] synced");
    return res.json({
      success: true,
      progress: {
        raceProgressSteps: newProgress,
        raceBaselineSteps: baseline,
        latestDeviceSteps,
        targetSteps: room.targetSteps ?? TARGET_STEPS,
        finished: justFinished,
      },
    });
  } catch (err) {
    req.log.error({ err }, "[SponsoredStepSync] failed");
    return res.status(500).json({ error: "Step sync failed." });
  }
});

// ── GET /api/sponsored-events/:roomId/results ─────────────────────────────────
// Returns finalized results for a completed (or in_progress) sponsored race.
router.get("/sponsored-events/:roomId/results", requireAuth, async (req, res) => {
  try {
    const roomId = String(req.params.roomId);

    const [room] = await db.select().from(raceRoomsTable)
      .where(and(eq(raceRoomsTable.id, roomId), eq(raceRoomsTable.type, "sponsored")))
      .limit(1);
    if (!room) return res.status(404).json({ error: "Event not found." });

    const parts = await db.select({
      userId:       raceParticipantsTable.userId,
      currentSteps: raceParticipantsTable.currentSteps,
      finishedGoal: raceParticipantsTable.finishedGoal,
      finishedAt:   raceParticipantsTable.finishedAt,
      finishRank:   raceParticipantsTable.finishRank,
      status:       raceParticipantsTable.status,
      username:     profilesTable.username,
      countryFlag:  profilesTable.countryFlag,
      avatarColor:  profilesTable.avatarColor,
    })
      .from(raceParticipantsTable)
      .innerJoin(profilesTable, eq(profilesTable.id, raceParticipantsTable.userId))
      .where(eq(raceParticipantsTable.raceRoomId, roomId))
      .orderBy(asc(raceParticipantsTable.finishedAt));

    const RACE_DURATION_MS = 3 * 60 * 60 * 1000;
    const endsAt = room.startedAt
      ? new Date(room.startedAt.getTime() + RACE_DURATION_MS)
      : null;

    const finishers = parts
      .filter((p) => p.finishedGoal && p.finishedAt)
      .sort((a, b) => (a.finishedAt?.getTime() ?? 0) - (b.finishedAt?.getTime() ?? 0));

    const winnerCount = parts.length === 1 ? 1 : WINNER_COUNT;
    const winners = finishers.slice(0, winnerCount);
    const winnerIds = new Set(winners.map((w) => w.userId));

    return res.json({
      success: true,
      event: {
        id: room.id,
        title: room.title,
        status: room.status,
        targetSteps: room.targetSteps,
        prizePoolCents: room.prizePoolCents,
        startedAt: room.startedAt?.toISOString() ?? null,
        endsAt: endsAt?.toISOString() ?? null,
      },
      participants: parts.map((p) => ({
        userId: p.userId,
        username: p.username,
        countryFlag: p.countryFlag,
        avatarColor: p.avatarColor,
        currentSteps: p.currentSteps,
        finishedGoal: p.finishedGoal,
        finishedAt: p.finishedAt?.toISOString() ?? null,
        finishRank: p.finishRank,
        isWinner: winnerIds.has(p.userId),
      })),
      winners: winners.map((w, i) => ({
        rank: i + 1,
        userId: w.userId,
        username: w.username,
        countryFlag: w.countryFlag,
        avatarColor: w.avatarColor,
        finishedAt: w.finishedAt?.toISOString() ?? null,
        rewardAmountUsd: PRIZE_PER_WINNER_CENTS / 100,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "[SponsoredResults] failed");
    return res.status(500).json({ error: "Failed to fetch results." });
  }
});

// ── PATCH /api/sponsored-events/:roomId/target-steps ─────────────────────────
// Admin/testing: update targetSteps for a scheduled or in_progress event.
router.patch("/sponsored-events/:roomId/target-steps", requireAuth, async (req, res) => {
  try {
    const roomId = String(req.params.roomId);
    const { targetSteps } = req.body as { targetSteps?: number };

    if (typeof targetSteps !== "number" || targetSteps < 1) {
      return res.status(400).json({ error: "targetSteps must be a positive number." });
    }

    const [room] = await db.select().from(raceRoomsTable)
      .where(and(eq(raceRoomsTable.id, roomId), eq(raceRoomsTable.type, "sponsored")))
      .limit(1);
    if (!room) return res.status(404).json({ error: "Event not found." });
    if (room.status === "completed" || room.status === "cancelled") {
      return res.status(409).json({ error: "Cannot update target steps for a finished event." });
    }

    await db.update(raceRoomsTable)
      .set({ targetSteps })
      .where(eq(raceRoomsTable.id, roomId));

    req.log.info({ roomId, targetSteps }, "[SponsoredEvents] target steps updated");
    return res.json({ success: true, roomId, targetSteps });
  } catch (err) {
    req.log.error({ err }, "[SponsoredEvents] target-steps update failed");
    return res.status(500).json({ error: "Failed to update target steps." });
  }
});

export default router;
