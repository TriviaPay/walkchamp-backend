import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import {
  raceRoomsTable,
  raceParticipantsTable,
  scheduledRoomRegistrationsTable,
  type RaceRoom,
} from "../../db/src/schema/races.js";
import { coinTransactionsTable } from "../../db/src/schema/coins.js";
import { createRefundBatchForRaceCancellation } from "./refundService.js";
import { recordCoinLedgerEntry } from "./coinsService.js";
import { triggerEvent } from "./pusher.js";
import { sendNotification } from "../routes/notifications.js";
import { enqueueJob } from "./queue.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * Shared Waiting Room lifecycle helpers (spec: authoritative Waiting Room behavior).
 *
 * This module owns the pure start-eligibility rule, the terminal (cancel/expire) transition with
 * refunds + exactly-once events/notifications, and durable job enqueueing. Scheduled auto-start
 * and open-window expiry ORCHESTRATION live in waitingRoomJobs.ts (which may import the race
 * activation path); this module must never import routes/races.ts to keep the dependency acyclic.
 */

export type CancellationReason =
  | "HOST_CANCELLED"
  | "MINIMUM_PARTICIPANTS_NOT_MET"
  | "HOST_DID_NOT_START_BEFORE_EXPIRATION"
  // Scheduled room started so late (worker outage / clock jump) that it is treated as a missed
  // window and cancelled rather than started/charged (audit 2026-08-17 M4).
  | "SCHEDULED_START_WINDOW_MISSED";

type RoomStartFields = Pick<
  RaceRoom,
  "mode" | "status" | "currentPlayers" | "minimumParticipants" | "roomExpiresAt"
>;

/**
 * Backend-authoritative "can the host start now?" rule. True only for a non-scheduled room that is
 * still in a startable state, has met the (frozen) minimum, and — for open-window rooms — is still
 * inside its 30-minute window. Scheduled rooms always return false (they auto-start on the server).
 */
export function computeCanStart(room: RoomStartFields, now: Date = new Date()): boolean {
  if (room.mode === "scheduled") return false;
  if (room.status !== "open" && room.status !== "full") return false;
  const minimum = room.minimumParticipants ?? config.waitingRoom.minimumParticipants;
  if (room.currentPlayers < minimum) return false;
  if (room.roomExpiresAt && now.getTime() >= room.roomExpiresAt.getTime()) return false;
  return true;
}

function cancellationCopy(reason: CancellationReason): { title: string; body: string } {
  switch (reason) {
    case "MINIMUM_PARTICIPANTS_NOT_MET":
      return {
        title: "Race cancelled",
        body: "Your race was cancelled because the minimum number of players was not reached.",
      };
    case "HOST_DID_NOT_START_BEFORE_EXPIRATION":
      return {
        title: "Waiting Room expired",
        body: "Your Waiting Room expired because the race was not started within 30 minutes.",
      };
    case "SCHEDULED_START_WINDOW_MISSED":
      return {
        title: "Race cancelled",
        body: "Your scheduled race could not start on time and was cancelled. Any entry fee has been refunded.",
      };
    case "HOST_CANCELLED":
    default:
      return { title: "Race cancelled", body: "Your race was cancelled by the host." };
  }
}

export interface TerminateResult {
  changed: boolean;
  terminalStatus: "cancelled" | "expired";
  reason: CancellationReason;
}

/**
 * Atomically move a pre-start room to a terminal state (cancelled/expired), apply refunds once
 * per existing pre-start rules, clear scheduled-room registrations, and emit exactly one realtime
 * event + one notification per participant/host. Idempotent: a room that is no longer pre-start is
 * a safe no-op. Refunds are deduped by the existing `race_cancel:{raceId}:{uid}` idempotency key,
 * so duplicate cancel/expire/scheduler retries never double-refund.
 */
export async function terminateWaitingRoom(
  roomId: string,
  input: {
    terminalStatus: "cancelled" | "expired";
    reason: CancellationReason;
    actor?: "host" | "system";
    hostUserId?: string | null;
  },
): Promise<TerminateResult> {
  const actor = input.actor ?? "system";
  const [pre] = await db.select().from(raceRoomsTable).where(eq(raceRoomsTable.id, roomId)).limit(1);
  if (!pre) return { changed: false, terminalStatus: input.terminalStatus, reason: input.reason };
  // Only pre-start rooms can be terminated; "starting"/"in_progress"/terminal → idempotent no-op.
  if (pre.status !== "open" && pre.status !== "full" && pre.status !== "scheduled") {
    return { changed: false, terminalStatus: input.terminalStatus, reason: input.reason };
  }

  let changed = false;
  if (pre.entryAmountCents > 0) {
    // Paid: refund + terminal transition + reason, all inside refundService's locked transaction.
    try {
      await createRefundBatchForRaceCancellation({
        raceId: roomId,
        actor,
        hostUserId: input.hostUserId ?? pre.creatorId,
        reasonCode: input.reason,
        terminalStatus: input.terminalStatus,
        cancellationReason: input.reason,
      });
      changed = true;
    } catch (err) {
      if (err instanceof Error && err.message === "RACE_NOT_CANCELABLE") {
        return { changed: false, terminalStatus: input.terminalStatus, reason: input.reason };
      }
      throw err;
    }
  } else {
    // Free / coins (nothing charged pre-start): status-guarded CAS terminal transition.
    const [row] = await db
      .update(raceRoomsTable)
      .set({
        status: input.terminalStatus,
        cancellationReason: input.reason,
        cancelledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(raceRoomsTable.id, roomId), inArray(raceRoomsTable.status, ["open", "full", "scheduled"])))
      .returning({ id: raceRoomsTable.id });
    if (!row) return { changed: false, terminalStatus: input.terminalStatus, reason: input.reason };
    changed = true;

    // Coins Battle entries are charged at activation (coinEntryAmount, not entryAmountCents), so a
    // room that was charged then reverted to "open" by the stuck-starting reconciler and is now
    // terminated would lose the deducted coins in this free/coins branch (audit 2026-08-17 M3).
    // Refund every coins_battle_entry spend for this room, idempotently.
    if (pre.entryType === "coins_battle") {
      const charges = await db
        .select({ userId: coinTransactionsTable.userId, amount: coinTransactionsTable.amount })
        .from(coinTransactionsTable)
        .where(and(
          eq(coinTransactionsTable.source, "coins_battle_entry"),
          eq(coinTransactionsTable.sourceId, roomId),
          eq(coinTransactionsTable.transactionType, "spend"),
        ));
      if (charges.length > 0) {
        await db.transaction(async (tx) => {
          for (const c of charges) {
            await recordCoinLedgerEntry(tx, {
              userId: c.userId,
              amount: Math.abs(c.amount),
              transactionType: "refund",
              source: "coins_battle_refund",
              sourceId: roomId,
              rewardCode: null,
              reasonCode: "coins_battle_cancelled",
              idempotencyKey: `coins-battle-refund:${c.userId}:${roomId}`,
              description: "Coins Battle entry refunded (room cancelled)",
              metadata: { raceId: roomId },
            });
          }
        });
      }
    }
  }

  // Clear scheduled-room state so participants are removed from active waiting-room lists.
  await db
    .update(scheduledRoomRegistrationsTable)
    .set({ status: "cancelled", cancelledAt: new Date() })
    .where(and(
      eq(scheduledRoomRegistrationsTable.raceRoomId, roomId),
      inArray(scheduledRoomRegistrationsTable.status, ["registered", "activated"]),
    ));

  // ── Exactly-once realtime + notifications (gated by the terminal transition above) ──
  const [parts, regs] = await Promise.all([
    db.select({ userId: raceParticipantsTable.userId })
      .from(raceParticipantsTable)
      .where(and(eq(raceParticipantsTable.raceRoomId, roomId), ne(raceParticipantsTable.status, "left"))),
    db.select({ userId: scheduledRoomRegistrationsTable.userId })
      .from(scheduledRoomRegistrationsTable)
      .where(eq(scheduledRoomRegistrationsTable.raceRoomId, roomId)),
  ]);
  const userIds = [...new Set([pre.creatorId, ...parts.map((p) => p.userId), ...regs.map((r) => r.userId)])];

  const terminalEvent = input.terminalStatus === "expired" ? "waiting_room_expired" : "waiting_room_cancelled";
  void triggerEvent(`public-live-race-${roomId}`, "race:cancelled", {
    raceId: roomId,
    reason: input.reason,
    cancellationReason: input.reason,
  });
  void triggerEvent("public-rooms-available", terminalEvent, {
    room_id: roomId,
    raceId: roomId,
    reason: input.reason,
    cancellationReason: input.reason,
  });

  const copy = cancellationCopy(input.reason);
  for (const uid of userIds) {
    sendNotification(uid, "race_cancelled", copy.title, copy.body, {
      raceId: roomId,
      reason: input.reason,
      dedupeKey: `${terminalEvent}:${roomId}`,
    }).catch(() => {});
  }

  logger.info(
    { roomId, terminalStatus: input.terminalStatus, reason: input.reason, actor },
    "[WaitingRoom] room terminated: %s (%s)",
    input.terminalStatus, input.reason,
  );
  return { changed: true, terminalStatus: input.terminalStatus, reason: input.reason };
}

/**
 * Enqueue the durable delayed job(s) that drive a room's authoritative lifecycle. Best-effort:
 * if the queue is unavailable the periodic reconciliation tick still processes the room by time.
 * jobId makes each enqueue idempotent (re-enqueue on restart/join does not create duplicates).
 */
export async function enqueueWaitingRoomLifecycleJobs(
  room: Pick<RaceRoom, "id" | "mode" | "roomExpiresAt" | "scheduledStartAt">,
): Promise<void> {
  try {
    if (room.mode === "open_window" && room.roomExpiresAt) {
      const delay = Math.max(0, room.roomExpiresAt.getTime() - Date.now());
      await enqueueJob("scheduled-jobs", "waiting_room.expire", { roomId: room.id }, { jobId: `wr-expire:${room.id}`, delay });
    } else if (room.mode === "scheduled" && room.scheduledStartAt) {
      const startDelay = Math.max(0, room.scheduledStartAt.getTime() - Date.now());
      await enqueueJob("scheduled-jobs", "waiting_room.scheduled_start", { roomId: room.id }, { jobId: `wr-start:${room.id}`, delay: startDelay });
      const reminderDelay = startDelay - 30 * 60_000;
      if (reminderDelay > 0) {
        await enqueueJob("scheduled-jobs", "waiting_room.scheduled_reminder", { roomId: room.id }, { jobId: `wr-remind:${room.id}`, delay: reminderDelay });
      }
    }
  } catch (err) {
    logger.warn({ err, roomId: room.id }, "[WaitingRoom] failed to enqueue lifecycle jobs (reconciler will recover)");
  }
}
