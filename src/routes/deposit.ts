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

import { Router } from "express";
import { db } from "@db";
import {
  depositTransactionsTable,
  depositWebhookEventsTable,
  walletsTable,
  walletTransactionsTable,
  profilesTable,
} from "@db/schema";
import { eq, and, ne, sql } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth";
import { z } from "zod";
import Stripe from "stripe";
import Razorpay from "razorpay";
import { createHmac } from "crypto";

const router = Router();

// ── Deposit rate limiter ───────────────────────────────────────────────────────
// 10 deposit attempts per 15 minutes per user — prevents abuse of payment APIs
interface DepositBucket { count: number; resetAt: number }
const _depositRateStore = new Map<string, DepositBucket>();

function checkDepositRateLimit(userId: string): { allowed: boolean } {
  const now = Date.now();
  const existing = _depositRateStore.get(userId);
  const bucket: DepositBucket = existing && now < existing.resetAt
    ? existing
    : { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (bucket.count >= 10) return { allowed: false };
  bucket.count++;
  _depositRateStore.set(userId, bucket);
  return { allowed: true };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _depositRateStore) {
    if (now >= v.resetAt) _depositRateStore.delete(k);
  }
}, 60 * 60 * 1000);

// ── Config ────────────────────────────────────────────────────────────────────
const MIN_STRIPE_CENTS = 100;
const MAX_STRIPE_CENTS = 50000;
const MIN_RAZORPAY_PAISE = 1000;
const MAX_RAZORPAY_PAISE = 5000000;

function getBaseUrl(): string {
  const appBase = process.env.APP_BASE_URL?.replace(/\/$/, "");
  if (appBase) return appBase;
  return "http://localhost:8080";
}

/**
 * Returns an HTTPS URL for the in-browser "done" page.
 * Using HTTPS instead of the globalwalkerleague:// scheme prevents Android from
 * firing a system intent that opens Expo Go and causes a "screen not found" error.
 * The app's background poll detects the terminal status and dismisses the browser.
 */
function appDoneUrl(status: "success" | "failed" | "cancelled", transactionId: string): string {
  return `${getBaseUrl()}/api/wallet/deposit/done?status=${status}&transaction_id=${encodeURIComponent(transactionId)}`;
}

// ── Stripe client ─────────────────────────────────────────────────────────────
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured.");
  _stripe = new Stripe(key, { apiVersion: "2026-05-27.dahlia" });
  return _stripe;
}

// ── Razorpay client ───────────────────────────────────────────────────────────
let _razorpay: InstanceType<typeof Razorpay> | null = null;
function getRazorpay(): InstanceType<typeof Razorpay> {
  if (_razorpay) return _razorpay;
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error("RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is not configured.");
  _razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
  return _razorpay;
}

// ── Wallet helpers ────────────────────────────────────────────────────────────
async function getOrCreateWallet(userId: string) {
  const [existing] = await db
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.userId, userId))
    .limit(1);
  if (existing) return existing;
  const [created] = await db.insert(walletsTable).values({ userId }).returning();
  return created;
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

async function creditWalletForDeposit(
  userId: string,
  walletId: string,
  amountMinorUnits: number,
  description: string,
  currency: "USD" | "INR" = "USD",
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(walletsTable)
      .set({
        availableBalanceCents: sql`${walletsTable.availableBalanceCents} + ${amountMinorUnits}`,
        totalEarnedCents: sql`${walletsTable.totalEarnedCents} + ${amountMinorUnits}`,
        currency,
        updatedAt: new Date(),
      })
      .where(eq(walletsTable.id, walletId));

    await tx.insert(walletTransactionsTable).values({
      walletId,
      userId,
      transactionType: "manual_adjustment",
      amountCents: amountMinorUnits,
      currency: currency.toLowerCase(),
      status: "completed",
      description,
    });
  });
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

  const { allowed } = checkDepositRateLimit(userId);
  if (!allowed) {
    return res.status(429).json({ error: "Too many deposit attempts. Please wait a few minutes before trying again." });
  }

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

  let stripe: Stripe;
  try {
    stripe = getStripe();
  } catch {
    return res.status(503).json({ error: "Payment provider not configured." });
  }

  const { amountCents } = parsed.data;
  const baseUrl = getBaseUrl();

  let depositTx: typeof depositTransactionsTable.$inferSelect;
  try {
    const [row] = await db
      .insert(depositTransactionsTable)
      .values({
        userId,
        provider: "stripe",
        status: "pending",
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

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create({
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
    });
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

  if (cancelStatus === "cancelled" || !session_id) {
    if (transaction_id) {
      await db
        .update(depositTransactionsTable)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(
          and(
            eq(depositTransactionsTable.id, transaction_id),
            ne(depositTransactionsTable.status, "succeeded"),
          ),
        )
        .catch(() => {});
    }
    return res.redirect(appDoneUrl("cancelled", transaction_id ?? ""));
  }

  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status !== "paid") {
      await db
        .update(depositTransactionsTable)
        .set({
          status: "failed",
          failureReason: `payment_status=${session.payment_status}`,
          updatedAt: new Date(),
        })
        .where(eq(depositTransactionsTable.id, transaction_id))
        .catch(() => {});
      return res.redirect(appDoneUrl("failed", transaction_id));
    }

    const [depositTx] = await db
      .select()
      .from(depositTransactionsTable)
      .where(eq(depositTransactionsTable.id, transaction_id))
      .limit(1);

    if (!depositTx) return res.redirect(appDoneUrl("failed", transaction_id));

    if (depositTx.status === "succeeded") {
      req.log.info({ transaction_id }, "[PaymentBackend] stripe: already credited (idempotent)");
      return res.redirect(appDoneUrl("success", transaction_id));
    }

    const wallet = await getOrCreateWallet(depositTx.userId);
    const creditCents = depositTx.walletCreditCents ?? depositTx.amountMinorUnits;

    const updated = await db
      .update(depositTransactionsTable)
      .set({
        status: "succeeded",
        providerPaymentId: String(session.payment_intent ?? ""),
        creditedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(depositTransactionsTable.id, transaction_id),
          ne(depositTransactionsTable.status, "succeeded"),
        ),
      )
      .returning();

    if (updated.length > 0) {
      await creditWalletForDeposit(
        depositTx.userId,
        wallet.id,
        creditCents,
        `Deposit via Stripe — $${(creditCents / 100).toFixed(2)}`,
        "USD",
      );
      req.log.info({ txId: transaction_id, creditCents }, "[PaymentBackend] wallet credited: USD");
    }

    return res.redirect(appDoneUrl("success", transaction_id));
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
});

/**
 * POST /api/wallet/deposit/razorpay/create-order
 *
 * Creates a Razorpay Order (INR) and returns a URL to the backend-hosted
 * checkout page for expo-web-browser to open.
 */
router.post("/wallet/deposit/razorpay/create-order", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const { allowed } = checkDepositRateLimit(userId);
  if (!allowed) {
    return res.status(429).json({ error: "Too many deposit attempts. Please wait a few minutes before trying again." });
  }

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

  let razorpay: InstanceType<typeof Razorpay>;
  try {
    razorpay = getRazorpay();
  } catch {
    return res.status(503).json({ error: "Payment provider not configured." });
  }

  const { amountPaise } = parsed.data;
  const baseUrl = getBaseUrl();
  const walletCreditCents = amountPaise;

  let depositTx: typeof depositTransactionsTable.$inferSelect;
  try {
    const [row] = await db
      .insert(depositTransactionsTable)
      .values({
        userId,
        provider: "razorpay",
        status: "pending",
        amountMinorUnits: amountPaise,
        currency: "INR",
        walletCreditCents,
      })
      .returning();
    depositTx = row;
  } catch (err) {
    req.log.error({ err, userId, amountPaise }, "[PaymentBackend] razorpay: DB insert failed");
    return res.status(500).json({ error: "Failed to create payment record." });
  }

  let order: { id: string; amount: number; currency: string };
  try {
    order = await (razorpay.orders as unknown as { create: (opts: unknown) => Promise<typeof order> }).create({
      amount: amountPaise,
      currency: "INR",
      receipt: `wc_dep_${depositTx.id.replace(/-/g, "").slice(0, 20)}`,
      notes: { depositTransactionId: depositTx.id, userId },
    });
  } catch (err) {
    req.log.error({ err, depositTxId: depositTx.id }, "[PaymentBackend] razorpay: create-order API failed");
    await db.update(depositTransactionsTable)
      .set({ status: "failed", failureReason: "razorpay_api_error", updatedAt: new Date() })
      .where(eq(depositTransactionsTable.id, depositTx.id))
      .catch(() => {});
    return res.status(502).json({ error: "Failed to create Razorpay order. Please try again." });
  }

  await db
    .update(depositTransactionsTable)
    .set({ providerOrderId: order.id, status: "processing", updatedAt: new Date() })
    .where(eq(depositTransactionsTable.id, depositTx.id));

  req.log.info({ orderId: order.id, txId: depositTx.id, amountPaise }, "[PaymentBackend] razorpay: order created");

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
          // then redirects here to the HTTPS done page.
          var url = verifyUrl
            + '?razorpay_payment_id=' + encodeURIComponent(response.razorpay_payment_id)
            + '&razorpay_order_id='   + encodeURIComponent(response.razorpay_order_id)
            + '&razorpay_signature='  + encodeURIComponent(response.razorpay_signature)
            + '&transaction_id='      + encodeURIComponent(tid);
          window.location.href = url;
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

/**
 * GET /api/wallet/deposit/razorpay/verify
 *
 * Called by the checkout page via window.location.href after Razorpay payment.
 * Verifies HMAC-SHA256 signature, credits wallet idempotently, then redirects
 * to the app deep link (success or failed).
 * WebBrowser.openAuthSessionAsync() intercepts the deep link — no "screen does not exist".
 */
router.get("/wallet/deposit/razorpay/verify", async (req, res) => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature, transaction_id } =
    req.query as Record<string, string>;

  const missing = ["razorpay_payment_id", "razorpay_order_id", "razorpay_signature", "transaction_id"]
    .filter((k) => !(req.query as Record<string, string>)[k]);

  if (missing.length > 0) {
    req.log.warn({ missing }, "[PaymentBackend] razorpay verify: missing params");
    return res.redirect(appDoneUrl("failed", transaction_id ?? ""));
  }

  try {
    const keySecret = process.env.RAZORPAY_KEY_SECRET ?? "";
    const expectedSignature = createHmac("sha256", keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (razorpay_signature !== expectedSignature) {
      req.log.warn({ transaction_id, razorpay_payment_id }, "[PaymentBackend] razorpay verify: signature mismatch");
      await db
        .update(depositTransactionsTable)
        .set({ status: "failed", failureReason: "signature_mismatch", updatedAt: new Date() })
        .where(eq(depositTransactionsTable.id, transaction_id))
        .catch(() => {});
      return res.redirect(appDoneUrl("failed", transaction_id));
    }

    const [depositTx] = await db
      .select()
      .from(depositTransactionsTable)
      .where(eq(depositTransactionsTable.id, transaction_id))
      .limit(1);

    if (!depositTx) {
      req.log.warn({ transaction_id }, "[PaymentBackend] razorpay verify: transaction not found");
      return res.redirect(appDoneUrl("failed", transaction_id));
    }

    if (depositTx.status === "succeeded") {
      req.log.info({ transaction_id }, "[PaymentBackend] razorpay verify: already credited (idempotent)");
      return res.redirect(appDoneUrl("success", transaction_id));
    }

    if (depositTx.providerOrderId !== razorpay_order_id) {
      req.log.warn({ transaction_id, razorpay_order_id }, "[PaymentBackend] razorpay verify: order_id mismatch");
      return res.redirect(appDoneUrl("failed", transaction_id));
    }

    const wallet = await getOrCreateWallet(depositTx.userId);
    const creditCents = depositTx.walletCreditCents ?? 1;
    const amountINR = (depositTx.amountMinorUnits / 100).toFixed(2);

    const updated = await db
      .update(depositTransactionsTable)
      .set({
        status: "succeeded",
        providerPaymentId: razorpay_payment_id,
        providerSignature: razorpay_signature,
        creditedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(depositTransactionsTable.id, transaction_id),
          ne(depositTransactionsTable.status, "succeeded"),
        ),
      )
      .returning();

    if (updated.length > 0) {
      await creditWalletForDeposit(
        depositTx.userId,
        wallet.id,
        creditCents,
        `Deposit via Razorpay — ₹${amountINR}`,
        "INR",
      );
      req.log.info({ txId: transaction_id, creditCents }, "[PaymentBackend] wallet credited: INR");
    }

    return res.redirect(appDoneUrl("success", transaction_id));
  } catch (err) {
    req.log.error({ err }, "[PaymentBackend] razorpay verify: exception");
    return res.redirect(appDoneUrl("failed", transaction_id ?? ""));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// DONE PAGE  (no auth — served to the browser after any payment outcome)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/wallet/deposit/done
 *
 * In-browser landing page shown after every payment outcome (success / failed / cancelled).
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
    var icons = { success:'✅', failed:'❌', cancelled:'↩️' };
    var titles = { success:'Payment Complete', failed:'Payment Failed', cancelled:'Payment Cancelled' };
    var bodies = {
      success:   'Your wallet has been updated.',
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
  reason: z.string().optional(),
});

/**
 * POST /api/wallet/deposit/razorpay/browser-cancel
 *
 * Called from the Razorpay checkout HTML (ondismiss) to mark the transaction
 * cancelled before the browser navigates to the /done page.
 * No auth required — transaction_id is a UUID secret; can only downgrade to
 * "cancelled", never upgrade to "succeeded".
 */
router.post("/wallet/deposit/razorpay/browser-cancel", async (req, res) => {
  const parsed = browserUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false });

  await db
    .update(depositTransactionsTable)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(depositTransactionsTable.id, parsed.data.transaction_id),
        ne(depositTransactionsTable.status, "succeeded"),
      ),
    )
    .catch(() => {});

  return res.json({ ok: true });
});

/**
 * POST /api/wallet/deposit/razorpay/browser-fail
 *
 * Called from the Razorpay checkout HTML (payment.failed event) to mark the
 * transaction failed before the browser navigates to the /done page.
 * No auth required — same rationale as browser-cancel.
 */
router.post("/wallet/deposit/razorpay/browser-fail", async (req, res) => {
  const parsed = browserUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false });

  const reason = parsed.data.reason ?? "razorpay_payment_failed";

  await db
    .update(depositTransactionsTable)
    .set({ status: "failed", failureReason: reason, updatedAt: new Date() })
    .where(
      and(
        eq(depositTransactionsTable.id, parsed.data.transaction_id),
        ne(depositTransactionsTable.status, "succeeded"),
      ),
    )
    .catch(() => {});

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
 * Marks a pending/processing transaction as cancelled.
 * Never downgrades a succeeded transaction.
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

  if (depositTx.status === "succeeded") {
    return res.json({ success: true, status: "succeeded" });
  }

  await db
    .update(depositTransactionsTable)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(depositTransactionsTable.id, transaction_id),
        ne(depositTransactionsTable.status, "succeeded"),
      ),
    );

  req.log.info({ transaction_id, provider }, "[PaymentBackend] transaction cancelled");
  return res.json({ success: true, status: "cancelled" });
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
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    if (process.env.NODE_ENV === "production") {
      req.log.error("[PaymentBackend] STRIPE_WEBHOOK_SECRET missing in production — rejecting webhook to prevent unsigned event injection.");
      return res.status(503).json({ error: "Webhook verification not configured." });
    }
    req.log.warn("[PaymentBackend] Stripe webhook secret not configured — disabled for dev.");
    return res.json({ received: true, warning: "webhook_disabled_no_secret" });
  }

  if (!sig) return res.status(400).json({ error: "Missing stripe-signature header" });

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(req.body as Buffer, sig, webhookSecret);
  } catch {
    return res.status(400).json({ error: "Invalid webhook signature" });
  }

  req.log.info({ type: event.type, id: event.id }, "[PaymentBackend] stripe webhook received");

  const [existing] = await db
    .select()
    .from(depositWebhookEventsTable)
    .where(eq(depositWebhookEventsTable.providerEventId, event.id))
    .limit(1);

  if (existing?.processed) {
    return res.json({ received: true });
  }

  await db
    .insert(depositWebhookEventsTable)
    .values({
      provider: "stripe",
      providerEventId: event.id,
      eventType: event.type,
      payload: event as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing();

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const depositTxId = session.metadata?.depositTransactionId;

    if (depositTxId && session.payment_status === "paid") {
      const [depositTx] = await db
        .select()
        .from(depositTransactionsTable)
        .where(eq(depositTransactionsTable.id, depositTxId))
        .limit(1);

      if (depositTx && depositTx.status !== "succeeded") {
        const wallet = await getOrCreateWallet(depositTx.userId);
        const creditCents = depositTx.walletCreditCents ?? depositTx.amountMinorUnits;

        const updated = await db
          .update(depositTransactionsTable)
          .set({
            status: "succeeded",
            providerPaymentId: String(session.payment_intent ?? ""),
            creditedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(depositTransactionsTable.id, depositTxId),
              ne(depositTransactionsTable.status, "succeeded"),
            ),
          )
          .returning();

        if (updated.length > 0) {
          await creditWalletForDeposit(
            depositTx.userId,
            wallet.id,
            creditCents,
            `Deposit via Stripe — $${(creditCents / 100).toFixed(2)}`,
            "USD",
          );
          req.log.info({ depositTxId }, "[PaymentBackend] wallet credited via webhook: USD");
        }
      }
    }
  }

  await db
    .update(depositWebhookEventsTable)
    .set({ processed: true, processedAt: new Date() })
    .where(eq(depositWebhookEventsTable.providerEventId, event.id));

  return res.json({ received: true });
});

router.post("/webhooks/razorpay", async (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!webhookSecret) {
    if (process.env.NODE_ENV === "production") {
      req.log.error("[PaymentBackend] RAZORPAY_WEBHOOK_SECRET missing in production — rejecting webhook to prevent unsigned event injection.");
      return res.status(503).json({ error: "Webhook verification not configured." });
    }
    req.log.warn("[PaymentBackend] Razorpay webhook secret not configured — disabled for dev.");
    return res.json({ received: true, warning: "webhook_disabled_no_secret" });
  }

  const signature = req.headers["x-razorpay-signature"] as string;
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
  const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");

  if (!signature || signature !== expected) {
    return res.status(400).json({ error: "Invalid webhook signature" });
  }

  const body = (Buffer.isBuffer(req.body)
    ? JSON.parse(req.body.toString())
    : req.body) as Record<string, unknown>;
  const eventType = String(body.event ?? "");
  const eventId = String((body as { id?: string }).id ?? `rzp-${Date.now()}`);

  req.log.info({ eventType, eventId }, "[PaymentBackend] razorpay webhook received");

  const [existing] = await db
    .select()
    .from(depositWebhookEventsTable)
    .where(eq(depositWebhookEventsTable.providerEventId, eventId))
    .limit(1);

  if (existing?.processed) return res.json({ received: true });

  await db
    .insert(depositWebhookEventsTable)
    .values({ provider: "razorpay", providerEventId: eventId, eventType, payload: body })
    .onConflictDoNothing();

  if (eventType === "payment.captured" || eventType === "order.paid") {
    const payload = body.payload as {
      order?: { entity?: { id?: string } };
      payment?: { entity?: { id?: string } };
    } | undefined;
    const orderId = payload?.order?.entity?.id;
    const razorpayPaymentId = payload?.payment?.entity?.id;

    if (orderId) {
      const [depositTx] = await db
        .select()
        .from(depositTransactionsTable)
        .where(
          and(
            eq(depositTransactionsTable.providerOrderId, orderId),
            eq(depositTransactionsTable.provider, "razorpay"),
          ),
        )
        .limit(1);

      if (depositTx && depositTx.status !== "succeeded") {
        const wallet = await getOrCreateWallet(depositTx.userId);
        const creditCents = depositTx.walletCreditCents ?? 1;
        const amountINR = (depositTx.amountMinorUnits / 100).toFixed(2);

        const updated = await db
          .update(depositTransactionsTable)
          .set({
            status: "succeeded",
            providerPaymentId: razorpayPaymentId ?? null,
            creditedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(depositTransactionsTable.id, depositTx.id),
              ne(depositTransactionsTable.status, "succeeded"),
            ),
          )
          .returning();

        if (updated.length > 0) {
          await creditWalletForDeposit(
            depositTx.userId,
            wallet.id,
            creditCents,
            `Deposit via Razorpay — ₹${amountINR}`,
            "INR",
          );
          req.log.info({ txId: depositTx.id }, "[PaymentBackend] wallet credited via webhook: INR");
        }
      }
    }
  }

  await db
    .update(depositWebhookEventsTable)
    .set({ processed: true, processedAt: new Date() })
    .where(eq(depositWebhookEventsTable.providerEventId, eventId));

  return res.json({ received: true });
});

export default router;
