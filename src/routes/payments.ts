import { Router } from "express";
import { db } from "../../db/src/index.js";
import {
  paymentsTable,
  paymentEventsTable,
  raceRoomsTable,
  raceParticipantsTable,
  profilesTable,
  walletsTable,
  walletTransactionsTable,
  promoCodesTable,
  promoRedemptionsTable,
} from "../../db/src/schema/index.js";
import { eq, and, ne, sql } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import { z } from "zod";
import StripeConstructor from "stripe";
import { requireCashFeaturesEnabled } from "../middleware/requireCashFeaturesEnabled.js";
import {
  deriveOpenRoomStatus,
  joinOrReviveParticipant,
  lockPaymentById,
  lockPromoCodeByCode,
  lockRaceRoom,
  lockWalletByUserId,
  type DbTx,
} from "../lib/raceIntegrity.js";
import { config } from "../lib/config.js";

const router = Router();

router.use("/payments", requireCashFeaturesEnabled);

// ── Stripe client (lazy init so missing key just disables payments) ───────────
type StripeClient = InstanceType<typeof StripeConstructor>;
type StripeEvent = ReturnType<StripeClient["webhooks"]["constructEvent"]>;
type StripePaymentIntent = Awaited<ReturnType<StripeClient["paymentIntents"]["retrieve"]>>;

let _stripe: StripeClient | null = null;
function getStripe(): StripeClient {
  if (_stripe) return _stripe;
  const key = config.payments.stripeSecretKey;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured.");
  _stripe = new StripeConstructor(key, { apiVersion: "2026-05-27.dahlia" });
  return _stripe;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getOrCreateStripeCustomer(userId: string, email: string): Promise<string> {
  const stripe = getStripe();
  const [profile] = await db
    .select({ stripeCustomerId: profilesTable.stripeCustomerId })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);

  if (profile?.stripeCustomerId) return profile.stripeCustomerId;

  const customer = await stripe.customers.create({
    email,
    metadata: { descopeUserId: userId },
  });

  await db
    .update(profilesTable)
    .set({ stripeCustomerId: customer.id })
    .where(eq(profilesTable.id, userId));

  return customer.id;
}

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

function getPaymentMetadata(payment: typeof paymentsTable.$inferSelect): Record<string, unknown> {
  return ((payment.metadata as Record<string, unknown> | null) ?? {});
}

function hasRefundRequested(payment: typeof paymentsTable.$inferSelect): boolean {
  return getPaymentMetadata(payment).refundRequested === true;
}

async function ensureLockedWallet(tx: DbTx, userId: string, currency: string) {
  let wallet = await lockWalletByUserId(tx, userId);
  if (!wallet) {
    const [created] = await tx.insert(walletsTable).values({ userId, currency }).returning();
    wallet = created;
  }
  return wallet;
}

async function creditWalletRefund(tx: DbTx, payment: typeof paymentsTable.$inferSelect, reason: string) {
  const wallet = await ensureLockedWallet(tx, payment.userId, payment.currency);
  await tx
    .update(walletsTable)
    .set({
      availableBalanceCents: sql`${walletsTable.availableBalanceCents} + ${payment.amountCents}`,
      updatedAt: new Date(),
    })
    .where(eq(walletsTable.id, wallet.id));

  await tx.insert(walletTransactionsTable).values({
    walletId: wallet.id,
    userId: payment.userId,
    transactionType: "race_entry_refund",
    amountCents: payment.amountCents,
    currency: payment.currency,
    status: "completed",
    description: reason,
    paymentId: payment.id,
  });
}

async function settlePromoRedemption(tx: DbTx, payment: typeof paymentsTable.$inferSelect) {
  const metadata = getPaymentMetadata(payment);
  const promoCode = typeof metadata.promoCode === "string" && metadata.promoCode.trim()
    ? metadata.promoCode.trim().toUpperCase()
    : null;

  if (!promoCode) {
    return { ok: true as const };
  }

  const promo = await lockPromoCodeByCode(tx, promoCode);
  if (!promo || !promo.active) {
    return { ok: false as const, reason: "Promo code is invalid or inactive." };
  }
  if (promo.endsAt && promo.endsAt < new Date()) {
    return { ok: false as const, reason: "Promo code has expired." };
  }
  if (promo.maxUses !== null && promo.usedCount >= promo.maxUses) {
    return { ok: false as const, reason: "Promo code has reached its usage limit." };
  }

  const inserted = await tx
    .insert(promoRedemptionsTable)
    .values({
      promoCodeId: promo.id,
      userId: payment.userId,
      paymentId: payment.id,
      discountAmountCents: Number(metadata.discountCents ?? 0),
    })
    .onConflictDoNothing()
    .returning({ id: promoRedemptionsTable.id });

  if (inserted.length === 0) {
    return { ok: true as const };
  }

  await tx
    .update(promoCodesTable)
    .set({ usedCount: sql`${promoCodesTable.usedCount} + 1` })
    .where(eq(promoCodesTable.id, promo.id));

  return { ok: true as const };
}

// ── POST /api/payments/create-race-entry-intent ───────────────────────────────
// Creates a Stripe PaymentIntent for joining a paid race.
// Returns clientSecret + ephemeralKey for use with Stripe Payment Sheet.
const createIntentSchema = z.object({
  raceId: z.string().uuid(),
  promoCode: z.string().optional(),
});

router.post("/payments/create-race-entry-intent", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = createIntentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }

  const { raceId, promoCode } = parsed.data;

  // --- Validate user eligibility ---
  const [profile] = await db
    .select()
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);

  if (!profile) return res.status(404).json({ error: "Profile not found" });
  if (profile.accountStatus === "suspended" || profile.accountStatus === "banned") {
    return res.status(403).json({ error: "Your account is not eligible for paid races." });
  }
  if (!profile.isAdult) {
    return res.status(403).json({ error: "You must be 18+ to join paid races." });
  }
  if (!profile.paidRaceEnabled) {
    return res.status(403).json({ error: "Paid races are not enabled for your account." });
  }

  // --- Validate race ---
  const [room] = await db
    .select()
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.id, raceId))
    .limit(1);

  if (!room) return res.status(404).json({ error: "Race not found" });
  if (room.status !== "open") return res.status(409).json({ error: "Race is no longer accepting entries." });
  if (room.currentPlayers >= room.maxPlayers) return res.status(409).json({ error: "Race is full." });
  if (room.entryAmountCents === 0) return res.status(400).json({ error: "This is a free race. Use the join endpoint." });

  // Check not already joined
  const [existing] = await db
    .select()
    .from(raceParticipantsTable)
    .where(
      and(
        eq(raceParticipantsTable.raceRoomId, raceId),
        eq(raceParticipantsTable.userId, userId),
        ne(raceParticipantsTable.status, "left"),
      ),
    )
    .limit(1);
  if (existing) return res.status(409).json({ error: "You are already in this race." });

  // --- Promo code validation ---
  let discountCents = 0;
  let promoCodeRow: typeof promoCodesTable.$inferSelect | null = null;

  if (promoCode) {
    const [promo] = await db
      .select()
      .from(promoCodesTable)
      .where(eq(promoCodesTable.code, promoCode.toUpperCase()))
      .limit(1);

    if (!promo || !promo.active) {
      return res.status(400).json({ error: "Promo code is invalid or expired." });
    }
    if (promo.endsAt && promo.endsAt < new Date()) {
      return res.status(400).json({ error: "Promo code has expired." });
    }
    if (promo.maxUses !== null && promo.usedCount >= promo.maxUses) {
      return res.status(400).json({ error: "Promo code has reached its usage limit." });
    }

    if (promo.discountType === "percent") {
      discountCents = Math.round((room.entryAmountCents * promo.discountValue) / 100);
    } else {
      discountCents = Math.min(promo.discountValue, room.entryAmountCents);
    }
    promoCodeRow = promo;
  }

  const finalAmountCents = Math.max(0, room.entryAmountCents - discountCents);

  // --- Create Stripe PaymentIntent ---
  const stripe = getStripe();
  const idempotencyKey = `race-entry-${userId}-${raceId}-${Date.now()}`;

  const customerId = await getOrCreateStripeCustomer(userId, profile.email);
  const ephemeralKey = await stripe.ephemeralKeys.create(
    { customer: customerId },
    { apiVersion: "2026-05-27.dahlia" },
  );

  const paymentIntent = await stripe.paymentIntents.create(
    {
      amount: finalAmountCents,
      currency: "usd",
      customer: customerId,
      automatic_payment_methods: { enabled: true },
      metadata: {
        descopeUserId: userId,
        userProfileId: userId,
        raceRoomId: raceId,
        entryAmountCents: room.entryAmountCents.toString(),
        discountCents: discountCents.toString(),
        paymentType: "race_entry",
        idempotencyKey,
      },
    },
    { idempotencyKey: `pi-${idempotencyKey}` },
  );

  // Store pending payment record
  const [payment] = await db
    .insert(paymentsTable)
    .values({
      userId,
      stripePaymentIntentId: paymentIntent.id,
      stripeCustomerId: customerId,
      raceRoomId: raceId,
      amountCents: finalAmountCents,
      currency: "usd",
      status: "pending",
      paymentType: "race_entry",
      idempotencyKey,
      metadata: {
        entryAmountCents: room.entryAmountCents,
        discountCents,
        promoCode: promoCode ?? null,
      },
    })
    .returning();

  req.log.info(
    { paymentId: payment.id, raceId, amountCents: finalAmountCents },
    "payment intent created",
  );

  return res.json({
    paymentIntentClientSecret: paymentIntent.client_secret,
    ephemeralKey: ephemeralKey.secret,
    customerId,
    paymentId: payment.id,
    amountCents: finalAmountCents,
    originalAmountCents: room.entryAmountCents,
    discountCents,
    race: {
      id: room.id,
      title: room.title,
      entryType: room.entryType,
      targetSteps: room.targetSteps,
      maxPlayers: room.maxPlayers,
      currentPlayers: room.currentPlayers,
    },
  });
});

// ── POST /api/payments/webhook ────────────────────────────────────────────────
// Stripe sends events here. Must be raw body (not parsed by Express JSON).
// Registered as raw before the JSON middleware in app setup.
router.post(
  "/payments/webhook",
  async (req, res) => {
    const sig = req.headers["stripe-signature"] as string;
    const webhookSecret = config.payments.stripeWebhookSecret;

    if (!webhookSecret) {
      return res.status(500).json({ error: "Webhook secret not configured" });
    }

    let event: StripeEvent;
    try {
      const stripe = getStripe();
      event = stripe.webhooks.constructEvent(req.body as Buffer, sig, webhookSecret);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(400).json({ error: `Webhook signature verification failed: ${message}` });
    }

    // Idempotency: skip already-processed events
    const [existingEvent] = await db
      .select()
      .from(paymentEventsTable)
      .where(and(
        eq(paymentEventsTable.provider, "stripe"),
        eq(paymentEventsTable.providerEventId, event.id),
      ))
      .limit(1);

    if (existingEvent?.processed) {
      return res.json({ received: true, skipped: true });
    }

    // Store event
    await db
      .insert(paymentEventsTable)
      .values({
        provider: "stripe",
        providerEventId: event.id,
        stripeEventId: event.id,
        eventType: event.type,
        rawPayload: event as unknown as Record<string, unknown>,
        processed: false,
        processingStatus: "pending",
      })
      .onConflictDoNothing();

    await db
      .update(paymentEventsTable)
      .set({
        processingStatus: "processing",
        processingAttemptCount: sql`${paymentEventsTable.processingAttemptCount} + 1`,
        failureReason: null,
      })
      .where(and(
        eq(paymentEventsTable.provider, "stripe"),
        eq(paymentEventsTable.providerEventId, event.id),
      ));

    try {
      if (event.type === "payment_intent.succeeded") {
        const pi = event.data.object as StripePaymentIntent;
        const meta = pi.metadata;

        const [payment] = await db
          .select()
          .from(paymentsTable)
          .where(eq(paymentsTable.stripePaymentIntentId, pi.id))
          .limit(1);

        if (payment && payment.status !== "succeeded") {
          const raceId = meta.raceRoomId;

          await db.transaction(async (tx) => {
            const lockedPayment = await lockPaymentById(tx, payment.id);
            if (!lockedPayment || lockedPayment.status === "succeeded") {
              return;
            }

            const room = await lockRaceRoom(tx, raceId);

            if (!room || (room.status !== "open" && room.status !== "full") || room.currentPlayers >= room.maxPlayers) {
              await creditWalletRefund(tx, lockedPayment, "Race entry refunded — race full or cancelled");
              await tx
                .update(paymentsTable)
                .set({
                  status: "succeeded",
                  metadata: {
                    ...getPaymentMetadata(lockedPayment),
                    autoRefundReason: "race_unavailable",
                    autoRefundedAt: new Date().toISOString(),
                  },
                  updatedAt: new Date(),
                })
                .where(eq(paymentsTable.id, lockedPayment.id));
              return;
            }

            const promoResult = await settlePromoRedemption(tx, lockedPayment);

            if (!promoResult.ok) {
              await creditWalletRefund(tx, lockedPayment, "Race entry refunded — promo code could not be fulfilled");
              await tx
                .update(paymentsTable)
                .set({
                  status: "succeeded",
                  metadata: {
                    ...getPaymentMetadata(lockedPayment),
                    autoRefundReason: "promo_unavailable",
                    autoRefundedAt: new Date().toISOString(),
                  },
                  updatedAt: new Date(),
                })
                .where(eq(paymentsTable.id, lockedPayment.id));
              return;
            }

            const participantResult = await joinOrReviveParticipant(tx, {
              raceRoomId: raceId,
              userId: lockedPayment.userId,
              paymentId: lockedPayment.id,
            });

            if (participantResult.reason === "blocked" || participantResult.reason === "already_joined") {
              await creditWalletRefund(tx, lockedPayment, "Race entry refunded — duplicate or blocked participation");
              await tx
                .update(paymentsTable)
                .set({
                  status: "succeeded",
                  metadata: {
                    ...getPaymentMetadata(lockedPayment),
                    autoRefundReason: participantResult.reason,
                    autoRefundedAt: new Date().toISOString(),
                  },
                  updatedAt: new Date(),
                })
                .where(eq(paymentsTable.id, lockedPayment.id));
              return;
            }

            const newPlayerCount = room.currentPlayers + 1;

            await tx
              .update(raceRoomsTable)
              .set({
                currentPlayers: newPlayerCount,
                status: deriveOpenRoomStatus(newPlayerCount, room.maxPlayers),
                prizePoolCents: sql`${raceRoomsTable.prizePoolCents} + ${lockedPayment.amountCents}`,
                updatedAt: new Date(),
              })
              .where(eq(raceRoomsTable.id, room.id));

            await tx
              .update(paymentsTable)
              .set({ status: "succeeded", updatedAt: new Date() })
              .where(eq(paymentsTable.id, lockedPayment.id));
          });
        }
      }

      if (event.type === "payment_intent.payment_failed") {
        const pi = event.data.object as StripePaymentIntent;
        await db
          .update(paymentsTable)
          .set({ status: "failed", updatedAt: new Date() })
          .where(eq(paymentsTable.stripePaymentIntentId, pi.id));
      }

      await db
        .update(paymentEventsTable)
        .set({
          processed: true,
          processedAt: new Date(),
          processingStatus: "processed",
          failureReason: null,
        })
        .where(and(
          eq(paymentEventsTable.provider, "stripe"),
          eq(paymentEventsTable.providerEventId, event.id),
        ));
    } catch (err) {
      const failureReason = err instanceof Error ? err.message : "Unknown webhook processing failure";
      await db
        .update(paymentEventsTable)
        .set({
          processed: false,
          processingStatus: "failed",
          failureReason,
        })
        .where(and(
          eq(paymentEventsTable.provider, "stripe"),
          eq(paymentEventsTable.providerEventId, event.id),
        ));
      req.log.error({ err, eventId: event.id, eventType: event.type }, "Stripe webhook processing failed");
      return res.status(500).json({ error: "Webhook processing failed" });
    }

    return res.json({ received: true });
  },
);

// ── GET /api/payments/:id ─────────────────────────────────────────────────────
router.get("/payments/:id", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const paymentId = String(req.params.id);

  const [payment] = await db
    .select()
    .from(paymentsTable)
    .where(and(eq(paymentsTable.id, paymentId), eq(paymentsTable.userId, userId)))
    .limit(1);

  if (!payment) return res.status(404).json({ error: "Payment not found" });

  return res.json({
    payment: {
      id: payment.id,
      amount: payment.amountCents / 100,
      currency: payment.currency,
      status: payment.status,
      refundRequested: hasRefundRequested(payment),
      paymentType: payment.paymentType,
      raceRoomId: payment.raceRoomId,
      createdAt: payment.createdAt,
    },
  });
});

// ── POST /api/payments/:id/refund-request ─────────────────────────────────────
router.post("/payments/:id/refund-request", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const paymentId = String(req.params.id);

  const [payment] = await db
    .select()
    .from(paymentsTable)
    .where(and(eq(paymentsTable.id, paymentId), eq(paymentsTable.userId, userId)))
    .limit(1);

  if (!payment) return res.status(404).json({ error: "Payment not found" });
  if (payment.status !== "succeeded") {
    return res.status(400).json({ error: "Only succeeded payments can be refunded." });
  }
  if (hasRefundRequested(payment)) {
    return res.json({ message: "Refund request already submitted for admin review." });
  }

  // Store refund request in metadata for admin review
  await db
    .update(paymentsTable)
    .set({
      metadata: {
        ...getPaymentMetadata(payment),
        refundRequested: true,
        refundRequestedAt: new Date().toISOString(),
        refundReason: req.body.reason ?? "user_request",
      },
      updatedAt: new Date(),
    })
    .where(eq(paymentsTable.id, payment.id));

  return res.json({ message: "Refund request submitted for admin review." });
});

export default router;
