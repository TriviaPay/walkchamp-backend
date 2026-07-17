import StripeConstructor from "stripe";
import Razorpay from "razorpay";
import { and, eq, lt, or, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import {
  depositTransactionsTable,
  walletsTable,
  walletTransactionsTable,
} from "../../db/src/schema/index.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { lockDepositTransactionById, lockWalletByUserId, type DbTx } from "./raceIntegrity.js";

export type DepositProvider = "stripe" | "razorpay";
export type ProviderSettlementStatus =
  | "paid"
  | "captured"
  | "processing"
  | "failed"
  | "expired"
  | "no_payment_required";

export interface DepositProviderState {
  provider: DepositProvider;
  providerOrderId: string;
  providerPaymentId?: string | null;
  amountMinorUnits: number | null;
  currency: string | null;
  status: ProviderSettlementStatus;
  metadataDepositTransactionId?: string | null;
  metadataUserId?: string | null;
  raw?: Record<string, unknown>;
}

export interface DepositSettlementResult {
  ok: boolean;
  status: string;
  settled: boolean;
  reason?: string;
}

type StripeClient = InstanceType<typeof StripeConstructor>;
type StripeCheckoutSession = Awaited<ReturnType<StripeClient["checkout"]["sessions"]["retrieve"]>>;

let stripeClient: StripeClient | null = null;
export function getStripe(): StripeClient {
  if (stripeClient) return stripeClient;
  if (!config.payments.stripeSecretKey) throw new Error("STRIPE_SECRET_KEY is not configured.");
  stripeClient = new StripeConstructor(config.payments.stripeSecretKey, { apiVersion: "2026-05-27.dahlia" });
  return stripeClient;
}

let razorpayClient: InstanceType<typeof Razorpay> | null = null;
export function getRazorpay(): InstanceType<typeof Razorpay> {
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

function normalizeCurrency(raw: string | null | undefined): string | null {
  const normalized = raw?.trim().toLowerCase();
  return normalized || null;
}

function expectedWalletCurrency(currency: string): "usd" | "inr" | null {
  const normalized = normalizeCurrency(currency);
  if (normalized === "usd" || normalized === "inr") return normalized;
  return null;
}

function mergeMetadata(
  existing: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...((existing as Record<string, unknown> | null) ?? {}),
    ...patch,
  };
}

async function ensureLockedWalletForSettlement(tx: DbTx, userId: string, currency: "usd" | "inr") {
  let wallet = await lockWalletByUserId(tx, userId);
  if (!wallet) {
    const [created] = await tx.insert(walletsTable).values({ userId, currency }).returning();
    wallet = created;
  }

  const walletCurrency = normalizeCurrency(wallet.currency);
  if (walletCurrency && walletCurrency !== currency) {
    return { wallet, mismatch: true as const };
  }

  if (!walletCurrency) {
    const [updated] = await tx
      .update(walletsTable)
      .set({ currency, updatedAt: new Date() })
      .where(eq(walletsTable.id, wallet.id))
      .returning();
    return { wallet: updated ?? wallet, mismatch: false as const };
  }

  return { wallet, mismatch: false as const };
}

function providerStatePatch(state: DepositProviderState) {
  return {
    providerStatus: state.status,
    providerAmountMinorUnits: state.amountMinorUnits,
    providerCurrency: state.currency,
    providerPaymentId: state.providerPaymentId ?? null,
    providerCheckedAt: new Date().toISOString(),
  };
}

async function updateDepositState(
  tx: DbTx,
  depositId: string,
  status: "processing" | "failed" | "expired" | "requires_review" | "settlement_error",
  reason: string,
  state: DepositProviderState,
) {
  const [deposit] = await tx
    .select({ metadata: depositTransactionsTable.metadata, status: depositTransactionsTable.status })
    .from(depositTransactionsTable)
    .where(eq(depositTransactionsTable.id, depositId))
    .limit(1);

  if (!deposit || deposit.status === "succeeded") {
    return;
  }

  if (status === "requires_review") {
    logger.warn(
      { depositId, provider: state.provider, providerOrderId: state.providerOrderId, providerPaymentId: state.providerPaymentId ?? null, reason },
      "[PaymentBackend] deposit moved to requires_review",
    );
  }

  await tx
    .update(depositTransactionsTable)
    .set({
      status,
      failureReason: status === "processing" ? null : reason,
      providerPaymentId: state.providerPaymentId ?? undefined,
      metadata: mergeMetadata(deposit.metadata, {
        ...providerStatePatch(state),
        settlementReason: reason,
      }),
      updatedAt: new Date(),
    })
    .where(eq(depositTransactionsTable.id, depositId));
}

function validationFailure(
  reason: string,
  status = "requires_review",
): DepositSettlementResult {
  return { ok: false, settled: false, status, reason };
}

export async function settleDepositOnce(
  depositId: string,
  state: DepositProviderState,
): Promise<DepositSettlementResult> {
  return db.transaction(async (tx) => {
    const lockedDeposit = await lockDepositTransactionById(tx, depositId);
    if (!lockedDeposit) {
      return validationFailure("deposit_not_found", "not_found");
    }

    if (lockedDeposit.status === "succeeded") {
      return { ok: true, settled: false, status: "succeeded", reason: "already_succeeded" };
    }

    if (lockedDeposit.provider !== state.provider) {
      await updateDepositState(tx, lockedDeposit.id, "requires_review", "provider_mismatch", state);
      return validationFailure("provider_mismatch");
    }

    if (lockedDeposit.providerOrderId !== state.providerOrderId) {
      await updateDepositState(tx, lockedDeposit.id, "requires_review", "provider_order_mismatch", state);
      return validationFailure("provider_order_mismatch");
    }

    if (state.metadataDepositTransactionId && state.metadataDepositTransactionId !== lockedDeposit.id) {
      await updateDepositState(tx, lockedDeposit.id, "requires_review", "metadata_deposit_mismatch", state);
      return validationFailure("metadata_deposit_mismatch");
    }

    if (state.metadataUserId && state.metadataUserId !== lockedDeposit.userId) {
      await updateDepositState(tx, lockedDeposit.id, "requires_review", "metadata_user_mismatch", state);
      return validationFailure("metadata_user_mismatch");
    }

    if (state.status === "processing") {
      await updateDepositState(tx, lockedDeposit.id, "processing", "provider_processing", state);
      return { ok: true, settled: false, status: "processing" };
    }

    if (state.status === "failed" || state.status === "expired") {
      await updateDepositState(tx, lockedDeposit.id, state.status, `provider_${state.status}`, state);
      return { ok: true, settled: false, status: state.status };
    }

    if (state.status === "no_payment_required") {
      await updateDepositState(tx, lockedDeposit.id, "requires_review", "no_payment_required_wallet_topup", state);
      return validationFailure("no_payment_required_wallet_topup");
    }

    if (state.amountMinorUnits !== lockedDeposit.amountMinorUnits) {
      await updateDepositState(tx, lockedDeposit.id, "requires_review", "amount_mismatch", state);
      return validationFailure("amount_mismatch");
    }

    const providerCurrency = normalizeCurrency(state.currency);
    const depositCurrency = normalizeCurrency(lockedDeposit.currency);
    if (!providerCurrency || providerCurrency !== depositCurrency) {
      await updateDepositState(tx, lockedDeposit.id, "requires_review", "currency_mismatch", state);
      return validationFailure("currency_mismatch");
    }

    const walletCurrency = expectedWalletCurrency(lockedDeposit.currency);
    if (!walletCurrency) {
      await updateDepositState(tx, lockedDeposit.id, "requires_review", "unsupported_wallet_currency", state);
      return validationFailure("unsupported_wallet_currency");
    }

    const walletResult = await ensureLockedWalletForSettlement(tx, lockedDeposit.userId, walletCurrency);
    if (walletResult.mismatch) {
      await updateDepositState(tx, lockedDeposit.id, "requires_review", "wallet_currency_mismatch", state);
      return validationFailure("wallet_currency_mismatch");
    }

    const creditMinor = lockedDeposit.walletCreditCents ?? lockedDeposit.amountMinorUnits;
    const before = walletResult.wallet.availableBalanceCents;
    const after = before + creditMinor;
    const idempotencyKey = `deposit_credit:${lockedDeposit.id}`;

    const insertedLedgerRows = await tx
      .insert(walletTransactionsTable)
      .values({
        walletId: walletResult.wallet.id,
        userId: lockedDeposit.userId,
        transactionType: "deposit_credit",
        amountCents: creditMinor,
        currency: walletCurrency,
        status: "completed",
        description: `Wallet deposit via ${state.provider}`,
        source: state.provider,
        idempotencyKey,
        depositTransactionId: lockedDeposit.id,
        balanceBeforeCents: before,
        balanceAfterCents: after,
        metadata: {
          providerOrderId: state.providerOrderId,
          providerPaymentId: state.providerPaymentId ?? null,
          providerStatus: state.status,
        },
      })
      .onConflictDoNothing()
      .returning({ id: walletTransactionsTable.id });

    if (insertedLedgerRows.length > 0) {
      await tx
        .update(walletsTable)
        .set({
          availableBalanceCents: after,
          totalEarnedCents: sql`${walletsTable.totalEarnedCents} + ${creditMinor}`,
          updatedAt: new Date(),
        })
        .where(eq(walletsTable.id, walletResult.wallet.id));
    }

    await tx
      .update(depositTransactionsTable)
      .set({
        status: "succeeded",
        providerPaymentId: state.providerPaymentId ?? lockedDeposit.providerPaymentId,
        creditedAt: lockedDeposit.creditedAt ?? new Date(),
        failureReason: null,
        metadata: mergeMetadata(lockedDeposit.metadata, {
          ...providerStatePatch(state),
          settlementLedgerInserted: insertedLedgerRows.length > 0,
          settledAt: new Date().toISOString(),
        }),
        updatedAt: new Date(),
      })
      .where(eq(depositTransactionsTable.id, lockedDeposit.id));

    return {
      ok: true,
      settled: insertedLedgerRows.length > 0,
      status: "succeeded",
      reason: insertedLedgerRows.length > 0 ? undefined : "ledger_already_exists",
    };
  });
}

export async function recordDepositProviderReversal(input: {
  provider: DepositProvider;
  providerPaymentId: string | null;
  providerReversalId: string | null;
  providerEventId: string;
  eventType: string;
  amountMinorUnits: number | null;
  currency: string | null;
  reversalType: "deposit_refund_debit" | "chargeback_debit";
  payload?: Record<string, unknown>;
}) {
  if (!input.providerPaymentId || !input.amountMinorUnits || input.amountMinorUnits <= 0) {
    return { recorded: false, reason: "missing_reversal_binding" };
  }
  const providerPaymentId = input.providerPaymentId;
  const reversalAmountMinorUnits = input.amountMinorUnits;

  return db.transaction(async (tx) => {
    const [deposit] = await tx
      .select()
      .from(depositTransactionsTable)
      .where(and(
        eq(depositTransactionsTable.provider, input.provider),
        eq(depositTransactionsTable.providerPaymentId, providerPaymentId),
        eq(depositTransactionsTable.status, "succeeded"),
      ))
      .limit(1)
      .for("update");

    if (!deposit) {
      return { recorded: false, reason: "deposit_not_found" };
    }

    const providerCurrency = normalizeCurrency(input.currency);
    const depositCurrency = normalizeCurrency(deposit.currency);
    if (!providerCurrency || providerCurrency !== depositCurrency) {
      await tx
        .update(depositTransactionsTable)
        .set({
          status: "requires_review",
          failureReason: "reversal_currency_mismatch",
          metadata: mergeMetadata(deposit.metadata, {
            reversalRequiresReview: {
              providerEventId: input.providerEventId,
              eventType: input.eventType,
              amountMinorUnits: input.amountMinorUnits,
              currency: input.currency,
            },
          }),
          updatedAt: new Date(),
        })
        .where(eq(depositTransactionsTable.id, deposit.id));
      return { recorded: false, reason: "currency_mismatch" };
    }

    const wallet = await lockWalletByUserId(tx, deposit.userId);
    if (!wallet) {
      return { recorded: false, reason: "wallet_not_found" };
    }

    const [existingReversalTotals] = await tx
      .select({
        reversedCents: sql<number>`coalesce(sum(abs(${walletTransactionsTable.amountCents})), 0)`,
      })
      .from(walletTransactionsTable)
      .where(and(
        eq(walletTransactionsTable.depositTransactionId, deposit.id),
        eq(walletTransactionsTable.status, "completed"),
        or(
          eq(walletTransactionsTable.transactionType, "deposit_refund_debit"),
          eq(walletTransactionsTable.transactionType, "chargeback_debit"),
        ),
      ));

    const creditedAmountMinorUnits = deposit.walletCreditCents ?? deposit.amountMinorUnits;
    const alreadyReversedMinorUnits = Number(existingReversalTotals?.reversedCents ?? 0);
    const remainingReversibleMinorUnits = Math.max(0, creditedAmountMinorUnits - alreadyReversedMinorUnits);
    const amountMinorUnits = Math.min(reversalAmountMinorUnits, remainingReversibleMinorUnits);
    if (amountMinorUnits <= 0) {
      await tx
        .update(depositTransactionsTable)
        .set({
          metadata: mergeMetadata(deposit.metadata, {
            ignoredReversalAfterFullDebit: {
              providerEventId: input.providerEventId,
              providerReversalId: input.providerReversalId,
              eventType: input.eventType,
              requestedAmountMinorUnits: reversalAmountMinorUnits,
              alreadyReversedMinorUnits,
              creditedAmountMinorUnits,
              recordedAt: new Date().toISOString(),
            },
          }),
          updatedAt: new Date(),
        })
        .where(eq(depositTransactionsTable.id, deposit.id));
      return { recorded: false, reason: "reversal_exceeds_deposit_credit" };
    }

    const before = wallet.availableBalanceCents;
    const after = before - amountMinorUnits;
    const idempotencyKey = `${input.reversalType}:${input.provider}:${input.providerReversalId ?? input.providerEventId}:${deposit.id}`;

    const inserted = await tx
      .insert(walletTransactionsTable)
      .values({
        walletId: wallet.id,
        userId: deposit.userId,
        transactionType: input.reversalType,
        amountCents: -amountMinorUnits,
        currency: wallet.currency,
        status: "completed",
        description: input.reversalType === "chargeback_debit"
          ? `Chargeback reversal for deposit ${deposit.id}`
          : `Refund reversal for deposit ${deposit.id}`,
        source: input.provider,
        idempotencyKey,
        depositTransactionId: deposit.id,
        balanceBeforeCents: before,
        balanceAfterCents: after,
        metadata: {
          providerEventId: input.providerEventId,
          providerReversalId: input.providerReversalId,
          eventType: input.eventType,
          providerPaymentId,
        },
      })
      .onConflictDoNothing()
      .returning({ id: walletTransactionsTable.id });

    if (inserted.length === 0) {
      return { recorded: false, reason: "duplicate_reversal" };
    }

    await tx
      .update(walletsTable)
      .set({
        availableBalanceCents: after,
        updatedAt: new Date(),
      })
      .where(eq(walletsTable.id, wallet.id));

    await tx
      .update(depositTransactionsTable)
      .set({
        metadata: mergeMetadata(deposit.metadata, {
          latestReversal: {
            providerEventId: input.providerEventId,
            providerReversalId: input.providerReversalId,
            eventType: input.eventType,
            amountMinorUnits,
            recordedAt: new Date().toISOString(),
          },
        }),
        updatedAt: new Date(),
      })
      .where(eq(depositTransactionsTable.id, deposit.id));

    return { recorded: true, reason: "recorded" };
  });
}

export function providerStateFromStripeSession(session: StripeCheckoutSession): DepositProviderState {
  const paymentStatus = session.payment_status;
  const status: ProviderSettlementStatus =
    paymentStatus === "paid"
      ? "paid"
      : paymentStatus === "no_payment_required"
        ? "no_payment_required"
        : session.status === "expired"
          ? "expired"
          : paymentStatus === "unpaid" || paymentStatus === "processing"
            ? "processing"
            : "failed";

  return {
    provider: "stripe",
    providerOrderId: session.id,
    providerPaymentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
    amountMinorUnits: session.amount_total ?? null,
    currency: session.currency ?? null,
    status,
    metadataDepositTransactionId: session.metadata?.depositTransactionId ?? null,
    metadataUserId: session.metadata?.userId ?? null,
    raw: {
      id: session.id,
      status: session.status,
      payment_status: session.payment_status,
      amount_total: session.amount_total,
      currency: session.currency,
    },
  };
}

export async function settleStripeCheckoutSession(sessionId: string, fallbackDepositId?: string | null) {
  const session = await getStripe().checkout.sessions.retrieve(sessionId);
  const depositId = session.metadata?.depositTransactionId ?? fallbackDepositId;
  if (!depositId) {
    return validationFailure("missing_deposit_metadata");
  }
  return settleDepositOnce(depositId, providerStateFromStripeSession(session));
}

type RazorpayPaymentEntity = {
  id?: string;
  order_id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  notes?: Record<string, unknown>;
};

function providerStateFromRazorpayPayment(payment: RazorpayPaymentEntity, fallbackOrderId?: string | null): DepositProviderState {
  const status: ProviderSettlementStatus =
    payment.status === "captured"
      ? "captured"
      : payment.status === "failed"
        ? "failed"
        : "processing";

  return {
    provider: "razorpay",
    providerOrderId: payment.order_id ?? fallbackOrderId ?? "",
    providerPaymentId: payment.id ?? null,
    amountMinorUnits: typeof payment.amount === "number" ? payment.amount : null,
    currency: payment.currency ?? null,
    status,
    metadataDepositTransactionId:
      typeof payment.notes?.depositTransactionId === "string" ? payment.notes.depositTransactionId : null,
    metadataUserId:
      typeof payment.notes?.userId === "string" ? payment.notes.userId : null,
    raw: payment as Record<string, unknown>,
  };
}

async function fetchRazorpayPayment(paymentId: string): Promise<RazorpayPaymentEntity> {
  return await (getRazorpay().payments as unknown as {
    fetch: (id: string) => Promise<RazorpayPaymentEntity>;
  }).fetch(paymentId);
}

async function captureRazorpayAuthorizedPayment(input: {
  depositId: string;
  orderId: string;
  payment: RazorpayPaymentEntity;
}): Promise<
  | { ok: true; payment: RazorpayPaymentEntity }
  | { ok: false; result: DepositSettlementResult }
> {
  const state = providerStateFromRazorpayPayment(input.payment, input.orderId);
  const [deposit] = await db
    .select()
    .from(depositTransactionsTable)
    .where(eq(depositTransactionsTable.id, input.depositId))
    .limit(1);

  if (!deposit) {
    return { ok: false, result: validationFailure("deposit_not_found", "not_found") };
  }
  if (deposit.status === "succeeded") {
    return { ok: true, payment: input.payment };
  }

  const providerCurrency = normalizeCurrency(input.payment.currency);
  const depositCurrency = normalizeCurrency(deposit.currency);
  const metadataDepositTransactionId =
    typeof input.payment.notes?.depositTransactionId === "string"
      ? input.payment.notes.depositTransactionId
      : null;
  const metadataUserId =
    typeof input.payment.notes?.userId === "string"
      ? input.payment.notes.userId
      : null;

  const captureBlockReason =
    deposit.provider !== "razorpay"
      ? "capture_provider_mismatch"
      : deposit.providerOrderId !== (input.payment.order_id ?? input.orderId)
        ? "capture_order_mismatch"
        : metadataDepositTransactionId && metadataDepositTransactionId !== deposit.id
          ? "capture_metadata_deposit_mismatch"
          : metadataUserId && metadataUserId !== deposit.userId
            ? "capture_metadata_user_mismatch"
            : input.payment.amount !== deposit.amountMinorUnits
              ? "capture_amount_mismatch"
              : !providerCurrency || providerCurrency !== depositCurrency
                ? "capture_currency_mismatch"
                : !input.payment.id
                  ? "capture_missing_payment_id"
                  : null;

  if (captureBlockReason) {
    logger.warn(
      {
        depositId: deposit.id,
        orderId: input.orderId,
        paymentId: input.payment.id ?? null,
        reason: captureBlockReason,
      },
      "[PaymentBackend] razorpay capture blocked before provider call",
    );
    await db.transaction(async (tx) => {
      await updateDepositState(tx, deposit.id, "requires_review", captureBlockReason, state);
    });
    return { ok: false, result: validationFailure(captureBlockReason) };
  }

  const paymentId = input.payment.id;
  const amount = input.payment.amount;
  const currency = input.payment.currency;
  if (!paymentId || typeof amount !== "number" || !currency) {
    return { ok: false, result: validationFailure("capture_missing_required_payment_fields") };
  }
  logger.info(
    { depositId: deposit.id, orderId: input.orderId, paymentId, amount, currency },
    "[PaymentBackend] razorpay capture attempt",
  );

  try {
    const captured = await (getRazorpay().payments as unknown as {
      capture: (paymentId: string, amount: number | string, currency: string) => Promise<RazorpayPaymentEntity>;
    }).capture(paymentId, amount, currency);

    logger.info(
      { depositId: deposit.id, orderId: input.orderId, paymentId, status: captured.status },
      "[PaymentBackend] razorpay capture completed",
    );
    await db
      .update(depositTransactionsTable)
      .set({
        metadata: mergeMetadata(deposit.metadata, {
          razorpayCapture: {
            paymentId,
            status: captured.status ?? null,
            capturedAt: new Date().toISOString(),
          },
        }),
        updatedAt: new Date(),
      })
      .where(eq(depositTransactionsTable.id, deposit.id));
    return { ok: true, payment: captured };
  } catch (err) {
    logger.error(
      { err, depositId: deposit.id, orderId: input.orderId, paymentId },
      "[PaymentBackend] razorpay capture failed",
    );

    try {
      const refetched = await fetchRazorpayPayment(paymentId);
      if (refetched.status === "captured") {
        logger.info(
          { depositId: deposit.id, orderId: input.orderId, paymentId },
          "[PaymentBackend] razorpay capture race resolved by refetch",
        );
        return { ok: true, payment: refetched };
      }
    } catch (refetchErr) {
      logger.warn(
        { err: refetchErr, depositId: deposit.id, orderId: input.orderId, paymentId },
        "[PaymentBackend] razorpay capture refetch failed",
      );
    }

    await db.transaction(async (tx) => {
      await updateDepositState(tx, deposit.id, "processing", "razorpay_capture_failed", {
        ...state,
        raw: {
          ...(state.raw ?? {}),
          captureFailedAt: new Date().toISOString(),
          captureFailure: err instanceof Error ? err.message : "Unknown Razorpay capture failure",
        },
      });
    });
    return {
      ok: false,
      result: {
        ok: true,
        settled: false,
        status: "processing",
        reason: "razorpay_capture_failed",
      },
    };
  }
}

async function fetchFirstCapturedPaymentForOrder(orderId: string): Promise<RazorpayPaymentEntity | null> {
  const result = await (getRazorpay().orders as unknown as {
    fetchPayments: (id: string) => Promise<{ items?: RazorpayPaymentEntity[] }>;
  }).fetchPayments(orderId);
  return result.items?.find((payment) => payment.status === "captured") ?? null;
}

export async function settleRazorpayPayment(input: {
  depositId: string;
  orderId: string;
  paymentId?: string | null;
}) {
  let payment = input.paymentId
    ? await fetchRazorpayPayment(input.paymentId)
    : await fetchFirstCapturedPaymentForOrder(input.orderId);

  if (!payment) {
    return db.transaction(async (tx) => {
      await updateDepositState(
        tx,
        input.depositId,
        "processing",
        "razorpay_payment_not_available",
        {
          provider: "razorpay",
          providerOrderId: input.orderId,
          amountMinorUnits: null,
          currency: null,
          status: "processing",
        },
      );
      return { ok: true, settled: false, status: "processing", reason: "razorpay_payment_not_available" };
    });
  }

  if (payment.status === "authorized") {
    const captureResult = await captureRazorpayAuthorizedPayment({
      depositId: input.depositId,
      orderId: input.orderId,
      payment,
    });
    if (!captureResult.ok) {
      return captureResult.result;
    }
    payment = captureResult.payment;
  }

  return settleDepositOnce(input.depositId, providerStateFromRazorpayPayment(payment, input.orderId));
}

async function reconcileOneDeposit(deposit: typeof depositTransactionsTable.$inferSelect) {
  if (!deposit.providerOrderId) {
    await db
      .update(depositTransactionsTable)
      .set({ status: "requires_review", failureReason: "missing_provider_order_id", updatedAt: new Date() })
      .where(eq(depositTransactionsTable.id, deposit.id));
    return;
  }

  if (deposit.provider === "stripe") {
    await settleStripeCheckoutSession(deposit.providerOrderId, deposit.id);
    return;
  }

  if (deposit.provider === "razorpay") {
    await settleRazorpayPayment({
      depositId: deposit.id,
      orderId: deposit.providerOrderId,
      paymentId: deposit.providerPaymentId,
    });
  }
}

export async function runDepositReconciliationTick(now = new Date()) {
  const tenMinutesAgo = new Date(now.getTime() - 10 * 60_000);
  const retryCutoff = new Date(now.getTime() - 2 * 60_000);
  const reviewCutoff = new Date(now.getTime() - 24 * 60 * 60_000);

  await db
    .update(depositTransactionsTable)
    .set({
      status: "requires_review",
      failureReason: "processing_timeout_requires_review",
      updatedAt: now,
    })
    .where(and(
      eq(depositTransactionsTable.status, "processing"),
      lt(depositTransactionsTable.updatedAt, reviewCutoff),
    ));

  const candidates = await db
    .select()
    .from(depositTransactionsTable)
    .where(or(
      and(eq(depositTransactionsTable.status, "processing"), lt(depositTransactionsTable.updatedAt, tenMinutesAgo)),
      and(eq(depositTransactionsTable.status, "settlement_error"), lt(depositTransactionsTable.updatedAt, retryCutoff)),
    ))
    .limit(50);

  let processed = 0;
  let failed = 0;
  for (const deposit of candidates) {
    try {
      await reconcileOneDeposit(deposit);
      processed += 1;
    } catch (err) {
      failed += 1;
      logger.error({ err, depositId: deposit.id, provider: deposit.provider }, "[DepositReconcile] deposit reconciliation failed");
      await db
        .update(depositTransactionsTable)
        .set({
          status: "settlement_error",
          failureReason: err instanceof Error ? err.message : "reconciliation_failed",
          updatedAt: new Date(),
        })
        .where(and(
          eq(depositTransactionsTable.id, deposit.id),
          eq(depositTransactionsTable.status, deposit.status),
        ));
    }
  }

  return { scanned: candidates.length, processed, failed };
}
