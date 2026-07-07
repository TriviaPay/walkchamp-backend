import { db } from "../../db/src/index.js";
import {
  depositTransactionsTable,
  paymentsTable,
  promoCodesTable,
  raceParticipantsTable,
  raceRoomsTable,
  scheduledRoomRegistrationsTable,
  walletsTable,
} from "../../db/src/schema/index.js";
import { and, eq } from "drizzle-orm";

export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Lock order for all cash / race integrity flows touched by this patch:
// 1. payment / deposit row
// 2. race_room row
// 3. promo row
// 4. wallet row
// 5. participant / registration row
export const CASH_RACE_LOCK_ORDER = [
  "payment_or_deposit",
  "race_room",
  "promo",
  "wallet",
  "participant_or_registration",
] as const;

export function deriveOpenRoomStatus(currentPlayers: number, maxPlayers: number): "open" | "full" {
  return currentPlayers >= maxPlayers ? "full" : "open";
}

export async function lockRaceRoom(tx: DbTx, roomId: string) {
  const [room] = await tx
    .select()
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.id, roomId))
    .limit(1)
    .for("update");

  return room ?? null;
}

export async function lockPaymentById(tx: DbTx, paymentId: string) {
  const [payment] = await tx
    .select()
    .from(paymentsTable)
    .where(eq(paymentsTable.id, paymentId))
    .limit(1)
    .for("update");

  return payment ?? null;
}

export async function lockDepositTransactionById(tx: DbTx, transactionId: string) {
  const [depositTx] = await tx
    .select()
    .from(depositTransactionsTable)
    .where(eq(depositTransactionsTable.id, transactionId))
    .limit(1)
    .for("update");

  return depositTx ?? null;
}

export async function lockPromoCodeByCode(tx: DbTx, code: string) {
  const [promo] = await tx
    .select()
    .from(promoCodesTable)
    .where(eq(promoCodesTable.code, code))
    .limit(1)
    .for("update");

  return promo ?? null;
}

export async function lockWalletByUserId(tx: DbTx, userId: string) {
  const [wallet] = await tx
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.userId, userId))
    .limit(1)
    .for("update");

  return wallet ?? null;
}

export async function lockParticipant(tx: DbTx, raceRoomId: string, userId: string) {
  const [participant] = await tx
    .select()
    .from(raceParticipantsTable)
    .where(and(eq(raceParticipantsTable.raceRoomId, raceRoomId), eq(raceParticipantsTable.userId, userId)))
    .limit(1)
    .for("update");

  return participant ?? null;
}

export async function lockScheduledRegistration(tx: DbTx, raceRoomId: string, userId: string) {
  const [registration] = await tx
    .select()
    .from(scheduledRoomRegistrationsTable)
    .where(
      and(
        eq(scheduledRoomRegistrationsTable.raceRoomId, raceRoomId),
        eq(scheduledRoomRegistrationsTable.userId, userId),
      ),
    )
    .limit(1)
    .for("update");

  return registration ?? null;
}

type JoinParticipantOptions = {
  raceRoomId: string;
  userId: string;
  paymentId?: string | null;
  currentSteps?: number;
  raceBaselineSteps?: number;
  latestDeviceSteps?: number | null;
};

export async function joinOrReviveParticipant(
  tx: DbTx,
  opts: JoinParticipantOptions,
): Promise<{
  changed: boolean;
  reason: "inserted" | "revived" | "already_joined" | "blocked";
  participant: typeof raceParticipantsTable.$inferSelect;
}> {
  const existing = await lockParticipant(tx, opts.raceRoomId, opts.userId);

  if (!existing) {
    const [participant] = await tx
      .insert(raceParticipantsTable)
      .values({
        raceRoomId: opts.raceRoomId,
        userId: opts.userId,
        status: "joined",
        ...(opts.paymentId ? { paymentId: opts.paymentId } : {}),
        ...(opts.currentSteps !== undefined ? { currentSteps: opts.currentSteps } : {}),
        ...(opts.raceBaselineSteps !== undefined ? { raceBaselineSteps: opts.raceBaselineSteps } : {}),
        ...(opts.latestDeviceSteps !== undefined ? { latestDeviceSteps: opts.latestDeviceSteps } : {}),
      })
      .returning();

    return { changed: true, reason: "inserted", participant };
  }

  if (existing.status === "left") {
    const [participant] = await tx
      .update(raceParticipantsTable)
      .set({
        status: "joined",
        completedAt: null,
        ...(opts.paymentId ? { paymentId: opts.paymentId } : {}),
        ...(opts.currentSteps !== undefined ? { currentSteps: opts.currentSteps } : {}),
        ...(opts.raceBaselineSteps !== undefined ? { raceBaselineSteps: opts.raceBaselineSteps } : {}),
        ...(opts.latestDeviceSteps !== undefined ? { latestDeviceSteps: opts.latestDeviceSteps } : {}),
      })
      .where(eq(raceParticipantsTable.id, existing.id))
      .returning();

    return { changed: true, reason: "revived", participant };
  }

  if (existing.status === "forfeited" || existing.status === "disqualified") {
    return { changed: false, reason: "blocked", participant: existing };
  }

  return { changed: false, reason: "already_joined", participant: existing };
}

export async function registerOrReviveScheduledRegistration(
  tx: DbTx,
  raceRoomId: string,
  userId: string,
  opts: { registeredAt?: Date } = {},
): Promise<{
  changed: boolean;
  reason: "inserted" | "revived" | "already_registered";
  registration: typeof scheduledRoomRegistrationsTable.$inferSelect;
}> {
  const registeredAt = opts.registeredAt ?? new Date();
  const existing = await lockScheduledRegistration(tx, raceRoomId, userId);

  if (!existing) {
    const [registration] = await tx
      .insert(scheduledRoomRegistrationsTable)
      .values({ raceRoomId, userId, status: "registered", registeredAt })
      .returning();

    return { changed: true, reason: "inserted", registration };
  }

  if (existing.status === "cancelled") {
    const [registration] = await tx
      .update(scheduledRoomRegistrationsTable)
      .set({
        status: "registered",
        registeredAt,
        activatedAt: null,
        cancelledAt: null,
      })
      .where(eq(scheduledRoomRegistrationsTable.id, existing.id))
      .returning();

    return { changed: true, reason: "revived", registration };
  }

  return { changed: false, reason: "already_registered", registration: existing };
}
