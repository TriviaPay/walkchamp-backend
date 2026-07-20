import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import StripeConstructor from "stripe";
import Razorpay from "razorpay";
import { db } from "../../db/src/index.js";
import {
  coinTransactionsTable,
  paymentEventsTable,
  paymentsTable,
  outboxEventsTable,
  providerWebhookEventsTable,
  raceParticipantsTable,
  raceRoomsTable,
  refundAttemptsTable,
  refundBatchesTable,
  refundItemsTable,
  refundsTable,
  walletTransactionsTable,
  walletsTable,
  type Refund,
  type RefundItem,
} from "../../db/src/schema/index.js";
import { writeAuditLog } from "./auditLog.js";
import { config } from "./config.js";
import {
  lockRaceRoom,
  lockWalletByUserId,
  type DbTx,
} from "./raceIntegrity.js";
import { logger } from "./logger.js";
import {
  CASH_CHALLENGES_UNSUPPORTED_FOR_CURRENCY,
  CASH_CHALLENGES_UNSUPPORTED_FOR_CURRENCY_MESSAGE,
} from "./cashChallengeFees.js";

export type RefundItemStatus =
  | "requested"
  | "approved"
  | "queued"
  | "processing"
  | "provider_pending"
  | "succeeded"
  | "rejected"
  | "failed_retryable"
  | "failed_terminal"
  | "canceled"
  | "accounting_only_completed";

export type RefundStatus =
  | "requested"
  | "approved"
  | "queued"
  | "processing"
  | "provider_pending"
  | "partially_succeeded"
  | "succeeded"
  | "rejected"
  | "failed_retryable"
  | "failed_terminal"
  | "canceled";

const RESERVED_ITEM_STATUSES: RefundItemStatus[] = [
  "requested",
  "approved",
  "queued",
  "processing",
  "provider_pending",
  "succeeded",
  "failed_retryable",
];

const TERMINAL_ITEM_STATUSES = new Set<RefundItemStatus>([
  "succeeded",
  "rejected",
  "failed_terminal",
  "canceled",
  "accounting_only_completed",
]);

const SUCCESS_EQUIVALENT_STATUSES = new Set<RefundItemStatus>([
  "succeeded",
  "accounting_only_completed",
]);

type RefundWithItems = Refund & { items: RefundItem[] };

type Provider = "stripe" | "razorpay";

let stripeClient: InstanceType<typeof StripeConstructor> | null = null;
function getStripe() {
  if (stripeClient) return stripeClient;
  if (!config.payments.stripeSecretKey) throw new Error("STRIPE_SECRET_KEY is not configured.");
  stripeClient = new StripeConstructor(config.payments.stripeSecretKey, { apiVersion: "2026-05-27.dahlia" });
  return stripeClient;
}

let razorpayClient: InstanceType<typeof Razorpay> | null = null;
function getRazorpay() {
  if (razorpayClient) return razorpayClient;
  if (!config.payments.razorpayKeyId || !config.payments.razorpayKeySecret) {
    throw new Error("RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are not configured.");
  }
  razorpayClient = new Razorpay({
    key_id: config.payments.razorpayKeyId,
    key_secret: config.payments.razorpayKeySecret,
  });
  return razorpayClient;
}

export function isAmountReservedByRefundItem(status: string): boolean {
  return RESERVED_ITEM_STATUSES.includes(status as RefundItemStatus);
}

export function deriveRefundStatus(items: Array<{ status: string }>): RefundStatus {
  if (items.length === 0) return "requested";
  const statuses = items.map((i) => i.status as RefundItemStatus);
  const all = (predicate: (s: RefundItemStatus) => boolean) => statuses.every(predicate);
  const any = (predicate: (s: RefundItemStatus) => boolean) => statuses.some(predicate);

  if (all((s) => s === "rejected")) return "rejected";
  if (all((s) => SUCCESS_EQUIVALENT_STATUSES.has(s))) return "succeeded";
  if (any((s) => s === "succeeded") && any((s) => s === "failed_terminal")) return "partially_succeeded";
  if (!any((s) => s === "failed_terminal") && any((s) => s === "provider_pending")) return "provider_pending";
  if (any((s) => s === "processing")) return "processing";
  if (any((s) => s === "queued")) return "queued";
  const nonTerminal = statuses.filter((s) => !TERMINAL_ITEM_STATUSES.has(s));
  if (nonTerminal.length > 0 && nonTerminal.every((s) => s === "approved")) return "approved";
  if (!any((s) => s === "queued" || s === "processing" || s === "provider_pending") && any((s) => s === "failed_retryable")) {
    return "failed_retryable";
  }
  if (!any((s) => s === "succeeded") && statuses.every((s) => s === "failed_terminal")) return "failed_terminal";
  if (all((s) => s === "canceled")) return "canceled";
  return "requested";
}

function sanitizeReason(reasonCode: string): string {
  const normalized = reasonCode.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  return normalized.slice(0, 80) || "user_request";
}

function nowPatchForStatus(status: RefundStatus | RefundItemStatus) {
  const now = new Date();
  if (status === "approved") return { approvedAt: now };
  if (status === "queued") return { queuedAt: now };
  if (status === "processing") return { processingAt: now };
  if (status === "succeeded" || status === "partially_succeeded") return { succeededAt: now };
  if (status === "failed_retryable" || status === "failed_terminal") return { failedAt: now };
  if (status === "rejected") return { rejectedAt: now };
  if (status === "canceled") return { canceledAt: now };
  return {};
}

async function getRefundWithItems(refundId: string): Promise<RefundWithItems | null> {
  const [refund] = await db.select().from(refundsTable).where(eq(refundsTable.id, refundId)).limit(1);
  if (!refund) return null;
  const items = await db
    .select()
    .from(refundItemsTable)
    .where(eq(refundItemsTable.refundId, refundId))
    .orderBy(asc(refundItemsTable.createdAt));
  return { ...refund, items };
}

async function getRefundWithItemsTx(tx: DbTx, refundId: string): Promise<RefundWithItems | null> {
  const [refund] = await tx.select().from(refundsTable).where(eq(refundsTable.id, refundId)).limit(1);
  if (!refund) return null;
  const items = await tx
    .select()
    .from(refundItemsTable)
    .where(eq(refundItemsTable.refundId, refundId))
    .orderBy(asc(refundItemsTable.createdAt));
  return { ...refund, items };
}

export async function formatRefund(refundId: string) {
  const refund = await getRefundWithItems(refundId);
  if (!refund) return null;
  return serializeRefund(refund);
}

function serializeRefund(refund: RefundWithItems) {
  return {
    id: refund.id,
    userId: refund.userId,
    sourceType: refund.sourceType,
    sourceId: refund.sourceId,
    requestSource: refund.requestSource,
    reasonCode: refund.reasonCode,
    status: refund.status,
    requestedCashCents: refund.requestedCashCents,
    approvedCashCents: refund.approvedCashCents,
    succeededCashCents: refund.succeededCashCents,
    requestedCoinAmount: refund.requestedCoinAmount,
    succeededCoinAmount: refund.succeededCoinAmount,
    failureCode: refund.failureCode,
    failureMessage: refund.failureMessage,
    requestedAt: refund.requestedAt,
    approvedAt: refund.approvedAt,
    rejectedAt: refund.rejectedAt,
    queuedAt: refund.queuedAt,
    processingAt: refund.processingAt,
    succeededAt: refund.succeededAt,
    failedAt: refund.failedAt,
    items: refund.items.map((item) => ({
      id: item.id,
      status: item.status,
      assetType: item.assetType,
      destination: item.destination,
      provider: item.provider,
      providerRefundStatus: item.providerRefundStatus,
      requestedAmount: item.requestedAmount,
      approvedAmount: item.approvedAmount,
      succeededAmount: item.succeededAmount,
      currency: item.currency,
      failureCode: item.failureCode,
      failureMessage: item.failureMessage,
    })),
  };
}

async function refreshRefundStatus(tx: DbTx, refundId: string): Promise<void> {
  const items = await tx.select().from(refundItemsTable).where(eq(refundItemsTable.refundId, refundId));
  const status = deriveRefundStatus(items);
  const requestedCashCents = items
    .filter((i) => i.assetType === "cash")
    .reduce((sum, i) => sum + i.requestedAmount, 0);
  const approvedCashCents = items
    .filter((i) => i.assetType === "cash")
    .reduce((sum, i) => sum + i.approvedAmount, 0);
  const succeededCashCents = items
    .filter((i) => i.assetType === "cash")
    .reduce((sum, i) => sum + i.succeededAmount, 0);
  const requestedCoinAmount = items
    .filter((i) => i.assetType === "coins")
    .reduce((sum, i) => sum + i.requestedAmount, 0);
  const succeededCoinAmount = items
    .filter((i) => i.assetType === "coins")
    .reduce((sum, i) => sum + i.succeededAmount, 0);

  await tx
    .update(refundsTable)
    .set({
      status,
      requestedCashCents,
      approvedCashCents,
      succeededCashCents,
      requestedCoinAmount,
      succeededCoinAmount,
      updatedAt: new Date(),
      ...nowPatchForStatus(status),
    })
    .where(eq(refundsTable.id, refundId));
}

async function reservedAmountForComponent(tx: DbTx, originalComponentType: string, originalComponentId: string): Promise<number> {
  const items = await tx
    .select({ requestedAmount: refundItemsTable.requestedAmount, status: refundItemsTable.status })
    .from(refundItemsTable)
    .where(and(
      eq(refundItemsTable.originalComponentType, originalComponentType),
      eq(refundItemsTable.originalComponentId, originalComponentId),
      inArray(refundItemsTable.status, RESERVED_ITEM_STATUSES),
    ));
  return items.reduce((sum, item) => sum + item.requestedAmount, 0);
}

async function createRefundIntent(
  tx: DbTx,
  input: {
    userId: string;
    sourceType: string;
    sourceId: string;
    requestSource: string;
    reasonCode: string;
    createdByUserId?: string | null;
    idempotencyKey: string;
    metadata?: Record<string, unknown> | null;
  },
) {
  const [created] = await tx
    .insert(refundsTable)
    .values({
      userId: input.userId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      requestSource: input.requestSource,
      reasonCode: sanitizeReason(input.reasonCode),
      createdByUserId: input.createdByUserId ?? input.userId,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata ?? null,
    })
    .onConflictDoNothing()
    .returning();

  if (created) return created;

  const [existing] = await tx
    .select()
    .from(refundsTable)
    .where(eq(refundsTable.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (!existing) throw new Error("REFUND_IDEMPOTENCY_CONFLICT");
  return existing;
}

async function createProviderRefundItem(
  tx: DbTx,
  input: {
    refundId: string;
    actionKey: string;
    componentType: string;
    componentId: string;
    provider: Provider;
    providerPaymentId: string;
    amount: number;
    currency: string;
    requestBody: Record<string, unknown>;
  },
) {
  const reserved = await reservedAmountForComponent(tx, input.componentType, input.componentId);
  const refundable = input.amount - reserved;
  if (refundable <= 0) return null;

  const providerIdempotencyKey = `refund:${input.refundId}:${input.componentId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const [item] = await tx
    .insert(refundItemsTable)
    .values({
      refundId: input.refundId,
      originalComponentType: input.componentType,
      originalComponentId: input.componentId,
      refundActionKey: input.actionKey,
      assetType: "cash",
      currency: input.currency,
      destination: "provider",
      provider: input.provider,
      providerPaymentId: input.providerPaymentId,
      requestedAmount: refundable,
      approvedAmount: 0,
      status: "requested",
      providerRequestBody: { ...input.requestBody, amount: refundable },
      providerIdempotencyKey,
    })
    .onConflictDoNothing()
    .returning();
  return item ?? null;
}

async function createWalletRefundItem(
  tx: DbTx,
  input: {
    refundId: string;
    actionKey: string;
    walletDebit: typeof walletTransactionsTable.$inferSelect;
    reasonCode: string;
  },
) {
  const amount = refundableAmountForWalletDebit(input.walletDebit);
  const reserved = await reservedAmountForComponent(tx, "wallet_transaction", input.walletDebit.id);
  const refundable = amount - reserved;
  if (refundable <= 0) return null;

  const [item] = await tx
    .insert(refundItemsTable)
    .values({
      refundId: input.refundId,
      originalComponentType: "wallet_transaction",
      originalComponentId: input.walletDebit.id,
      refundActionKey: input.actionKey,
      assetType: "cash",
      currency: input.walletDebit.currency,
      destination: "wallet",
      requestedAmount: refundable,
      approvedAmount: refundable,
      status: "processing",
      metadata: {
        originalWalletTransactionId: input.walletDebit.id,
        reasonCode: input.reasonCode,
      },
    })
    .onConflictDoNothing()
    .returning();

  if (!item) return null;

  const wallet = await lockWalletByUserId(tx, input.walletDebit.userId);
  if (!wallet) {
    await tx
      .update(refundItemsTable)
      .set({
        status: "failed_retryable",
        failureCode: "wallet_missing",
        failureMessage: "Wallet not found for refund.",
        updatedAt: new Date(),
      })
      .where(eq(refundItemsTable.id, item.id));
    return item;
  }

  const before = wallet.availableBalanceCents;
  const after = before + refundable;
  await tx
    .update(walletsTable)
    .set({
      availableBalanceCents: sql`${walletsTable.availableBalanceCents} + ${refundable}`,
      updatedAt: new Date(),
    })
    .where(eq(walletsTable.id, wallet.id));

  const [walletTx] = await tx
    .insert(walletTransactionsTable)
    .values({
      walletId: wallet.id,
      userId: input.walletDebit.userId,
      transactionType: "race_entry_refund",
      amountCents: refundable,
      currency: input.walletDebit.currency,
      status: "completed",
      description: `Refund: ${input.reasonCode}`,
      raceRoomId: input.walletDebit.raceRoomId,
      paymentId: input.walletDebit.paymentId,
      refundId: input.refundId,
      refundItemId: item.id,
      balanceBeforeCents: before,
      balanceAfterCents: after,
      metadata: {
        originalWalletTransactionId: input.walletDebit.id,
      },
    })
    .returning();

  await tx
    .update(refundItemsTable)
    .set({
      status: "succeeded",
      succeededAmount: refundable,
      walletTransactionId: walletTx.id,
      updatedAt: new Date(),
    })
    .where(eq(refundItemsTable.id, item.id));

  return item;
}

async function createAccountingOnlyItem(
  tx: DbTx,
  input: {
    refundId: string;
    actionKey: string;
    componentType: string;
    componentId: string;
    amount: number;
    currency: string;
    metadata?: Record<string, unknown>;
  },
) {
  await tx
    .insert(refundItemsTable)
    .values({
      refundId: input.refundId,
      originalComponentType: input.componentType,
      originalComponentId: input.componentId,
      refundActionKey: input.actionKey,
      assetType: "promo",
      currency: input.currency,
      destination: "none",
      requestedAmount: input.amount,
      approvedAmount: input.amount,
      succeededAmount: input.amount,
      status: "accounting_only_completed",
      metadata: input.metadata ?? null,
    })
    .onConflictDoNothing();
}

export async function computeRefundEligibility(input: { paymentId?: string; raceId?: string; userId: string }) {
  if (input.paymentId) {
    const [payment] = await db
      .select()
      .from(paymentsTable)
      .where(and(eq(paymentsTable.id, input.paymentId), eq(paymentsTable.userId, input.userId)))
      .limit(1);
    if (!payment) return { eligible: false, reason: "payment_not_found", components: [] };
    if (payment.status !== "succeeded") return { eligible: false, reason: "payment_not_succeeded", components: [] };
    return {
      eligible: true,
      components: [{
        type: "payment",
        id: payment.id,
        amount: payment.amountCents,
        currency: payment.currency,
        provider: payment.stripePaymentIntentId ? "stripe" : "unknown",
      }],
    };
  }

  if (input.raceId) {
    const walletDebits = await db
      .select()
      .from(walletTransactionsTable)
      .where(and(
        eq(walletTransactionsTable.userId, input.userId),
        eq(walletTransactionsTable.raceRoomId, input.raceId),
        eq(walletTransactionsTable.transactionType, "race_entry_wallet_debit"),
      ));
    return {
      eligible: walletDebits.length > 0,
      reason: walletDebits.length > 0 ? null : "no_refundable_components",
      components: walletDebits.map((d) => ({
        type: "wallet_transaction",
        id: d.id,
        amount: refundableAmountForWalletDebit(d),
        currency: d.currency,
      })),
    };
  }

  return { eligible: false, reason: "unsupported_source", components: [] };
}

export async function createRefundForPaymentRequest(input: {
  paymentId: string;
  userId: string;
  reasonCode: string;
}) {
  const reasonCode = sanitizeReason(input.reasonCode);
  const refund = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from payments where id = ${input.paymentId} for update`);
    const [payment] = await tx
      .select()
      .from(paymentsTable)
      .where(and(eq(paymentsTable.id, input.paymentId), eq(paymentsTable.userId, input.userId)))
      .limit(1);
    if (!payment) throw new Error("PAYMENT_NOT_FOUND");
    return createRefundForPaymentRecordTx(tx, {
      payment,
      userId: input.userId,
      reasonCode,
      requestSource: "user_payment_request",
      idempotencyKey: `payment_refund:${payment.id}:${input.userId}:${reasonCode}`,
    });
  });

  return serializeRefund(refund);
}

export async function createRefundForPaymentRecordTx(
  tx: DbTx,
  input: {
    payment: typeof paymentsTable.$inferSelect;
    userId: string;
    reasonCode: string;
    requestSource: string;
    idempotencyKey: string;
  },
) {
  const payment = input.payment;
  if (payment.userId !== input.userId) throw new Error("PAYMENT_NOT_FOUND");
  if (payment.status !== "succeeded") throw new Error("PAYMENT_NOT_REFUNDABLE");
  if (!payment.stripePaymentIntentId) throw new Error("PAYMENT_PROVIDER_MISSING");

  const reasonCode = sanitizeReason(input.reasonCode);
  const parent = await createRefundIntent(tx, {
    userId: input.userId,
    sourceType: "payment",
    sourceId: payment.id,
    requestSource: input.requestSource,
    reasonCode,
    idempotencyKey: input.idempotencyKey,
    metadata: { paymentType: payment.paymentType, raceRoomId: payment.raceRoomId },
  });

  await createProviderRefundItem(tx, {
    refundId: parent.id,
    actionKey: input.idempotencyKey,
    componentType: "payment",
    componentId: payment.id,
    provider: "stripe",
    providerPaymentId: payment.stripePaymentIntentId,
    amount: payment.amountCents,
    currency: payment.currency,
    requestBody: {
      payment_intent: payment.stripePaymentIntentId,
      reason: "requested_by_customer",
      metadata: { refundId: parent.id, paymentId: payment.id },
    },
  });

  await refreshRefundStatus(tx, parent.id);
  const withItems = await getRefundWithItemsTx(tx, parent.id);
  if (!withItems) throw new Error("REFUND_NOT_FOUND");
  return withItems;
}

async function createRefundForRaceParticipantTx(
  tx: DbTx,
  input: {
    raceId: string;
    userId: string;
    reasonCode: string;
    requestSource: string;
    idempotencyKey: string;
  },
) {
  const reasonCode = sanitizeReason(input.reasonCode);
  const parent = await createRefundIntent(tx, {
    userId: input.userId,
    sourceType: "race",
    sourceId: input.raceId,
    requestSource: input.requestSource,
    reasonCode,
    idempotencyKey: input.idempotencyKey,
    metadata: { raceId: input.raceId },
  });

  const walletDebits = await tx
    .select()
    .from(walletTransactionsTable)
    .where(and(
      eq(walletTransactionsTable.userId, input.userId),
      eq(walletTransactionsTable.raceRoomId, input.raceId),
      eq(walletTransactionsTable.transactionType, "race_entry_wallet_debit"),
    ))
    .orderBy(asc(walletTransactionsTable.createdAt));

  for (const debit of walletDebits) {
    await tx.execute(sql`select id from wallet_transactions where id = ${debit.id} for update`);
    await createWalletRefundItem(tx, {
      refundId: parent.id,
      actionKey: input.idempotencyKey,
      walletDebit: debit,
      reasonCode,
    });
  }

  const promoAmount = walletDebits.reduce((sum, debit) => {
    const metadata = (debit.metadata as Record<string, unknown> | null) ?? null;
    const promo = typeof metadata?.promoDiscountCents === "number" ? metadata.promoDiscountCents : 0;
    return sum + promo;
  }, 0);
  if (promoAmount > 0) {
    await createAccountingOnlyItem(tx, {
      refundId: parent.id,
      actionKey: input.idempotencyKey,
      componentType: "promo_discount",
      componentId: `${input.raceId}:${input.userId}`,
      amount: promoAmount,
      currency: walletDebits[0]?.currency ?? "usd",
      metadata: { behavior: "non_reusable_discount_not_paid_to_user" },
    });
  }

  await refreshRefundStatus(tx, parent.id);
  const withItems = await getRefundWithItemsTx(tx, parent.id);
  if (!withItems) throw new Error("REFUND_NOT_FOUND");
  return withItems;
}

export async function createRefundForRaceLeave(input: {
  raceId: string;
  userId: string;
  reasonCode: string;
}) {
  const result = await db.transaction(async (tx) => {
    const room = await lockRaceRoom(tx, input.raceId);
    if (!room) throw new Error("RACE_NOT_FOUND");
    if (room.status !== "open" && room.status !== "full" && room.status !== "scheduled") {
      throw new Error("RACE_ALREADY_STARTED");
    }

    await tx.execute(sql`
      select id from race_participants
      where race_room_id = ${input.raceId} and user_id = ${input.userId}
      for update
    `);

    const [participant] = await tx
      .select()
      .from(raceParticipantsTable)
      .where(and(
        eq(raceParticipantsTable.raceRoomId, input.raceId),
        eq(raceParticipantsTable.userId, input.userId),
        ne(raceParticipantsTable.status, "left"),
      ))
      .limit(1);
    if (!participant) {
      const [existingRefund] = await tx
        .select()
        .from(refundsTable)
        .where(eq(refundsTable.idempotencyKey, `race_leave:${input.raceId}:${input.userId}`))
        .limit(1);
      if (existingRefund) {
        const withItems = await getRefundWithItemsTx(tx, existingRefund.id);
        if (!withItems) throw new Error("REFUND_NOT_FOUND");
        return { refund: withItems, participantStatus: "left" };
      }
      throw new Error("PARTICIPANT_NOT_FOUND");
    }
    if (room.status === "open" && room.creatorId === input.userId) throw new Error("HOST_MUST_CANCEL");

    const refund = await createRefundForRaceParticipantTx(tx, {
      raceId: input.raceId,
      userId: input.userId,
      reasonCode: input.reasonCode,
      requestSource: "race_leave",
      idempotencyKey: `race_leave:${input.raceId}:${input.userId}`,
    });

    await tx
      .update(raceParticipantsTable)
      .set({ status: "left", completedAt: new Date() })
      .where(eq(raceParticipantsTable.id, participant.id));

    await tx
      .update(raceRoomsTable)
      .set({
        currentPlayers: sql`GREATEST(${raceRoomsTable.currentPlayers} - 1, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(raceRoomsTable.id, input.raceId));

    return { refund, participantStatus: "left" };
  });

  return { ...result, refund: serializeRefund(result.refund) };
}

export async function createRefundBatchForRaceCancellation(input: {
  raceId: string;
  hostUserId: string;
  reasonCode: string;
}) {
  const batch = await db.transaction(async (tx) => {
    const room = await lockRaceRoom(tx, input.raceId);
    if (!room) throw new Error("RACE_NOT_FOUND");
    if (room.creatorId !== input.hostUserId) throw new Error("HOST_ONLY");
    if (room.status !== "open" && room.status !== "full" && room.status !== "scheduled") {
      if (room.status === "cancelled") {
        const [existingBatch] = await tx
          .select()
          .from(refundBatchesTable)
          .where(eq(refundBatchesTable.raceRoomId, input.raceId))
          .orderBy(desc(refundBatchesTable.createdAt))
          .limit(1);
        if (existingBatch) return existingBatch;
      }
      throw new Error("RACE_NOT_CANCELABLE");
    }

    const participants = await tx
      .select({ id: raceParticipantsTable.id, userId: raceParticipantsTable.userId })
      .from(raceParticipantsTable)
      .where(and(eq(raceParticipantsTable.raceRoomId, input.raceId), ne(raceParticipantsTable.status, "left")));

    const uniqueUserIds = [...new Set(participants.map((p) => p.userId))];
    const [refundBatch] = await tx
      .insert(refundBatchesTable)
      .values({
        sourceType: "race_cancellation",
        raceRoomId: input.raceId,
        status: "processing",
        totalItems: uniqueUserIds.length,
        metadata: { reasonCode: sanitizeReason(input.reasonCode), hostUserId: input.hostUserId },
      })
      .returning();

    let succeededItems = 0;
    let failedItems = 0;
    for (const uid of uniqueUserIds) {
      try {
        await createRefundForRaceParticipantTx(tx, {
          raceId: input.raceId,
          userId: uid,
          reasonCode: input.reasonCode,
          requestSource: "race_cancellation",
          idempotencyKey: `race_cancel:${input.raceId}:${uid}`,
        });
        succeededItems += 1;
      } catch (err) {
        failedItems += 1;
        logger.error({ err, raceId: input.raceId, userId: uid }, "[RefundService] race cancellation refund item failed");
      }
    }

    await tx
      .update(raceRoomsTable)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(raceRoomsTable.id, input.raceId));

    const status = failedItems > 0 && succeededItems > 0
      ? "partially_succeeded"
      : failedItems > 0
        ? "failed_retryable"
        : "succeeded";

    const [updatedBatch] = await tx
      .update(refundBatchesTable)
      .set({ status, succeededItems, failedItems, updatedAt: new Date() })
      .where(eq(refundBatchesTable.id, refundBatch.id))
      .returning();

    return updatedBatch;
  });

  return batch;
}

export async function approveRefund(input: {
  refundId: string;
  adminUserId: string;
  approvedItems?: Array<{ refundItemId: string; approvedAmount?: number; rejectReason?: string }>;
}) {
  const refund = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from refunds where id = ${input.refundId} for update`);
    const [parent] = await tx.select().from(refundsTable).where(eq(refundsTable.id, input.refundId)).limit(1);
    if (!parent) throw new Error("REFUND_NOT_FOUND");

    const items = await tx.select().from(refundItemsTable).where(eq(refundItemsTable.refundId, input.refundId));
    const approvalMap = new Map((input.approvedItems ?? []).map((i) => [i.refundItemId, i]));
    const now = new Date();

    for (const item of items) {
      if (TERMINAL_ITEM_STATUSES.has(item.status as RefundItemStatus) || item.status === "processing" || item.status === "provider_pending") {
        continue;
      }

      const explicit = approvalMap.get(item.id);
      if (input.approvedItems && !explicit) {
        await tx.update(refundItemsTable)
          .set({
            status: "rejected",
            failureCode: "partial_approval_rejected",
            failureMessage: "Rejected by partial approval.",
            updatedAt: now,
          })
          .where(eq(refundItemsTable.id, item.id));
        continue;
      }

      if (explicit?.rejectReason) {
        await tx.update(refundItemsTable)
          .set({
            status: "rejected",
            failureCode: "admin_rejected_item",
            failureMessage: explicit.rejectReason,
            updatedAt: now,
          })
          .where(eq(refundItemsTable.id, item.id));
        continue;
      }

      const approvedAmount = explicit?.approvedAmount ?? item.requestedAmount;
      if (approvedAmount <= 0 || approvedAmount > item.requestedAmount) {
        throw new Error("INVALID_APPROVED_AMOUNT");
      }

      if (item.destination === "provider") {
        await tx.update(refundItemsTable)
          .set({
            status: "queued",
            approvedAmount,
            providerRequestBody: {
              ...((item.providerRequestBody as Record<string, unknown> | null) ?? {}),
              amount: approvedAmount,
            },
            updatedAt: now,
          })
          .where(eq(refundItemsTable.id, item.id));

        await tx.insert(outboxEventsTable).values({
          topic: "refund-processing",
          eventType: "provider_refund.approved",
          aggregateType: "refund_item",
          aggregateId: item.id,
          idempotencyKey: `refund-provider:${item.id}`,
          payload: { refundItemId: item.id },
        }).onConflictDoNothing();
      } else if (item.destination === "wallet" || item.assetType === "coins") {
        if (approvedAmount !== item.requestedAmount) throw new Error("PARTIAL_WALLET_OR_COIN_APPROVAL_NOT_SUPPORTED");
      }
    }

    await tx
      .update(refundsTable)
      .set({ reviewedByUserId: input.adminUserId, approvedAt: now, updatedAt: now })
      .where(eq(refundsTable.id, input.refundId));
    await refreshRefundStatus(tx, input.refundId);
    const withItems = await getRefundWithItemsTx(tx, input.refundId);
    if (!withItems) throw new Error("REFUND_NOT_FOUND");
    return withItems;
  });

  void writeAuditLog({
    actorUserId: input.adminUserId,
    actorType: "admin",
    action: "refund.approve",
    entityType: "refund",
    entityId: input.refundId,
  });

  return serializeRefund(refund);
}

export async function rejectRefund(input: { refundId: string; adminUserId: string; reason: string }) {
  const refund = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from refunds where id = ${input.refundId} for update`);
    const items = await tx.select().from(refundItemsTable).where(eq(refundItemsTable.refundId, input.refundId));
    if (items.some((i) => ["processing", "provider_pending", "succeeded"].includes(i.status))) {
      throw new Error("REFUND_ALREADY_PROCESSING");
    }
    await tx
      .update(refundItemsTable)
      .set({
        status: "rejected",
        failureCode: "admin_rejected",
        failureMessage: input.reason,
        updatedAt: new Date(),
      })
      .where(eq(refundItemsTable.refundId, input.refundId));
    await tx
      .update(refundsTable)
      .set({
        reviewedByUserId: input.adminUserId,
        rejectedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(refundsTable.id, input.refundId));
    await refreshRefundStatus(tx, input.refundId);
    const withItems = await getRefundWithItemsTx(tx, input.refundId);
    if (!withItems) throw new Error("REFUND_NOT_FOUND");
    return withItems;
  });

  void writeAuditLog({
    actorUserId: input.adminUserId,
    actorType: "admin",
    action: "refund.reject",
    entityType: "refund",
    entityId: input.refundId,
    reason: input.reason,
  });

  return serializeRefund(refund);
}

function classifyProviderError(err: unknown): { status: RefundItemStatus; code: string; message: string; httpStatus?: number } {
  const anyErr = err as { statusCode?: number; status?: number; code?: string; message?: string };
  const httpStatus = anyErr.statusCode ?? anyErr.status;
  const message = anyErr.message ?? "Provider refund failed.";
  if (!httpStatus || httpStatus >= 500 || httpStatus === 409 || httpStatus === 429) {
    return { status: "failed_retryable", code: anyErr.code ?? "provider_retryable", message, httpStatus };
  }
  return { status: "failed_terminal", code: anyErr.code ?? "provider_terminal", message, httpStatus };
}

export async function processApprovedRefundJob(input: { refundItemId: string }) {
  const [item] = await db.select().from(refundItemsTable).where(eq(refundItemsTable.id, input.refundItemId)).limit(1);
  if (!item) throw new Error("REFUND_ITEM_NOT_FOUND");
  if (TERMINAL_ITEM_STATUSES.has(item.status as RefundItemStatus)) return;
  if (item.destination !== "provider" || !item.provider || !item.providerPaymentId) {
    throw new Error("REFUND_ITEM_NOT_PROVIDER_BACKED");
  }
  if (item.status !== "queued" && item.status !== "failed_retryable") return;

  const requestBody = ((item.providerRequestBody as Record<string, unknown> | null) ?? {});
  const idempotencyKey = item.providerIdempotencyKey ?? `refund:${item.id}`;

  const [attempt] = await db.insert(refundAttemptsTable).values({
    refundItemId: item.id,
    provider: item.provider,
    providerIdempotencyKey: idempotencyKey,
    requestBody,
  }).returning();

  await db.update(refundItemsTable)
    .set({ status: "processing", updatedAt: new Date() })
    .where(eq(refundItemsTable.id, item.id));
  await refreshRefundStatus(db as unknown as DbTx, item.refundId);

  try {
    let response: Record<string, unknown>;
    if (item.provider === "stripe") {
      const stripe = getStripe();
      const refund = await stripe.refunds.create(
        {
          payment_intent: String(requestBody.payment_intent ?? item.providerPaymentId),
          amount: item.approvedAmount,
          reason: "requested_by_customer",
          metadata: {
            refundId: item.refundId,
            refundItemId: item.id,
          },
        },
        { idempotencyKey },
      );
      response = refund as unknown as Record<string, unknown>;
      await db.update(refundItemsTable)
        .set({
          providerRefundId: refund.id,
          providerRefundStatus: refund.status ?? null,
          status: refund.status === "succeeded" ? "succeeded" : "provider_pending",
          succeededAmount: refund.status === "succeeded" ? item.approvedAmount : 0,
          updatedAt: new Date(),
        })
        .where(eq(refundItemsTable.id, item.id));
    } else if (item.provider === "razorpay") {
      const razorpay = getRazorpay();
      const body = {
        amount: item.approvedAmount,
        speed: "optimum",
        receipt: `refund-${item.id}`,
        notes: { refundId: item.refundId, refundItemId: item.id },
      };
      const refund = await (razorpay.payments as unknown as {
        refund: (paymentId: string, opts: unknown, headers?: unknown) => Promise<Record<string, unknown>>;
      }).refund(item.providerPaymentId, body, { "X-Refund-Idempotency": idempotencyKey });
      response = refund;
      const status = refund.status === "processed" ? "succeeded" : refund.status === "failed" ? "failed_terminal" : "provider_pending";
      await db.update(refundItemsTable)
        .set({
          providerRefundId: typeof refund.id === "string" ? refund.id : null,
          providerRefundStatus: typeof refund.status === "string" ? refund.status : null,
          status,
          succeededAmount: status === "succeeded" ? item.approvedAmount : 0,
          updatedAt: new Date(),
        })
        .where(eq(refundItemsTable.id, item.id));
    } else {
      throw new Error(`Unsupported refund provider: ${item.provider}`);
    }

    await db.update(refundAttemptsTable)
      .set({ responseBody: response, attemptStatus: "succeeded" })
      .where(eq(refundAttemptsTable.id, attempt.id));
  } catch (err) {
    const classified = classifyProviderError(err);
    await db.update(refundAttemptsTable)
      .set({
        attemptStatus: classified.status,
        httpStatus: classified.httpStatus ?? null,
        failureCode: classified.code,
        failureMessage: classified.message,
      })
      .where(eq(refundAttemptsTable.id, attempt.id));
    await db.update(refundItemsTable)
      .set({
        status: classified.status,
        failureCode: classified.code,
        failureMessage: classified.message,
        updatedAt: new Date(),
      })
      .where(eq(refundItemsTable.id, item.id));
  }

  await refreshRefundStatus(db as unknown as DbTx, item.refundId);
  await reconcileUnresolvedProviderEvents({ providerRefundId: item.providerRefundId ?? "" });
}

export async function reconcileProviderRefund(input: {
  provider: string;
  providerRefundId: string;
  eventPayload: Record<string, unknown>;
}) {
  const [item] = await db
    .select()
    .from(refundItemsTable)
    .where(and(eq(refundItemsTable.provider, input.provider), eq(refundItemsTable.providerRefundId, input.providerRefundId)))
    .limit(1);

  if (!item) return { reconciled: false };
  const entity = input.eventPayload.entity as Record<string, unknown> | undefined;
  const providerStatus = String(input.eventPayload.status ?? entity?.status ?? "");
  const eventAmount = input.eventPayload.amount ?? entity?.amount;
  const eventCurrency = input.eventPayload.currency ?? entity?.currency;
  const eventPaymentId = input.provider === "razorpay"
    ? input.eventPayload.payment_id ?? entity?.payment_id
    : input.eventPayload.payment_intent ?? entity?.payment_intent;

  // Coerce the amount before comparing. Previously the check only ran when
  // eventAmount was already a `number`, so a provider sending a string ("1000")
  // silently skipped amount verification. Now any PRESENT amount is coerced and
  // a non-integer or mismatching value is treated as a binding failure.
  const eventAmountRaw = eventAmount ?? null;
  const eventAmountNum = eventAmountRaw === null ? null : Number(eventAmountRaw);
  const amountMismatch =
    eventAmountRaw !== null && (!Number.isInteger(eventAmountNum) || eventAmountNum !== item.approvedAmount);

  const bindingMismatch =
    amountMismatch
    || (typeof eventCurrency === "string" && eventCurrency.trim().toLowerCase() !== item.currency.trim().toLowerCase())
    || (typeof eventPaymentId === "string" && item.providerPaymentId && eventPaymentId !== item.providerPaymentId);

  if (bindingMismatch) {
    logger.warn(
      {
        provider: input.provider,
        providerRefundId: input.providerRefundId,
        refundItemId: item.id,
        eventAmount: typeof eventAmount === "number" ? eventAmount : null,
        approvedAmount: item.approvedAmount,
        eventCurrency: typeof eventCurrency === "string" ? eventCurrency : null,
        itemCurrency: item.currency,
        eventPaymentId: typeof eventPaymentId === "string" ? eventPaymentId : null,
        itemProviderPaymentId: item.providerPaymentId,
      },
      "[RefundService] provider refund webhook binding mismatch",
    );
    return { reconciled: false, reason: "provider_refund_binding_mismatch" };
  }

  let status: RefundItemStatus = "provider_pending";
  if (input.provider === "stripe") {
    status = providerStatus === "succeeded" ? "succeeded" : providerStatus === "failed" ? "failed_terminal" : "provider_pending";
  } else if (input.provider === "razorpay") {
    status = providerStatus === "processed" ? "succeeded" : providerStatus === "failed" ? "failed_terminal" : "provider_pending";
  }

  await db.update(refundItemsTable)
    .set({
      status,
      providerRefundStatus: providerStatus || item.providerRefundStatus,
      succeededAmount: status === "succeeded" ? item.approvedAmount : item.succeededAmount,
      failureCode: status === "failed_terminal" ? "provider_refund_failed" : item.failureCode,
      failureMessage: status === "failed_terminal" ? "Provider marked refund failed." : item.failureMessage,
      updatedAt: new Date(),
    })
    .where(eq(refundItemsTable.id, item.id));
  await refreshRefundStatus(db as unknown as DbTx, item.refundId);
  return { reconciled: true };
}

export async function reconcileUnresolvedProviderEvents(input: { providerRefundId: string }) {
  if (!input.providerRefundId) return 0;
  const events = await db
    .select()
    .from(providerWebhookEventsTable)
    .where(and(eq(providerWebhookEventsTable.providerRefundId, input.providerRefundId), eq(providerWebhookEventsTable.unresolved, 1)))
    .orderBy(asc(providerWebhookEventsTable.receivedAt));
  let count = 0;
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    const reconciled = await reconcileProviderRefund({
      provider: event.provider,
      providerRefundId: input.providerRefundId,
      eventPayload: payload,
    });
    if (reconciled.reconciled) {
      await db.update(providerWebhookEventsTable)
        .set({ unresolved: 0, processed: 1, processingStatus: "processed", processedAt: new Date() })
        .where(eq(providerWebhookEventsTable.id, event.id));
      count += 1;
    }
  }
  return count;
}

export async function recordProviderRefundWebhook(input: {
  provider: Provider;
  providerEventId: string;
  eventType: string;
  providerRefundId: string | null;
  payload: Record<string, unknown>;
}) {
  const [created] = await db
    .insert(providerWebhookEventsTable)
    .values({
      provider: input.provider,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      providerRefundId: input.providerRefundId,
      payload: input.payload,
      processingStatus: "pending",
      unresolved: input.providerRefundId ? 0 : 1,
    })
    .onConflictDoNothing()
    .returning();
  if (!created) return { duplicate: true, reconciled: false };

  if (!input.providerRefundId) {
    await db.update(providerWebhookEventsTable)
      .set({ unresolved: 1, processingStatus: "unresolved" })
      .where(eq(providerWebhookEventsTable.id, created.id));
    return { duplicate: false, reconciled: false };
  }

  const result = await reconcileProviderRefund({
    provider: input.provider,
    providerRefundId: input.providerRefundId,
    eventPayload: input.payload,
  });
  await db.update(providerWebhookEventsTable)
    .set({
      processed: result.reconciled ? 1 : 0,
      unresolved: result.reconciled ? 0 : 1,
      processingStatus: result.reconciled ? "processed" : "unresolved",
      processedAt: result.reconciled ? new Date() : null,
    })
    .where(eq(providerWebhookEventsTable.id, created.id));
  return { duplicate: false, reconciled: result.reconciled };
}

export async function listRefunds(opts: { status?: string; limit?: number; offset?: number }) {
  const rows = await db
    .select()
    .from(refundsTable)
    .where(opts.status ? eq(refundsTable.status, opts.status) : undefined)
    .orderBy(desc(refundsTable.createdAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);
  return Promise.all(rows.map(async (r) => {
    const withItems = await getRefundWithItems(r.id);
    return withItems ? serializeRefund(withItems) : null;
  })).then((items) => items.filter(Boolean));
}

export async function getRefund(refundId: string) {
  const refund = await getRefundWithItems(refundId);
  return refund ? serializeRefund(refund) : null;
}

export async function getLatestRefundForSource(sourceType: string, sourceId: string, userId?: string) {
  const where = userId
    ? and(eq(refundsTable.sourceType, sourceType), eq(refundsTable.sourceId, sourceId), eq(refundsTable.userId, userId))
    : and(eq(refundsTable.sourceType, sourceType), eq(refundsTable.sourceId, sourceId));
  const [refund] = await db
    .select()
    .from(refundsTable)
    .where(where)
    .orderBy(desc(refundsTable.createdAt))
    .limit(1);
  if (!refund) return null;
  return getRefund(refund.id);
}

export async function getRefundBatch(batchId: string) {
  const [batch] = await db.select().from(refundBatchesTable).where(eq(refundBatchesTable.id, batchId)).limit(1);
  return batch ?? null;
}

export async function debitWalletForCashChallenge(tx: DbTx, input: {
  userId: string;
  raceRoomId: string;
  entryFeeCents: number;
  debitAmountCents?: number;
  description: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}) {
  const wallet = await lockWalletByUserId(tx, input.userId);
  if (!wallet) return { ok: false as const, error: "Wallet not found.", balanceCents: 0 };
  if (wallet.currency.toLowerCase() !== "usd") {
    return {
      ok: false as const,
      code: CASH_CHALLENGES_UNSUPPORTED_FOR_CURRENCY,
      error: CASH_CHALLENGES_UNSUPPORTED_FOR_CURRENCY_MESSAGE,
      balanceCents: wallet.availableBalanceCents,
    };
  }

  const idempotencyKey = input.idempotencyKey ?? `challenge_entry:${input.raceRoomId}:${input.userId}`;
  const [existingDebit] = await tx
    .select({ id: walletTransactionsTable.id })
    .from(walletTransactionsTable)
    .where(and(
      eq(walletTransactionsTable.userId, input.userId),
      eq(walletTransactionsTable.raceRoomId, input.raceRoomId),
      eq(walletTransactionsTable.transactionType, "race_entry_wallet_debit"),
      eq(walletTransactionsTable.status, "completed"),
    ))
    .limit(1);
  if (existingDebit) {
    return { ok: true as const, balanceCents: wallet.availableBalanceCents };
  }

  const debitAmountCents = input.debitAmountCents ?? input.entryFeeCents;
  if (!Number.isInteger(debitAmountCents) || debitAmountCents < input.entryFeeCents || debitAmountCents < 0) {
    return { ok: false as const, error: "Invalid cash challenge fee configuration.", balanceCents: wallet.availableBalanceCents };
  }

  if (wallet.availableBalanceCents < debitAmountCents) {
    return { ok: false as const, error: "Insufficient balance.", balanceCents: wallet.availableBalanceCents };
  }
  const before = wallet.availableBalanceCents;
  const after = before - debitAmountCents;
  await tx.update(walletsTable)
    .set({ availableBalanceCents: after, updatedAt: new Date() })
    .where(eq(walletsTable.id, wallet.id));
  await tx.insert(walletTransactionsTable).values({
    walletId: wallet.id,
    userId: input.userId,
    transactionType: "race_entry_wallet_debit",
    amountCents: -debitAmountCents,
    currency: wallet.currency,
    status: "completed",
    description: input.description,
    idempotencyKey,
    raceRoomId: input.raceRoomId,
    balanceBeforeCents: before,
    balanceAfterCents: after,
    metadata: input.metadata ?? null,
  });
  return { ok: true as const, balanceCents: after };
}

function refundableAmountForWalletDebit(debit: typeof walletTransactionsTable.$inferSelect): number {
  const debitedAmount = Math.abs(debit.amountCents);
  const metadata = (debit.metadata as Record<string, unknown> | null) ?? null;
  const configuredRefundable = metadata?.refundableAmountCents;
  if (typeof configuredRefundable !== "number" || !Number.isInteger(configuredRefundable)) {
    return debitedAmount;
  }
  return Math.max(0, Math.min(debitedAmount, configuredRefundable));
}
