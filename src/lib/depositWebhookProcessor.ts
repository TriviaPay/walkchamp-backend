import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import {
  depositTransactionsTable,
  depositWebhookEventsTable,
} from "../../db/src/schema/index.js";
import {
  providerStateFromStripeSession,
  recordDepositProviderReversal,
  settleDepositOnce,
  settleRazorpayPayment,
  settleStripeCheckoutSession,
} from "./depositSettlement.js";
import { recordProviderRefundWebhook } from "./refundService.js";
import { logger } from "./logger.js";

type DepositWebhookProvider = "stripe" | "razorpay";

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" ? value : null;
}

function numberField(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  return typeof value === "number" ? value : null;
}

async function recordRazorpayFailedAttemptMetadata(eventId: string, eventType: string, body: Record<string, unknown>) {
  const payload = body.payload as {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        amount?: number;
        currency?: string;
        status?: string;
        error_code?: string;
        error_description?: string;
      };
    };
  } | undefined;
  const payment = payload?.payment?.entity;
  const orderId = payment?.order_id;
  if (!orderId) return;

  const [depositTx] = await db
    .select({ id: depositTransactionsTable.id, metadata: depositTransactionsTable.metadata })
    .from(depositTransactionsTable)
    .where(and(
      eq(depositTransactionsTable.provider, "razorpay"),
      eq(depositTransactionsTable.providerOrderId, orderId),
    ))
    .limit(1);

  if (!depositTx) return;

  const metadata = (depositTx.metadata as Record<string, unknown> | null) ?? {};
  const existingAttempts = Array.isArray(metadata.razorpayFailedAttempts)
    ? metadata.razorpayFailedAttempts
    : [];
  const failedAttempt = {
    eventId,
    eventType,
    paymentId: payment?.id ?? null,
    orderId,
    amountMinorUnits: payment?.amount ?? null,
    currency: payment?.currency ?? null,
    status: payment?.status ?? null,
    errorCode: payment?.error_code ?? null,
    errorDescription: payment?.error_description ?? null,
    recordedAt: new Date().toISOString(),
  };

  await db
    .update(depositTransactionsTable)
    .set({
      metadata: {
        ...metadata,
        razorpayFailedAttempts: [...existingAttempts.slice(-9), failedAttempt],
      },
      updatedAt: new Date(),
    })
    .where(eq(depositTransactionsTable.id, depositTx.id));
}

async function recordStripeDepositReversalFromEvent(event: Record<string, unknown>) {
  const eventId = stringField(event, "id");
  const eventType = stringField(event, "type") ?? "";
  const data = event.data as { object?: Record<string, unknown> } | undefined;
  const obj = data?.object ?? {};
  if (!eventId) return;

  if (eventType === "refund.updated" || eventType.startsWith("refund.")) {
    await recordDepositProviderReversal({
      provider: "stripe",
      providerPaymentId: stringField(obj, "payment_intent"),
      providerReversalId: stringField(obj, "id"),
      providerEventId: eventId,
      eventType,
      amountMinorUnits: numberField(obj, "amount"),
      currency: stringField(obj, "currency"),
      reversalType: "deposit_refund_debit",
      payload: obj,
    });
    return;
  }

  if (eventType === "charge.refunded") {
    const refunds = obj.refunds as { data?: Array<Record<string, unknown>> } | undefined;
    const latestRefund = refunds?.data?.[0];
    await recordDepositProviderReversal({
      provider: "stripe",
      providerPaymentId: stringField(obj, "payment_intent"),
      providerReversalId: latestRefund ? stringField(latestRefund, "id") : stringField(obj, "id"),
      providerEventId: eventId,
      eventType,
      amountMinorUnits: latestRefund ? numberField(latestRefund, "amount") : numberField(obj, "amount_refunded"),
      currency: stringField(obj, "currency"),
      reversalType: "deposit_refund_debit",
      payload: obj,
    });
    return;
  }

  if (eventType.startsWith("charge.dispute.")) {
    await recordDepositProviderReversal({
      provider: "stripe",
      providerPaymentId: stringField(obj, "payment_intent"),
      providerReversalId: stringField(obj, "id"),
      providerEventId: eventId,
      eventType,
      amountMinorUnits: numberField(obj, "amount"),
      currency: stringField(obj, "currency"),
      reversalType: "chargeback_debit",
      payload: obj,
    });
  }
}

async function processStripeDepositWebhook(event: Record<string, unknown>) {
  const eventType = stringField(event, "type") ?? "";
  const data = event.data as { object?: Record<string, unknown> } | undefined;
  const session = data?.object as Record<string, unknown> | undefined;

  if (
    eventType.startsWith("refund.")
    || eventType === "charge.refunded"
    || eventType.startsWith("charge.dispute.")
  ) {
    await recordStripeDepositReversalFromEvent(event);
  }

  if (
    eventType === "checkout.session.completed"
    || eventType === "checkout.session.async_payment_succeeded"
    || eventType === "checkout.session.async_payment_failed"
    || eventType === "checkout.session.expired"
  ) {
    const metadata = session?.metadata as { depositTransactionId?: string } | undefined;
    const depositTxId = metadata?.depositTransactionId ?? null;
    const sessionId = session?.id;
    if (!depositTxId || typeof sessionId !== "string") return;

    if (eventType === "checkout.session.async_payment_failed") {
      const providerState = providerStateFromStripeSession(session as never);
      await settleDepositOnce(depositTxId, { ...providerState, status: "failed" });
    } else {
      await settleStripeCheckoutSession(sessionId, depositTxId);
    }
  }
}

async function processRazorpayDepositWebhook(eventId: string, eventType: string, body: Record<string, unknown>) {
  if (eventType.startsWith("refund.")) {
    const payload = body.payload as { refund?: { entity?: Record<string, unknown> } } | undefined;
    const refundEntity = payload?.refund?.entity ?? {};
    const providerRefundId = typeof refundEntity.id === "string" ? refundEntity.id : null;
    await recordProviderRefundWebhook({
      provider: "razorpay",
      providerEventId: eventId,
      eventType,
      providerRefundId,
      payload: refundEntity,
    });
    await recordDepositProviderReversal({
      provider: "razorpay",
      providerPaymentId: typeof refundEntity.payment_id === "string" ? refundEntity.payment_id : null,
      providerReversalId: providerRefundId,
      providerEventId: eventId,
      eventType,
      amountMinorUnits: typeof refundEntity.amount === "number" ? refundEntity.amount : null,
      currency: typeof refundEntity.currency === "string" ? refundEntity.currency : null,
      reversalType: "deposit_refund_debit",
      payload: refundEntity,
    });
  }

  if (eventType.startsWith("dispute.")) {
    const payload = body.payload as { dispute?: { entity?: Record<string, unknown> } } | undefined;
    const disputeEntity = payload?.dispute?.entity ?? {};
    await recordDepositProviderReversal({
      provider: "razorpay",
      providerPaymentId: typeof disputeEntity.payment_id === "string" ? disputeEntity.payment_id : null,
      providerReversalId: typeof disputeEntity.id === "string" ? disputeEntity.id : null,
      providerEventId: eventId,
      eventType,
      amountMinorUnits: typeof disputeEntity.amount === "number" ? disputeEntity.amount : null,
      currency: typeof disputeEntity.currency === "string" ? disputeEntity.currency : null,
      reversalType: "chargeback_debit",
      payload: disputeEntity,
    });
  }

  if (eventType === "payment.captured" || eventType === "order.paid") {
    const payload = body.payload as {
      order?: { entity?: { id?: string; notes?: Record<string, unknown> } };
      payment?: { entity?: { id?: string; order_id?: string; notes?: Record<string, unknown> } };
    } | undefined;
    const orderId = payload?.order?.entity?.id ?? payload?.payment?.entity?.order_id;
    const razorpayPaymentId = payload?.payment?.entity?.id;

    if (orderId) {
      const webhookDepositId =
        typeof payload?.payment?.entity?.notes?.depositTransactionId === "string"
          ? payload.payment.entity.notes.depositTransactionId
          : typeof payload?.order?.entity?.notes?.depositTransactionId === "string"
            ? payload.order.entity.notes.depositTransactionId
            : null;

      const [depositTx] = await db
        .select()
        .from(depositTransactionsTable)
        .where(webhookDepositId
          ? and(
              eq(depositTransactionsTable.id, webhookDepositId),
              eq(depositTransactionsTable.provider, "razorpay"),
            )
          : and(
              eq(depositTransactionsTable.providerOrderId, orderId),
              eq(depositTransactionsTable.provider, "razorpay"),
            ))
        .limit(1);

      if (depositTx) {
        await settleRazorpayPayment({
          depositId: depositTx.id,
          orderId,
          paymentId: razorpayPaymentId,
        });
      }
    }
  }

  if (eventType === "payment.failed") {
    await recordRazorpayFailedAttemptMetadata(eventId, eventType, body);
    logger.info({ eventId }, "[PaymentBackend] razorpay payment.failed recorded without terminal deposit mutation");
  }
}

export async function processDepositWebhookEvent(input: {
  provider: DepositWebhookProvider;
  providerEventId: string;
}) {
  const [eventRow] = await db
    .select()
    .from(depositWebhookEventsTable)
    .where(and(
      eq(depositWebhookEventsTable.provider, input.provider),
      eq(depositWebhookEventsTable.providerEventId, input.providerEventId),
    ))
    .limit(1);

  if (!eventRow) throw new Error(`Deposit webhook event not found: ${input.provider}:${input.providerEventId}`);
  if (eventRow.processed) return { processed: false, reason: "already_processed" };

  await db
    .update(depositWebhookEventsTable)
    .set({
      processingStatus: "processing",
      processingAttemptCount: sql`${depositWebhookEventsTable.processingAttemptCount} + 1`,
      failureReason: null,
    })
    .where(eq(depositWebhookEventsTable.id, eventRow.id));

  try {
    if (input.provider === "stripe") {
      await processStripeDepositWebhook(eventRow.payload as Record<string, unknown>);
    } else {
      await processRazorpayDepositWebhook(
        input.providerEventId,
        eventRow.eventType,
        eventRow.payload as Record<string, unknown>,
      );
    }

    await db
      .update(depositWebhookEventsTable)
      .set({ processed: true, processedAt: new Date(), processingStatus: "processed", failureReason: null })
      .where(eq(depositWebhookEventsTable.id, eventRow.id));
    return { processed: true, reason: "processed" };
  } catch (err) {
    const failureReason = err instanceof Error ? err.message : "Unknown webhook processing failure";
    await db
      .update(depositWebhookEventsTable)
      .set({ processed: false, processingStatus: "failed_retryable", failureReason })
      .where(eq(depositWebhookEventsTable.id, eventRow.id));
    throw err;
  }
}
