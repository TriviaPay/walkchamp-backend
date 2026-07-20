/**
 * Wallet Deposit Routes — Stripe (Checkout Session) + Razorpay (Order)
 *
 * Return flow uses HTTPS /done pages — NOT custom-scheme deep links.
 * Deep links caused Android "This screen doesn't exist" when Chrome Custom Tabs
 * fired the globalwalkerleague:// intent into Expo Go without a registered handler.
 *
 * The mobile app polls /status every 2 s while the browser is open.
 * When a terminal status is detected the app calls WebBrowser.dismissBrowser()
 * which closes the tab and the poll result drives the result modal — no deep links needed.
 *
 * TODO (production):
 *  - Replace test keys with live keys before going live.
 *  - Enable Razorpay webhook after Razorpay account verification is complete.
 *  - Enable Stripe webhook in production.
 */

import { Router, type Request } from "express";
import type { Logger } from "pino";
import { db } from "../../db/src/index.js";
import {
  depositTransactionsTable,
  depositWebhookEventsTable,
  walletsTable,
  profilesTable,
} from "../../db/src/schema/index.js";
import { eq, and, ne, sql } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import { z } from "zod";
import { createHash, randomUUID } from "crypto";
import { requireCashFeaturesEnabled } from "../middleware/requireCashFeaturesEnabled.js";
import { config } from "../lib/config.js";
import { recordOutboxEvent } from "../lib/outbox.js";
import { processDepositWebhookEvent } from "../lib/depositWebhookProcessor.js";
import {
  getRazorpay,
  getStripe,
  settleRazorpayPayment,
} from "../lib/depositSettlement.js";
import {
  verifyRazorpayCheckoutSignature,
  verifyRazorpaySignature,
} from "../lib/razorpaySecurity.js";

const router = Router();

router.use([
  "/wallet/deposit",
  "/webhooks/stripe",
  "/webhooks/razorpay",
], requireCashFeaturesEnabled);

// ── Config ────────────────────────────────────────────────────────────────────
const MIN_STRIPE_CENTS = 100;
const MAX_STRIPE_CENTS = 50000;
const MIN_RAZORPAY_PAISE = 1000;
const MAX_RAZORPAY_PAISE = 5000000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,160}$/;

function getBaseUrl(): string {
  const appBase = config.appBaseUrl;
  if (appBase) return appBase;
  return "http://localhost:8080";
}

/**
 * Returns an HTTPS URL for the in-browser "done" page.
 * Using HTTPS instead of the globalwalkerleague:// scheme prevents Android from
 * firing a system intent that opens Expo Go and causes a "screen not found" error.
 * The app's background poll detects the terminal status and dismisses the browser.
 */
function appDoneUrl(status: "success" | "processing" | "failed" | "cancelled", transactionId: string): string {
  return `${getBaseUrl()}/api/wallet/deposit/done?status=${status}&transaction_id=${encodeURIComponent(transactionId)}`;
}

function mergeMetadata(existing: unknown, patch: Record<string, unknown>) {
  return {
    ...((existing as Record<string, unknown> | null) ?? {}),
    ...patch,
  };
}

type StripeClient = ReturnType<typeof getStripe>;
type StripeCheckoutSession = Awaited<ReturnType<StripeClient["checkout"]["sessions"]["retrieve"]>>;
type StripeCreatedCheckoutSession = Awaited<ReturnType<StripeClient["checkout"]["sessions"]["create"]>>;
type StripeEvent = ReturnType<StripeClient["webhooks"]["constructEvent"]>;

// ── Wallet helpers ────────────────────────────────────────────────────────────
async function getOrCreateWalletForCurrency(userId: string, expectedCurrency: "usd" | "inr") {
  const [existing] = await db
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.userId, userId))
    .limit(1);
  if (!existing) {
    const [created] = await db.insert(walletsTable).values({ userId, currency: expectedCurrency }).returning();
    return { wallet: created, mismatch: false as const };
  }

  const walletCurrency = existing.currency.trim().toLowerCase();
  if (walletCurrency !== "usd" && walletCurrency !== "inr") {
    const [updated] = await db
      .update(walletsTable)
      .set({ currency: expectedCurrency, updatedAt: new Date() })
      .where(eq(walletsTable.id, existing.id))
      .returning();
    return { wallet: updated ?? existing, mismatch: false as const };
  }

  if (walletCurrency !== expectedCurrency) {
    return { wallet: existing, mismatch: true as const };
  }

  return { wallet: existing, mismatch: false as const };
}

/** Returns the ISO country code (e.g. "IN", "US") from the user's profile, or null if unset. */
async function getUserCountryCode(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ countryCode: profilesTable.countryCode })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);
  return row?.countryCode ?? null;
}

async function markDepositReturnObserved(
  transactionId: string,
  patch: Record<string, unknown>,
  opts: { onlyIfPending?: boolean } = {},
) {
  const [depositTx] = await db
    .select({ id: depositTransactionsTable.id, status: depositTransactionsTable.status, metadata: depositTransactionsTable.metadata })
    .from(depositTransactionsTable)
    .where(eq(depositTransactionsTable.id, transactionId))
    .limit(1);

  if (!depositTx) return;

  // For unauthenticated browser callbacks, only touch transactions that are
  // still pending. A settled (succeeded/failed) deposit must not have its
  // metadata rewritten by anyone who knows the transaction UUID.
  if (opts.onlyIfPending && depositTx.status !== "pending") return;

  await db
    .update(depositTransactionsTable)
    .set({
      metadata: {
        ...((depositTx.metadata as Record<string, unknown> | null) ?? {}),
        ...patch,
      },
      updatedAt: new Date(),
    })
    .where(eq(depositTransactionsTable.id, transactionId))
    .catch(() => {});
}

function getStripeReturnDisplayStatus(opts: {
  cancelStatus?: string;
  depositStatus?: string;
  sessionPaymentStatus?: StripeCheckoutSession["payment_status"] | null;
  sessionStatus?: StripeCheckoutSession["status"] | null;
}): "success" | "processing" | "cancelled" | "failed" {
  if (opts.cancelStatus === "cancelled") return "cancelled";
  if (opts.depositStatus === "succeeded") return "success";
  if (opts.depositStatus === "cancelled") return "cancelled";
  if (opts.depositStatus === "failed") return "failed";
  if (opts.sessionPaymentStatus === "paid") return "processing";
  if (opts.sessionStatus === "open") return "processing";
  return "failed";
}

// ═════════════════════════════════════════════════════════════════════════════
// STRIPE
// ═════════════════════════════════════════════════════════════════════════════

const stripeCreateSchema = z.object({
  amountCents: z.number().int().min(MIN_STRIPE_CENTS).max(MAX_STRIPE_CENTS),
});

/**
 * POST /api/wallet/deposit/stripe/create-payment-intent
 *
 * Creates a Stripe Checkout Session. Returns the hosted checkout URL and transactionId.
 * The app opens this URL with WebBrowser.openAuthSessionAsync so the deep-link return
 * is caught before expo-router can raise "screen does not exist".
 */
router.post("/wallet/deposit/stripe/create-payment-intent", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const userCountryCode = await getUserCountryCode(userId);
  req.log.info({ userId, userCountryCode }, "[PaymentBackend] user country: stripe check");
  if (userCountryCode === "IN") {
    req.log.info({ userId }, "[PaymentBackend] provider allowed: false — India user blocked from Stripe");
    return res.status(403).json({ error: "Stripe payments are not available in India. Please use Razorpay (INR)." });
  }

  const parsed = stripeCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: `Amount must be between $${(MIN_STRIPE_CENTS / 100).toFixed(2)} and $${(MAX_STRIPE_CENTS / 100).toFixed(2)}.`,
    });
  }

  let stripe: StripeClient;
  try {
    stripe = getStripe();
  } catch {
    return res.status(503).json({ error: "Payment provider not configured." });
  }

  const { amountCents } = parsed.data;
  const baseUrl = getBaseUrl();
  const walletResult = await getOrCreateWalletForCurrency(userId, "usd");

  if (walletResult.mismatch) {
    req.log.warn({ userId, walletCurrency: walletResult.wallet.currency, expectedCurrency: "usd" }, "[PaymentBackend] stripe: wallet currency mismatch");
    return res.status(409).json({ error: "Wallet currency does not support this payment provider." });
  }

  let depositTx: typeof depositTransactionsTable.$inferSelect;
  try {
    const [row] = await db
      .insert(depositTransactionsTable)
      .values({
        userId,
        provider: "stripe",
        status: "processing",
        amountMinorUnits: amountCents,
        currency: "USD",
        walletCreditCents: amountCents,
      })
      .returning();
    depositTx = row;
  } catch (err) {
    req.log.error({ err, userId, amountCents }, "[PaymentBackend] stripe: DB insert failed");
    return res.status(500).json({ error: "Failed to create payment record." });
  }

  let session: StripeCreatedCheckoutSession;
  try {
    session = await stripe.checkout.sessions.create(
      {
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: "WalkChamp Wallet Deposit" },
              unit_amount: amountCents,
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        success_url: `${baseUrl}/api/wallet/deposit/stripe/return?session_id={CHECKOUT_SESSION_ID}&transaction_id=${depositTx.id}`,
        cancel_url: `${baseUrl}/api/wallet/deposit/stripe/return?transaction_id=${depositTx.id}&status=cancelled`,
        metadata: { depositTransactionId: depositTx.id, userId },
      },
      { idempotencyKey: `deposit_checkout:${depositTx.id}` },
    );
  } catch (err) {
    req.log.error({ err, depositTxId: depositTx.id }, "[PaymentBackend] stripe: session create failed");
    await db.update(depositTransactionsTable)
      .set({ status: "failed", failureReason: "stripe_api_error", updatedAt: new Date() })
      .where(eq(depositTransactionsTable.id, depositTx.id))
      .catch(() => {});
    return res.status(502).json({ error: "Failed to create Stripe checkout. Please try again." });
  }

  await db
    .update(depositTransactionsTable)
    .set({ providerOrderId: session.id, status: "processing", updatedAt: new Date() })
    .where(eq(depositTransactionsTable.id, depositTx.id));

  req.log.info({ sessionId: session.id, txId: depositTx.id, amountCents }, "[PaymentBackend] stripe: checkout session created");

  return res.json({
    success: true,
    provider: "stripe",
    checkoutUrl: session.url,
    transactionId: depositTx.id,
  });
});

/**
 * GET /api/wallet/deposit/stripe/return
 *
 * Stripe redirects here after checkout completes or is cancelled.
 * Verifies PaymentIntent, credits wallet, then redirects to the app deep link.
 * WebBrowser.openAuthSessionAsync() intercepts the deep link before expo-router
 * — no "screen does not exist" error.
 */
router.get("/wallet/deposit/stripe/return", async (req, res) => {
  const { session_id, transaction_id, status: cancelStatus } = req.query as Record<string, string>;

  if (!transaction_id) {
    return res.redirect(appDoneUrl(cancelStatus === "cancelled" ? "cancelled" : "failed", ""));
  }

  if (cancelStatus === "cancelled" || !session_id) {
    await markDepositReturnObserved(transaction_id, {
      returnSeenAt: new Date().toISOString(),
      returnDisplayStatus: "cancelled",
    });
    return res.redirect(appDoneUrl("cancelled", transaction_id));
  }

  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(session_id);

    const [depositTx] = await db
      .select()
      .from(depositTransactionsTable)
      .where(eq(depositTransactionsTable.id, transaction_id))
      .limit(1);

    if (!depositTx) return res.redirect(appDoneUrl("failed", transaction_id));
    const bindingValid =
      depositTx.provider === "stripe"
      && depositTx.providerOrderId === session.id
      && session.metadata?.depositTransactionId === depositTx.id;

    if (!bindingValid) {
      req.log.warn(
        {
          transactionId: transaction_id,
          depositProvider: depositTx.provider,
          depositProviderOrderId: depositTx.providerOrderId,
          sessionId: session.id,
          sessionDepositTransactionId: session.metadata?.depositTransactionId ?? null,
        },
        "[PaymentBackend] stripe: return binding mismatch",
      );
      await markDepositReturnObserved(transaction_id, {
        returnSeenAt: new Date().toISOString(),
        returnSessionIdVerified: false,
        returnDisplayStatus: "failed",
      });
      return res.redirect(appDoneUrl("failed", transaction_id));
    }

    const displayStatus = getStripeReturnDisplayStatus({
      depositStatus: depositTx.status,
      sessionPaymentStatus: session.payment_status,
      sessionStatus: session.status,
    });

    await markDepositReturnObserved(transaction_id, {
      returnSeenAt: new Date().toISOString(),
      returnSessionIdVerified: true,
      returnDisplayStatus: displayStatus,
    });

    return res.redirect(appDoneUrl(displayStatus, transaction_id));
  } catch (err) {
    req.log.error({ err }, "[PaymentBackend] stripe: return endpoint error");
    return res.redirect(appDoneUrl("failed", transaction_id ?? ""));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// RAZORPAY
// ═════════════════════════════════════════════════════════════════════════════

const razorpayCreateSchema = z.object({
  amountPaise: z.number().int().min(MIN_RAZORPAY_PAISE).max(MAX_RAZORPAY_PAISE),
  idempotencyKey: z.string().trim().optional(),
});

class RazorpayCreateOrderHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body: Record<string, unknown>,
  ) {
    super(String(body.error ?? "Razorpay create-order failed."));
  }
}

function getClientIdempotencyKey(req: Request, bodyKey?: string | null) {
  const headerValue = req.headers["idempotency-key"];
  const headerKey = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return (headerKey ?? bodyKey ?? "").trim();
}

function validateClientIdempotencyKey(rawKey: string) {
  if (!IDEMPOTENCY_KEY_PATTERN.test(rawKey)) {
    return null;
  }
  return rawKey;
}

function buildRazorpayIdempotencyKey(userId: string, clientKey: string) {
  return `razorpay_deposit:${userId}:${clientKey}`;
}

/**
 * POST /api/wallet/deposit/razorpay/create-order
 *
 * Creates a Razorpay Order (INR) and returns a URL to the backend-hosted
 * checkout page for expo-web-browser to open.
 */
router.post("/wallet/deposit/razorpay/create-order", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const userCountryCode = await getUserCountryCode(userId);
  req.log.info({ userId, userCountryCode }, "[PaymentBackend] user country: razorpay check");
  if (!userCountryCode || userCountryCode !== "IN") {
    req.log.info({ userId, userCountryCode }, "[PaymentBackend] provider allowed: false — non-India user blocked from Razorpay");
    return res.status(403).json({ error: "Razorpay payments are only available for users in India. Please use Stripe (USD)." });
  }

  const parsed = razorpayCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: `Amount must be between ₹${MIN_RAZORPAY_PAISE / 100} and ₹${(MAX_RAZORPAY_PAISE / 100).toLocaleString()}.`,
    });
  }

  const rawClientIdempotencyKey = getClientIdempotencyKey(req, parsed.data.idempotencyKey);
  const clientIdempotencyKey = validateClientIdempotencyKey(rawClientIdempotencyKey)
    ?? `legacy:${randomUUID()}`;
  const clientProvidedIdempotencyKey = Boolean(validateClientIdempotencyKey(rawClientIdempotencyKey));
  if (!clientProvidedIdempotencyKey) {
    req.log.warn({ userId }, "[PaymentBackend] razorpay: legacy create-order without stable idempotency key");
  }

  let razorpay: ReturnType<typeof getRazorpay>;
  try {
    razorpay = getRazorpay();
  } catch {
    return res.status(503).json({ error: "Payment provider not configured." });
  }

  const { amountPaise } = parsed.data;
  const baseUrl = getBaseUrl();
  const walletCreditCents = amountPaise;
  const idempotencyKey = buildRazorpayIdempotencyKey(userId, clientIdempotencyKey);
  const walletResult = await getOrCreateWalletForCurrency(userId, "inr");

  if (walletResult.mismatch) {
    req.log.warn({ userId, walletCurrency: walletResult.wallet.currency, expectedCurrency: "inr" }, "[PaymentBackend] razorpay: wallet currency mismatch");
    return res.status(409).json({ error: "Wallet currency does not support this payment provider." });
  }

  let depositTx: typeof depositTransactionsTable.$inferSelect;
  let reusedIdempotentOrder = false;
  let shouldCreateProviderOrder = false;
  try {
    const reservation = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(depositTransactionsTable)
        .values({
          userId,
          provider: "razorpay",
          status: "order_creating",
          amountMinorUnits: amountPaise,
          currency: "INR",
          walletCreditCents,
          idempotencyKey,
          metadata: {
            clientIdempotencyKey,
            clientProvidedIdempotencyKey,
            idempotencyFirstSeenAt: new Date().toISOString(),
          },
        })
        .onConflictDoNothing()
        .returning();

      const row = inserted ?? (await tx
        .select()
        .from(depositTransactionsTable)
        .where(eq(depositTransactionsTable.idempotencyKey, idempotencyKey))
        .for("update")
        .limit(1))[0];

      if (!row) {
        throw new RazorpayCreateOrderHttpError(500, { error: "Failed to reserve payment record." });
      }

      const rowCurrency = row.currency.trim().toUpperCase();
      if (row.userId !== userId || row.provider !== "razorpay" || row.amountMinorUnits !== amountPaise || rowCurrency !== "INR") {
        req.log.warn(
          { userId, txId: row.id, requestedAmountPaise: amountPaise, existingAmountPaise: row.amountMinorUnits },
          "[PaymentBackend] razorpay: idempotency key conflict",
        );
        throw new RazorpayCreateOrderHttpError(409, {
          code: "IDEMPOTENCY_KEY_CONFLICT",
          error: "This idempotency key was already used for a different Razorpay deposit.",
        });
      }

      if (row.providerOrderId) {
        if (row.status === "failed" || row.status === "cancelled") {
          req.log.warn(
            { userId, txId: row.id, orderId: row.providerOrderId, status: row.status },
            "[PaymentBackend] razorpay: terminal idempotency key reused",
          );
          throw new RazorpayCreateOrderHttpError(409, {
            code: "IDEMPOTENCY_KEY_TERMINAL",
            error: "This payment attempt is already terminal. Start a new payment attempt.",
          });
        }
        reusedIdempotentOrder = true;
        req.log.info({ userId, txId: row.id, orderId: row.providerOrderId }, "[PaymentBackend] razorpay: idempotent order reused");
        return { depositTx: row, shouldCreateProviderOrder: false };
      }

      if (row.status === "order_creating" && !inserted) {
        req.log.info({ userId, txId: row.id }, "[PaymentBackend] razorpay: idempotent order still being created");
        throw new RazorpayCreateOrderHttpError(409, {
          code: "ORDER_CREATION_IN_PROGRESS",
          error: "This payment order is still being prepared. Retry with the same idempotency key shortly.",
        });
      }

      let reservedRow = row;
      if (row.status !== "order_creating") {
        const [updated] = await tx
          .update(depositTransactionsTable)
          .set({
            status: "order_creating",
            failureReason: null,
            metadata: mergeMetadata(row.metadata, {
              idempotencyRetryAt: new Date().toISOString(),
              previousStatus: row.status,
            }),
            updatedAt: new Date(),
          })
          .where(eq(depositTransactionsTable.id, row.id))
          .returning();
        reservedRow = updated ?? row;
      }

      return { depositTx: reservedRow, shouldCreateProviderOrder: true };
    });
    depositTx = reservation.depositTx;
    shouldCreateProviderOrder = reservation.shouldCreateProviderOrder;
  } catch (err) {
    if (err instanceof RazorpayCreateOrderHttpError) {
      return res.status(err.statusCode).json(err.body);
    }
    req.log.error({ err, userId, amountPaise }, "[PaymentBackend] razorpay: idempotent create-order reservation failed");
    return res.status(500).json({ error: "Failed to create payment record." });
  }

  if (shouldCreateProviderOrder) {
    let order: { id: string; amount: number; currency: string };
    try {
      order = await (razorpay.orders as unknown as { create: (opts: unknown) => Promise<typeof order> }).create({
        amount: amountPaise,
        currency: "INR",
        receipt: `wc_dep_${depositTx.id.replace(/-/g, "").slice(0, 20)}`,
        partial_payment: false,
        notes: { depositTransactionId: depositTx.id, userId },
      });
    } catch (err) {
      req.log.error({ err, depositTxId: depositTx.id }, "[PaymentBackend] razorpay: create-order API failed");
      await db.update(depositTransactionsTable)
        .set({
          status: "failed",
          failureReason: "razorpay_api_error",
          metadata: mergeMetadata(depositTx.metadata, {
            razorpayOrderCreateFailedAt: new Date().toISOString(),
          }),
          updatedAt: new Date(),
        })
        .where(eq(depositTransactionsTable.id, depositTx.id))
        .catch(() => {});
      return res.status(502).json({ error: "Failed to create Razorpay order. Please try again." });
    }

    let updated: typeof depositTransactionsTable.$inferSelect | undefined;
    try {
      [updated] = await db.transaction(async (tx) =>
        tx
          .update(depositTransactionsTable)
          .set({
            providerOrderId: order.id,
            status: "processing",
            metadata: mergeMetadata(depositTx.metadata, {
              razorpayOrderCreatedAt: new Date().toISOString(),
              razorpayOrderAmount: order.amount,
              razorpayOrderCurrency: order.currency,
            }),
            updatedAt: new Date(),
          })
          .where(and(
            eq(depositTransactionsTable.id, depositTx.id),
            eq(depositTransactionsTable.status, "order_creating"),
          ))
          .returning()
      );
    } catch (err) {
      req.log.error({ err, txId: depositTx.id, orderId: order.id }, "[PaymentBackend] razorpay: provider order created but DB binding update errored");
    }

    if (!updated) {
      req.log.error({ txId: depositTx.id, orderId: order.id }, "[PaymentBackend] razorpay: provider order created but DB binding failed");
      await db
        .update(depositTransactionsTable)
        .set({
          providerOrderId: order.id,
          status: "requires_review",
          failureReason: "razorpay_order_binding_failed",
          metadata: mergeMetadata(depositTx.metadata, {
            razorpayOrderCreatedAt: new Date().toISOString(),
            razorpayOrderAmount: order.amount,
            razorpayOrderCurrency: order.currency,
            bindingFailedAt: new Date().toISOString(),
          }),
          updatedAt: new Date(),
        })
        .where(eq(depositTransactionsTable.id, depositTx.id))
        .catch(() => {});
      return res.status(500).json({
        code: "RAZORPAY_ORDER_BINDING_FAILED",
        error: "Payment order was created but could not be linked. Please contact support before retrying.",
      });
    }

    depositTx = updated;
  }

  req.log.info(
    { orderId: depositTx.providerOrderId, txId: depositTx.id, amountPaise, reused: reusedIdempotentOrder },
    "[PaymentBackend] razorpay: order ready",
  );

  const checkoutUrl = `${baseUrl}/api/wallet/deposit/razorpay/checkout?tid=${depositTx.id}`;

  return res.json({
    success: true,
    provider: "razorpay",
    checkoutUrl,
    transactionId: depositTx.id,
  });
});

/**
 * GET /api/wallet/deposit/razorpay/checkout
 *
 * Serves a Razorpay checkout.js page.
 * On payment success, the page does a GET redirect to /verify (with Razorpay params).
 * The verify endpoint handles HMAC verification, wallet credit, then redirects to the
 * app deep link. WebBrowser.openAuthSessionAsync() intercepts it cleanly.
 * On cancel, the page redirects directly to the app deep link (cancelled status).
 */
router.get("/wallet/deposit/razorpay/checkout", async (req, res) => {
  const { tid } = req.query as Record<string, string>;
  if (!tid) return res.status(400).send("Missing transaction ID.");

  const [depositTx] = await db
    .select()
    .from(depositTransactionsTable)
    .where(eq(depositTransactionsTable.id, tid))
    .limit(1);

  if (!depositTx || !depositTx.providerOrderId) {
    return res.status(404).send("Transaction not found or not yet confirmed.");
  }

  if (depositTx.status === "succeeded") {
    return res.redirect(appDoneUrl("success", tid));
  }

  const keyId = process.env.RAZORPAY_KEY_ID ?? "";
  const baseUrl = getBaseUrl();
  const amountINR = (depositTx.amountMinorUnits / 100).toFixed(2);
  const verifyUrl   = `${baseUrl}/api/wallet/deposit/razorpay/verify`;
  const cancelUrl   = `${baseUrl}/api/wallet/deposit/razorpay/browser-cancel`;
  const failUrl     = `${baseUrl}/api/wallet/deposit/razorpay/browser-fail`;
  const doneBase    = `${baseUrl}/api/wallet/deposit/done`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
  <title>WalkChamp Pay</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .spinner{width:36px;height:36px;border:3px solid #222;border-top-color:#00b4ff;border-radius:50%;animation:spin 0.8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body>
  <div class="spinner"></div>
  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
  <script>
    var tid       = ${JSON.stringify(tid)};
    var verifyUrl = ${JSON.stringify(verifyUrl)};
    var cancelUrl = ${JSON.stringify(cancelUrl)};
    var failUrl   = ${JSON.stringify(failUrl)};
    var doneBase  = ${JSON.stringify(doneBase)};

    // POST to a no-auth server endpoint to update DB, then go to HTTPS done page.
    // Using HTTPS done page (not globalwalkerleague://) avoids Android firing a
    // system intent that opens Expo Go and shows "This screen doesn't exist".
    // The app's background poll detects the terminal status and closes the browser.
    function goToDone(status, apiUrl, reason) {
      var body = JSON.stringify({ transaction_id: tid, reason: reason || '' });
      fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
        .catch(function(){}) // ignore errors — server does idempotent update
        .finally(function() {
          window.location.href = doneBase + '?status=' + encodeURIComponent(status) + '&transaction_id=' + encodeURIComponent(tid);
        });
    }

    function startPayment() {
      var options = {
        key: ${JSON.stringify(keyId)},
        amount: ${JSON.stringify(String(depositTx.amountMinorUnits))},
        currency: 'INR',
        name: 'WalkChamp',
        description: 'Wallet Deposit \u20b9${amountINR}',
        order_id: ${JSON.stringify(depositTx.providerOrderId)},
        handler: function(response) {
          // Payment succeeded — server verifies signature and credits wallet,
          // then the page moves to the HTTPS done page.
          fetch(verifyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_order_id: response.razorpay_order_id,
              razorpay_signature: response.razorpay_signature,
              transaction_id: tid
            })
          })
            .then(function(r) { return r.json(); })
            .then(function(result) {
              var status = result && result.status ? result.status : 'processing';
              window.location.href = doneBase + '?status=' + encodeURIComponent(status) + '&transaction_id=' + encodeURIComponent(tid);
            })
            .catch(function() {
              window.location.href = doneBase + '?status=processing&transaction_id=' + encodeURIComponent(tid);
            });
        },
        prefill: { name: 'WalkChamp User' },
        theme: { color: '#00b4ff' },
        modal: {
          ondismiss: function() {
            // User closed the Razorpay modal without paying.
            goToDone('cancelled', cancelUrl);
          }
        }
      };

      try {
        var rzp = new Razorpay(options);
        rzp.on('payment.failed', function(resp) {
          // Covers "International cards not supported", declined, CVV wrong, etc.
          var reason = (resp && resp.error && resp.error.description) || 'payment_failed';
          goToDone('failed', failUrl, reason);
        });
        rzp.open();
      } catch(e) {
        goToDone('failed', failUrl, 'checkout_init_error');
      }
    }

    window.onload = startPayment;
  </script>
</body>
</html>`);
});

const razorpayVerifySchema = z.object({
  razorpay_payment_id: z.string().min(1),
  razorpay_order_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
  transaction_id: z.string().min(1),
});

async function verifyAndSettleRazorpayCallback(
  input: z.infer<typeof razorpayVerifySchema>,
  log: Pick<Logger, "warn" | "info" | "error">,
): Promise<{ status: "success" | "processing" | "failed"; transactionId: string }> {
  const {
    razorpay_payment_id,
    razorpay_order_id,
    razorpay_signature,
    transaction_id,
  } = input;

  try {
    const signatureValid = verifyRazorpayCheckoutSignature({
      secret: config.payments.razorpayKeySecret,
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      signature: razorpay_signature,
    });

    if (!signatureValid) {
      log.warn({ transaction_id, razorpay_payment_id }, "[PaymentBackend] razorpay verify: signature mismatch");
      await markDepositReturnObserved(transaction_id, {
        returnSeenAt: new Date().toISOString(),
        returnDisplayStatus: "failed",
        razorpayCallbackSignatureVerified: false,
      });
      return { status: "failed", transactionId: transaction_id };
    }

    const [depositTx] = await db
      .select()
      .from(depositTransactionsTable)
      .where(eq(depositTransactionsTable.id, transaction_id))
      .limit(1);

    if (!depositTx) {
      log.warn({ transaction_id }, "[PaymentBackend] razorpay verify: transaction not found");
      return { status: "failed", transactionId: transaction_id };
    }

    if (depositTx.providerOrderId !== razorpay_order_id) {
      log.warn({ transaction_id, razorpay_order_id }, "[PaymentBackend] razorpay verify: order_id mismatch");
      await markDepositReturnObserved(transaction_id, {
        returnSeenAt: new Date().toISOString(),
        returnDisplayStatus: "failed",
        razorpayCallbackSignatureVerified: true,
        razorpayOrderIdVerified: false,
      });
      return { status: "failed", transactionId: transaction_id };
    }

    await markDepositReturnObserved(transaction_id, {
      returnSeenAt: new Date().toISOString(),
      returnDisplayStatus: "processing",
      razorpayCallbackSignatureVerified: true,
      razorpayOrderIdVerified: true,
    });

    const settlement = await settleRazorpayPayment({
      depositId: transaction_id,
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
    });

    if (settlement.status === "succeeded") {
      log.info({ txId: transaction_id, settled: settlement.settled }, "[PaymentBackend] razorpay verify: settled from fetched provider state");
      return { status: "success", transactionId: transaction_id };
    }

    return {
      status: settlement.status === "processing" ? "processing" : "failed",
      transactionId: transaction_id,
    };
  } catch (err) {
    log.error({ err }, "[PaymentBackend] razorpay verify: exception");
    await db
      .update(depositTransactionsTable)
      .set({ status: "settlement_error", failureReason: "razorpay_verify_settlement_error", updatedAt: new Date() })
      .where(and(eq(depositTransactionsTable.id, transaction_id), ne(depositTransactionsTable.status, "succeeded")))
      .catch(() => {});
    return { status: "processing", transactionId: transaction_id };
  }
}

router.post("/wallet/deposit/razorpay/verify", async (req, res) => {
  const parsed = razorpayVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ issues: parsed.error.issues }, "[PaymentBackend] razorpay verify: invalid body");
    return res.status(400).json({ status: "failed", error: "Invalid Razorpay verification payload." });
  }

  const result = await verifyAndSettleRazorpayCallback(parsed.data, req.log);
  return res.json({ success: result.status === "success", status: result.status, transactionId: result.transactionId });
});

/**
 * Legacy GET compatibility for older hosted checkout pages.
 */
router.get("/wallet/deposit/razorpay/verify", async (req, res) => {
  const parsed = razorpayVerifySchema.safeParse(req.query);
  if (!parsed.success) {
    const transactionId = typeof req.query.transaction_id === "string" ? req.query.transaction_id : "";
    req.log.warn({ issues: parsed.error.issues }, "[PaymentBackend] razorpay verify: invalid query");
    return res.redirect(appDoneUrl("failed", transactionId));
  }

  const result = await verifyAndSettleRazorpayCallback(parsed.data, req.log);
  return res.redirect(appDoneUrl(result.status, result.transactionId));
});

// ═════════════════════════════════════════════════════════════════════════════
// DONE PAGE  (no auth — served to the browser after any payment outcome)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/wallet/deposit/done
 *
 * In-browser landing page shown after every payment outcome (success / processing / failed / cancelled).
 * Uses HTTPS instead of a globalwalkerleague:// deep link so Android never fires a
 * system intent that routes to Expo Go and shows "This screen doesn't exist".
 * The mobile app's background poll detects the terminal DB status and dismisses
 * the browser automatically — users normally never see this page for more than ~2 s.
 */
router.get("/wallet/deposit/done", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const transactionId = (req.query as Record<string, string>).transaction_id ?? "";
  return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
  <title>WalkChamp</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0a0a0a;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center}
    .wrap{max-width:320px}
    .icon{font-size:52px;margin-bottom:18px}
    h1{font-size:22px;font-weight:700;margin-bottom:10px;letter-spacing:-0.3px}
    p{font-size:15px;color:#888;line-height:1.5;margin-bottom:24px}
    .spinner{width:32px;height:32px;border:3px solid #1a1a1a;border-top-color:#00b4ff;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 18px}
    @keyframes spin{to{transform:rotate(360deg)}}
    .btn{display:inline-block;margin-top:8px;padding:14px 28px;background:#00b4ff;color:#fff;font-size:16px;font-weight:700;border-radius:12px;text-decoration:none;border:none;cursor:pointer}
    .btn:active{opacity:0.8}
  </style>
</head>
<body>
  <div class="wrap" id="root">
    <div class="spinner"></div>
    <p style="color:#555">Returning to WalkChamp…</p>
  </div>
  <script>
    var params = new URLSearchParams(location.search);
    var status = params.get('status') || 'success';
    var tid = ${JSON.stringify(transactionId)} || params.get('transaction_id') || '';
    var icons = { success:'✅', processing:'⏳', failed:'❌', cancelled:'↩️' };
    var titles = { success:'Payment Complete', processing:'Payment Processing', failed:'Payment Failed', cancelled:'Payment Cancelled' };
    var bodies = {
      success:   'Your wallet has been updated.',
      processing:'Your payment was received and is still being confirmed.',
      failed:    'Your payment could not be processed.',
      cancelled: 'Payment was cancelled.'
    };
    var s = (icons[status] ? status : 'success');
    var deepLink = 'globalwalkerleague://payment-complete?status=' + s + (tid ? '&transaction_id=' + encodeURIComponent(tid) : '');
    document.getElementById('root').innerHTML =
      '<div class="icon">' + icons[s] + '</div>' +
      '<h1>' + titles[s] + '</h1>' +
      '<p>' + bodies[s] + '</p>' +
      '<a class="btn" href="' + deepLink + '">Return to WalkChamp</a>';
    /* Auto-redirect back to the app after a short delay so the user sees the result */
    setTimeout(function() {
      try { window.location.href = deepLink; } catch(e) {}
    }, 800);
  </script>
</body>
</html>`);
});

// ═════════════════════════════════════════════════════════════════════════════
// RAZORPAY BROWSER CANCEL / FAIL  (no auth — called by in-browser JS)
// ═════════════════════════════════════════════════════════════════════════════

const browserUpdateSchema = z.object({
  transaction_id: z.string().uuid(),
  reason: z.string().max(200).optional(),
});

/**
 * POST /api/wallet/deposit/razorpay/browser-cancel
 *
 * Called from the Razorpay checkout HTML (ondismiss) to record browser UX state.
 * Browser cancellation is not provider settlement state.
 */
router.post("/wallet/deposit/razorpay/browser-cancel", async (req, res) => {
  const parsed = browserUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false });

  await markDepositReturnObserved(parsed.data.transaction_id, {
    browserCancelSeenAt: new Date().toISOString(),
    browserCancelReason: parsed.data.reason ?? "browser_cancel",
    returnDisplayStatus: "cancelled",
  }, { onlyIfPending: true });

  return res.json({ ok: true });
});

/**
 * POST /api/wallet/deposit/razorpay/browser-fail
 *
 * Called from the Razorpay checkout HTML (payment.failed event) to record browser
 * UX state. A later captured payment can still settle through verify/webhook.
 * No auth required — same rationale as browser-cancel.
 */
router.post("/wallet/deposit/razorpay/browser-fail", async (req, res) => {
  const parsed = browserUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false });

  const reason = parsed.data.reason ?? "razorpay_payment_failed";

  await markDepositReturnObserved(parsed.data.transaction_id, {
    browserFailSeenAt: new Date().toISOString(),
    browserFailReason: reason,
    returnDisplayStatus: "failed",
  }, { onlyIfPending: true });

  return res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════════════════
// LIST USER DEPOSITS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/wallet/deposit/list
 *
 * Returns the last 50 deposit transactions for the authenticated user.
 * Used to populate the transaction history in the wallet screen.
 */
router.get("/wallet/deposit/list", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const deposits = await db
    .select({
      id: depositTransactionsTable.id,
      provider: depositTransactionsTable.provider,
      status: depositTransactionsTable.status,
      amountMinorUnits: depositTransactionsTable.amountMinorUnits,
      currency: depositTransactionsTable.currency,
      walletCreditCents: depositTransactionsTable.walletCreditCents,
      createdAt: depositTransactionsTable.createdAt,
      creditedAt: depositTransactionsTable.creditedAt,
    })
    .from(depositTransactionsTable)
    .where(eq(depositTransactionsTable.userId, userId))
    .orderBy(sql`${depositTransactionsTable.createdAt} DESC`)
    .limit(50);

  return res.json({ deposits });
});

// ═════════════════════════════════════════════════════════════════════════════
// CANCEL / FAIL  (provider-agnostic, authenticated)
// ═════════════════════════════════════════════════════════════════════════════

const cancelSchema = z.object({
  transaction_id: z.string().uuid(),
  reason: z.string().optional(),
});

/**
 * POST /api/wallet/deposit/:provider/cancel
 *
 * Records user-observed cancellation. Provider settlement remains authoritative.
 */
router.post("/wallet/deposit/:provider/cancel", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const provider = String(req.params.provider);
  const parsed = cancelSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ success: false, error: "Missing transaction_id." });
  }

  const { transaction_id } = parsed.data;

  const [depositTx] = await db
    .select()
    .from(depositTransactionsTable)
    .where(
      and(
        eq(depositTransactionsTable.id, transaction_id),
        eq(depositTransactionsTable.userId, userId),
        eq(depositTransactionsTable.provider, provider),
      ),
    )
    .limit(1);

  if (!depositTx) {
    return res.status(404).json({ success: false, error: "Transaction not found." });
  }

  await markDepositReturnObserved(transaction_id, {
    userCancelSeenAt: new Date().toISOString(),
    userCancelReason: parsed.data.reason ?? "user_cancel",
    returnDisplayStatus: "cancelled",
  });

  req.log.info({ transaction_id, provider }, "[PaymentBackend] transaction cancelled");
  return res.json({ success: true, status: depositTx.status, displayStatus: "cancelled" });
});

// ═════════════════════════════════════════════════════════════════════════════
// STATUS CHECK
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/wallet/deposit/status/:transactionId
 *
 * Frontend polls this after payment to confirm final status and refresh wallet.
 */
router.get("/wallet/deposit/status/:transactionId", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const transactionId = String(req.params.transactionId);

  const [depositTx] = await db
    .select({
      id: depositTransactionsTable.id,
      status: depositTransactionsTable.status,
      provider: depositTransactionsTable.provider,
      amountMinorUnits: depositTransactionsTable.amountMinorUnits,
      currency: depositTransactionsTable.currency,
      walletCreditCents: depositTransactionsTable.walletCreditCents,
    })
    .from(depositTransactionsTable)
    .where(
      and(
        eq(depositTransactionsTable.id, transactionId),
        eq(depositTransactionsTable.userId, userId),
      ),
    )
    .limit(1);

  if (!depositTx) return res.status(404).json({ error: "Transaction not found" });

  return res.json({ transaction: depositTx });
});

// ═════════════════════════════════════════════════════════════════════════════
// WEBHOOKS (optional — non-crashing if secrets not configured)
// ═════════════════════════════════════════════════════════════════════════════

router.post("/webhooks/stripe", async (req, res) => {
  const sig = req.headers["stripe-signature"] as string;
  const webhookSecret = config.payments.stripeWebhookSecret;

  if (!webhookSecret) {
    if (process.env.NODE_ENV === "production") {
      req.log.error("[PaymentBackend] STRIPE_WEBHOOK_SECRET missing in production — rejecting webhook to prevent unsigned event injection.");
      return res.status(503).json({ error: "Webhook verification not configured." });
    }
    req.log.warn("[PaymentBackend] Stripe webhook secret not configured — disabled for dev.");
    return res.json({ received: true, warning: "webhook_disabled_no_secret" });
  }

  if (!sig) return res.status(400).json({ error: "Missing stripe-signature header" });

  let event: StripeEvent;
  try {
    event = getStripe().webhooks.constructEvent(req.body as Buffer, sig, webhookSecret);
  } catch {
    return res.status(400).json({ error: "Invalid webhook signature" });
  }

  req.log.info({ type: event.type, id: event.id }, "[PaymentBackend] stripe webhook received");

  const [existing] = await db
    .select()
    .from(depositWebhookEventsTable)
    .where(and(
      eq(depositWebhookEventsTable.provider, "stripe"),
      eq(depositWebhookEventsTable.providerEventId, event.id),
    ))
    .limit(1);

  if (existing?.processed) {
    await db
      .update(depositWebhookEventsTable)
      .set({ processingStatus: "ignored_duplicate", failureReason: null })
      .where(and(
        eq(depositWebhookEventsTable.provider, "stripe"),
        eq(depositWebhookEventsTable.providerEventId, event.id),
      ));
    return res.json({ received: true });
  }

  await db
    .insert(depositWebhookEventsTable)
    .values({
      provider: "stripe",
      providerEventId: event.id,
      eventType: event.type,
      payload: event as unknown as Record<string, unknown>,
      processingStatus: "received",
    })
    .onConflictDoNothing();

  await db
    .update(depositWebhookEventsTable)
    .set({ processingStatus: "signature_verified", failureReason: null })
    .where(and(
      eq(depositWebhookEventsTable.provider, "stripe"),
      eq(depositWebhookEventsTable.providerEventId, event.id),
    ));

  if (config.features.bullmqWebhookProcessingEnabled) {
    await recordOutboxEvent({
      topic: "webhook-processing",
      eventType: "deposit_webhook.process",
      aggregateType: "deposit_webhook_event",
      aggregateId: event.id,
      idempotencyKey: `deposit-webhook:stripe:${event.id}`,
      payload: { provider: "stripe", providerEventId: event.id },
    });
    return res.json({ received: true, queued: true });
  }

  await processDepositWebhookEvent({ provider: "stripe", providerEventId: event.id });
  return res.json({ received: true, queued: false });
});

router.post("/webhooks/razorpay", async (req, res) => {
  const webhookSecret = config.payments.razorpayWebhookSecret;

  if (!webhookSecret) {
    if (process.env.NODE_ENV === "production") {
      req.log.error("[PaymentBackend] RAZORPAY_WEBHOOK_SECRET missing in production — rejecting webhook to prevent unsigned event injection.");
      return res.status(503).json({ error: "Webhook verification not configured." });
    }
    req.log.warn("[PaymentBackend] Razorpay webhook secret not configured — disabled for dev.");
    return res.json({ received: true, warning: "webhook_disabled_no_secret" });
  }

  const signatureHeader = req.headers["x-razorpay-signature"];
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));

  if (!verifyRazorpaySignature({ secret: webhookSecret, payload: rawBody, signature })) {
    return res.status(400).json({ error: "Invalid webhook signature" });
  }

  const body = (Buffer.isBuffer(req.body)
    ? JSON.parse(req.body.toString())
    : req.body) as Record<string, unknown>;
  const eventType = String(body.event ?? "");
  const headerEventId = typeof req.headers["x-razorpay-event-id"] === "string"
    && req.headers["x-razorpay-event-id"].trim()
    ? req.headers["x-razorpay-event-id"].trim()
    : null;
  const bodyEventId = typeof body.id === "string" && body.id.trim() ? body.id.trim() : null;
  const eventId = headerEventId ?? bodyEventId ?? `rzp-${createHash("sha256").update(rawBody).digest("hex").slice(0, 32)}`;

  if (!headerEventId) {
    req.log.warn(
      { eventType, eventId, hasBodyEventId: Boolean(bodyEventId) },
      "[PaymentBackend] razorpay webhook missing x-razorpay-event-id; using fallback id",
    );
  }

  req.log.info({ eventType, eventId }, "[PaymentBackend] razorpay webhook received");

  const [existing] = await db
    .select()
    .from(depositWebhookEventsTable)
    .where(and(
      eq(depositWebhookEventsTable.provider, "razorpay"),
      eq(depositWebhookEventsTable.providerEventId, eventId),
    ))
    .limit(1);

  if (existing?.processed) {
    req.log.info({ eventType, eventId }, "[PaymentBackend] razorpay webhook duplicate ignored");
    await db
      .update(depositWebhookEventsTable)
      .set({ processingStatus: "ignored_duplicate", failureReason: null })
      .where(and(
        eq(depositWebhookEventsTable.provider, "razorpay"),
        eq(depositWebhookEventsTable.providerEventId, eventId),
      ));
    return res.json({ received: true });
  }

  await db
    .insert(depositWebhookEventsTable)
    .values({ provider: "razorpay", providerEventId: eventId, eventType, payload: body, processingStatus: "received" })
    .onConflictDoNothing();

  await db
    .update(depositWebhookEventsTable)
    .set({ processingStatus: "signature_verified", failureReason: null })
    .where(and(
      eq(depositWebhookEventsTable.provider, "razorpay"),
      eq(depositWebhookEventsTable.providerEventId, eventId),
    ));

  if (config.features.bullmqWebhookProcessingEnabled) {
    await recordOutboxEvent({
      topic: "webhook-processing",
      eventType: "deposit_webhook.process",
      aggregateType: "deposit_webhook_event",
      aggregateId: eventId,
      idempotencyKey: `deposit-webhook:razorpay:${eventId}`,
      payload: { provider: "razorpay", providerEventId: eventId },
    });
    return res.json({ received: true, queued: true });
  }

  await processDepositWebhookEvent({ provider: "razorpay", providerEventId: eventId });
  return res.json({ received: true, queued: false });
});

export default router;
