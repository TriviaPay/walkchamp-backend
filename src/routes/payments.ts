import { Router } from "express";
import { db } from "@db";
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
} from "@db/schema";
import { eq, and, ne, sql } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth";
import { z } from "zod";
import Stripe from "stripe";
import { randomUUID } from "crypto";

const router = Router();

// ── Stripe client (lazy init so missing key just disables payments) ───────────
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured.");
  _stripe = new Stripe(key, { apiVersion: "2026-05-27.dahlia" });
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
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      return res.status(500).json({ error: "Webhook secret not configured" });
    }

    let event: Stripe.Event;
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
      .where(eq(paymentEventsTable.stripeEventId, event.id))
      .limit(1);

    if (existingEvent?.processed) {
      return res.json({ received: true, skipped: true });
    }

    // Store event
    await db
      .insert(paymentEventsTable)
      .values({
        stripeEventId: event.id,
        eventType: event.type,
        rawPayload: event as unknown as Record<string, unknown>,
        processed: false,
      })
      .onConflictDoNothing();

    // Handle payment_intent.succeeded
    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object as Stripe.PaymentIntent;
      const meta = pi.metadata;

      const [payment] = await db
        .select()
        .from(paymentsTable)
        .where(eq(paymentsTable.stripePaymentIntentId, pi.id))
        .limit(1);

      if (payment && payment.status !== "succeeded") {
        const raceId = meta.raceRoomId;
        const payUserId = meta.descopeUserId;

        await db.transaction(async (tx) => {
          // Mark payment succeeded
          await tx
            .update(paymentsTable)
            .set({ status: "succeeded", updatedAt: new Date() })
            .where(eq(paymentsTable.id, payment.id));

          // Check race still valid (not full, still open)
          const [room] = await tx
            .select()
            .from(raceRoomsTable)
            .where(eq(raceRoomsTable.id, raceId))
            .limit(1);

          if (!room || room.status !== "open" || room.currentPlayers >= room.maxPlayers) {
            // Race is no longer joinable — credit wallet for refund
            const wallet = await (async () => {
              const [w] = await tx
                .select()
                .from(walletsTable)
                .where(eq(walletsTable.userId, payUserId))
                .limit(1);
              if (w) return w;
              const [created] = await tx
                .insert(walletsTable)
                .values({ userId: payUserId })
                .returning();
              return created;
            })();

            await tx
              .update(walletsTable)
              .set({
                availableBalanceCents: sql`${walletsTable.availableBalanceCents} + ${payment.amountCents}`,
                updatedAt: new Date(),
              })
              .where(eq(walletsTable.id, wallet.id));

            await tx.insert(walletTransactionsTable).values({
              walletId: wallet.id,
              userId: payUserId,
              transactionType: "race_entry_refund",
              amountCents: payment.amountCents,
              currency: payment.currency,
              status: "completed",
              description: "Race entry refunded — race full or cancelled",
              paymentId: payment.id,
            });
            return;
          }

          // Join user to race
          await tx.insert(raceParticipantsTable).values({
            raceRoomId: raceId,
            userId: payUserId,
            status: "joined",
            paymentId: payment.id,
          });

          await tx
            .update(raceRoomsTable)
            .set({
              currentPlayers: sql`${raceRoomsTable.currentPlayers} + 1`,
              prizePoolCents: sql`${raceRoomsTable.prizePoolCents} + ${payment.amountCents}`,
              updatedAt: new Date(),
            })
            .where(eq(raceRoomsTable.id, raceId));
        });
      }

      // Mark event processed
      await db
        .update(paymentEventsTable)
        .set({ processed: true })
        .where(eq(paymentEventsTable.stripeEventId, event.id));
    }

    if (event.type === "payment_intent.payment_failed") {
      const pi = event.data.object as Stripe.PaymentIntent;
      await db
        .update(paymentsTable)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(paymentsTable.stripePaymentIntentId, pi.id));

      await db
        .update(paymentEventsTable)
        .set({ processed: true })
        .where(eq(paymentEventsTable.stripeEventId, event.id));
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

  // Store refund request in metadata for admin review
  await db
    .update(paymentsTable)
    .set({
      status: "refunded",
      metadata: {
        ...(payment.metadata as Record<string, unknown> ?? {}),
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
