import { Router } from "express";
import { AccessToken } from "livekit-server-sdk";
import { db } from "../../db/src/index.js";
import {
  userEntitlementsTable,
  userPurchasesTable,
  raceRoomsTable,
  raceParticipantsTable,
  voiceSessionsTable,
  coinBalancesTable,
  coinTransactionsTable,
} from "../../db/src/schema/index.js";
import { eq, and, inArray, desc, sql, gte, lte } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import { z } from "zod";
import { recordCoinLedgerEntry } from "../lib/coinsService.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { requireActiveAccount } from "../middleware/requireActiveAccount.js";

const router = Router();

// ── GET /api/users/me/entitlements ────────────────────────────────────────────
router.get("/users/me/entitlements", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const rows = await db
    .select()
    .from(userEntitlementsTable)
    .where(and(eq(userEntitlementsTable.userId, userId), eq(userEntitlementsTable.status, "active")));

  const entitlementMap: Record<string, boolean> = {};
  const productsMap: Record<string, { owned: boolean; purchased_at: string }> = {};

  for (const row of rows) {
    entitlementMap[row.entitlementKey] = true;
    if (row.productId) {
      productsMap[row.productId] = {
        owned: true,
        purchased_at: row.purchasedAt.toISOString(),
      };
    }
  }

  if (!("mic_pass" in entitlementMap)) entitlementMap["mic_pass"] = false;

  return res.json({ success: true, entitlements: entitlementMap, products: productsMap });
});

// ── GET /api/mic-pass/status ──────────────────────────────────────────────────
router.get("/mic-pass/status", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const [row] = await db
    .select({ entitlementKey: userEntitlementsTable.entitlementKey, purchasedAt: userEntitlementsTable.purchasedAt })
    .from(userEntitlementsTable)
    .where(
      and(
        eq(userEntitlementsTable.userId, userId),
        eq(userEntitlementsTable.entitlementKey, "mic_pass"),
        eq(userEntitlementsTable.status, "active"),
      ),
    )
    .limit(1);

  return res.json({
    success: true,
    has_mic_pass: !!row,
    feature_key: "mic_pass",
    purchase_type: "one_time",
    purchased_at: row?.purchasedAt?.toISOString() ?? null,
  });
});

// ── Product maps ──────────────────────────────────────────────────────────────

/** Non-consumable products → entitlement key */
const NON_CONSUMABLE_MAP: Record<string, string> = {
  mic_pass_lifetime: "mic_pass",
};

/** Consumable coin products → coin amount to credit */
const COIN_PRODUCT_MAP: Record<string, number> = {
  coins_100:  100,
  coins_500:  500,
  coins_1200: 1200,
  coins_2500: 2500,
  coins_5000: 5000,
};

const ALL_VALID_PRODUCT_IDS = new Set([
  ...Object.keys(NON_CONSUMABLE_MAP),
  ...Object.keys(COIN_PRODUCT_MAP),
]);

// ── POST /api/purchases/verify ────────────────────────────────────────────────
const verifySchema = z.object({
  product_id:     z.string(),
  platform:       z.enum(["ios", "android", "dev"]),
  transaction_id: z.string().min(1),
  purchase_token: z.string().optional(),
  receipt:        z.string().optional(),
  package_name:   z.string().optional(),
});

function providerNameForPlatform(platform: "ios" | "android" | "dev") {
  return platform === "ios" ? "apple" : platform === "android" ? "google" : "dev";
}

router.post("/purchases/verify", requireAuth, requireActiveAccount, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parse  = verifySchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({
      success: false,
      code: "INVALID_REQUEST",
      message: "Invalid request body.",
    });
  }

  const { product_id, platform, transaction_id, purchase_token, receipt, package_name } = parse.data;

  if (process.env.NODE_ENV === "production") {
    req.log.error({ userId, product_id, platform }, "[IAP] rejecting unverified client-side purchase in production");
    return res.status(503).json({
      success: false,
      code: "IAP_VERIFICATION_NOT_CONFIGURED",
      message: "Secure store receipt verification is not configured on this server.",
    });
  }

  if (platform === "dev") {
    req.log.warn({ userId, product_id, transaction_id }, "[IAP] allowing development-only purchase verification");
  } else if (!purchase_token && !receipt) {
    return res.status(400).json({
      success: false,
      code: "MISSING_PURCHASE_PROOF",
      message: "receipt or purchase_token is required.",
    });
  }

  // Validate product exists
  if (!ALL_VALID_PRODUCT_IDS.has(product_id)) {
    return res.status(400).json({
      success: false,
      code: "INVALID_PRODUCT_ID",
      message: `Unknown product: ${product_id}`,
    });
  }

  // Android: validate package name
  if (platform === "android" && package_name && package_name !== "com.globalwalkerleague.app") {
    return res.status(400).json({
      success: false,
      code: "INVALID_PLATFORM",
      message: "Package name does not match.",
    });
  }

  // Duplicate detection: reject replay across the entire system, not just per-user.
  const [existing] = await db
    .select({ id: userPurchasesTable.id, userId: userPurchasesTable.userId })
    .from(userPurchasesTable)
    .where(
      eq(userPurchasesTable.transactionId, transaction_id),
    )
    .limit(1);

  if (existing) {
    // Return success with current state — do not double-credit
    const [balRow] = await db
      .select({ currentBalance: coinBalancesTable.currentBalance })
      .from(coinBalancesTable)
      .where(eq(coinBalancesTable.userId, userId))
      .limit(1);

    const [micRow] = await db
      .select({ id: userEntitlementsTable.id })
      .from(userEntitlementsTable)
      .where(
        and(
          eq(userEntitlementsTable.userId, userId),
          eq(userEntitlementsTable.entitlementKey, "mic_pass"),
          eq(userEntitlementsTable.status, "active"),
        ),
      )
      .limit(1);

    req.log.info({ userId, product_id, transaction_id }, "[IAP] duplicate purchase detected");
    return res.json({
      success: true,
      duplicate: true,
      message: "Purchase already processed.",
      coin_balance: balRow?.currentBalance ?? 0,
      entitlements: { mic_pass: !!micRow },
      has_mic_pass: !!micRow,
      original_user_id: existing.userId,
    });
  }

  if (purchase_token) {
    const [existingToken] = await db
      .select({ id: userPurchasesTable.id })
      .from(userPurchasesTable)
      .where(eq(userPurchasesTable.purchaseToken, purchase_token))
      .limit(1);

    if (existingToken) {
      return res.status(409).json({
        success: false,
        code: "PURCHASE_TOKEN_REPLAYED",
        message: "Purchase token has already been processed.",
      });
    }
  }

  const coinAmount = COIN_PRODUCT_MAP[product_id];
  const entitlementKey = NON_CONSUMABLE_MAP[product_id];

  // ── Consumable coin purchase ──────────────────────────────────────────────
  if (coinAmount !== undefined) {
    try {
      const newBalance = await db.transaction(async (tx) => {
        // 1. Insert purchase record
        await tx.insert(userPurchasesTable).values({
          userId,
          productId:       product_id,
          productType:     "consumable",
          platform,
          paymentProvider: providerNameForPlatform(platform),
          transactionId:   transaction_id,
          purchaseToken:   purchase_token,
          status:          "verified",
          rawReceiptJson:  receipt ? { receipt } : null,
        });

        const ledger = await recordCoinLedgerEntry(tx, {
          userId,
          amount: coinAmount,
          transactionType: "earn",
          source: "iap_purchase",
          sourceId: transaction_id ?? product_id,
          rewardCode: null,
          reasonCode: "iap_purchase",
          idempotencyKey: `iap:${userId}:${transaction_id}`,
          description: `${coinAmount} coins from in-app purchase (${product_id})`,
          metadata: {
            productId: product_id,
            platform,
            provider: providerNameForPlatform(platform),
          },
        });

        return ledger.newBalance;
      });

      req.log.info({ userId, product_id, coinAmount, newBalance }, "[IAP] coins credited");
      await writeAuditLog({
        actorUserId: userId,
        actorType: "user",
        action: "coin.iap_credit",
        entityType: "purchase",
        entityId: transaction_id,
        reason: product_id,
        metadata: { productId: product_id, amount: coinAmount, platform },
      });

      return res.json({
        success:          true,
        product_type:     "consumable",
        coin_amount:      coinAmount,
        coin_balance:     newBalance,
        entitlements:     { mic_pass: false },
        has_mic_pass:     false,
      });
    } catch (err) {
      req.log.error({ err, userId, product_id }, "[IAP] coin transaction failed");
      return res.status(500).json({
        success: false,
        code:    "DATABASE_ERROR",
        message: "Could not credit coins. Please try again.",
      });
    }
  }

  // ── Non-consumable entitlement purchase (mic_pass_lifetime) ───────────────
  if (entitlementKey) {
    try {
      // Check if entitlement already active (idempotent)
      const [existingEnt] = await db
        .select({ id: userEntitlementsTable.id })
        .from(userEntitlementsTable)
        .where(
          and(
            eq(userEntitlementsTable.userId, userId),
            eq(userEntitlementsTable.entitlementKey, entitlementKey),
            eq(userEntitlementsTable.status, "active"),
          ),
        )
        .limit(1);

      // Insert purchase record
      await db.insert(userPurchasesTable).values({
        userId,
        productId:       product_id,
        productType:     "non_consumable",
        platform,
        paymentProvider: providerNameForPlatform(platform),
        transactionId:   transaction_id,
        purchaseToken:   purchase_token,
        status:          "verified",
        rawReceiptJson:  receipt ? { receipt } : null,
      });

      // Upsert entitlement
      await db
        .insert(userEntitlementsTable)
        .values({
          userId,
          entitlementKey,
          status:          "active",
          source:          platform === "dev" ? "dev" : "iap",
          platform,
          productId:       product_id,
          purchaseToken:   purchase_token,
          transactionId:   transaction_id,
          purchasedAt:     new Date(),
        })
        .onConflictDoUpdate({
          target: [userEntitlementsTable.userId, userEntitlementsTable.entitlementKey],
          set: {
            status:          "active",
            platform,
            productId:       product_id,
            purchaseToken:   purchase_token,
            transactionId:   transaction_id,
            purchasedAt:     new Date(),
            updatedAt:       new Date(),
          },
        });

      req.log.info({ userId, product_id, entitlementKey, alreadyOwned: !!existingEnt }, "[IAP] entitlement granted");
      await writeAuditLog({
        actorUserId: userId,
        actorType: "user",
        action: "entitlement.restore_or_grant",
        entityType: "entitlement",
        entityId: entitlementKey,
        reason: product_id,
        metadata: { platform, transactionId: transaction_id },
      });

      return res.json({
        success:         true,
        product_type:    "non_consumable",
        entitlement_key: entitlementKey,
        status:          "active",
        has_mic_pass:    entitlementKey === "mic_pass",
        entitlements:    { mic_pass: entitlementKey === "mic_pass" },
      });
    } catch (err) {
      req.log.error({ err, userId, product_id }, "[IAP] entitlement grant failed");
      return res.status(500).json({
        success: false,
        code:    "DATABASE_ERROR",
        message: "Could not activate entitlement. Please try again.",
      });
    }
  }

  // Should never reach here given the ALL_VALID_PRODUCT_IDS check above
  return res.status(400).json({ success: false, code: "INVALID_PRODUCT_ID", message: "Unknown product." });
});

router.post("/purchases/restore", requireAuth, requireActiveAccount, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const [purchases, entitlements, balanceRows] = await Promise.all([
    db
      .select({
        productId: userPurchasesTable.productId,
        transactionId: userPurchasesTable.transactionId,
        createdAt: userPurchasesTable.createdAt,
      })
      .from(userPurchasesTable)
      .where(eq(userPurchasesTable.userId, userId))
      .orderBy(desc(userPurchasesTable.createdAt)),
    db
      .select({
        entitlementKey: userEntitlementsTable.entitlementKey,
        status: userEntitlementsTable.status,
        productId: userEntitlementsTable.productId,
      })
      .from(userEntitlementsTable)
      .where(eq(userEntitlementsTable.userId, userId)),
    db
      .select({ currentBalance: coinBalancesTable.currentBalance })
      .from(coinBalancesTable)
      .where(eq(coinBalancesTable.userId, userId))
      .limit(1),
  ]);

  return res.json({
    success: true,
    coin_balance: balanceRows[0]?.currentBalance ?? 0,
    purchases: purchases.map((row) => ({
      product_id: row.productId,
      transaction_id: row.transactionId,
      created_at: row.createdAt.toISOString(),
    })),
    entitlements: entitlements.map((row) => ({
      entitlement_key: row.entitlementKey,
      product_id: row.productId,
      status: row.status,
    })),
  });
});

// ── GET /api/iap/history ──────────────────────────────────────────────────────
// Returns the user's purchase history (no receipt/token data).
router.get("/iap/history", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const rows = await db
    .select({
      id:         userPurchasesTable.id,
      productId:  userPurchasesTable.productId,
      productType: userPurchasesTable.productType,
      platform:   userPurchasesTable.platform,
      status:     userPurchasesTable.status,
      createdAt:  userPurchasesTable.createdAt,
    })
    .from(userPurchasesTable)
    .where(eq(userPurchasesTable.userId, userId))
    .orderBy(desc(userPurchasesTable.createdAt))
    .limit(50);

  const DISPLAY_NAMES: Record<string, string> = {
    coins_100:         "100 Coins",
    coins_500:         "500 Coins",
    coins_1200:        "1,200 Coins",
    coins_2500:        "2,500 Coins",
    coins_5000:        "5,000 Coins",
    mic_pass_lifetime: "Mic Pass",
  };

  const items = rows.map((r) => ({
    id:           r.id,
    product_id:   r.productId,
    display_name: DISPLAY_NAMES[r.productId] ?? r.productId,
    platform:     r.platform,
    status:       r.status,
    coin_amount:  COIN_PRODUCT_MAP[r.productId] ?? null,
    created_at:   r.createdAt.toISOString(),
  }));

  return res.json({ success: true, items });
});

// ── GET /api/purchases/summary ────────────────────────────────────────────────
// Single-roundtrip endpoint: returns coin balance, IAP stats, and purchase history.
// Used by the Shop tab and Profile to recalculate all purchase-related data from DB.
router.get("/purchases/summary", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const rawLD = typeof req.query.localDate === "string" ? req.query.localDate : "";
  const today = /^\d{4}-\d{2}-\d{2}$/.test(rawLD) ? rawLD : new Date().toISOString().split("T")[0]!;
  const todayStart = new Date(`${today}T00:00:00.000Z`);
  const todayEnd = new Date(`${today}T23:59:59.999Z`);

  try {
    const [balanceRows, purchaseRows, entitlementRows, todayEarnedRows] = await Promise.all([
      db.select()
        .from(coinBalancesTable)
        .where(eq(coinBalancesTable.userId, userId))
        .limit(1),

      db.select({
        id:          userPurchasesTable.id,
        productId:   userPurchasesTable.productId,
        productType: userPurchasesTable.productType,
        platform:    userPurchasesTable.platform,
        status:      userPurchasesTable.status,
        createdAt:   userPurchasesTable.createdAt,
      })
        .from(userPurchasesTable)
        .where(eq(userPurchasesTable.userId, userId))
        .orderBy(desc(userPurchasesTable.createdAt))
        .limit(20),

      db.select({ entitlementKey: userEntitlementsTable.entitlementKey })
        .from(userEntitlementsTable)
        .where(and(eq(userEntitlementsTable.userId, userId), eq(userEntitlementsTable.status, "active"))),

      db.select({ total: sql<number>`coalesce(sum(${coinTransactionsTable.amount}), 0)` })
        .from(coinTransactionsTable)
        .where(and(
          eq(coinTransactionsTable.userId, userId),
          eq(coinTransactionsTable.transactionType, "earn"),
          gte(coinTransactionsTable.createdAt, todayStart),
          lte(coinTransactionsTable.createdAt, todayEnd),
        )),
    ]);

    const bal = balanceRows[0] ?? { currentBalance: 0, lifetimeEarned: 0, lifetimeSpent: 0 };
    const hasMicPass = entitlementRows.some((e) => e.entitlementKey === "mic_pass");
    const earnedToday = Number(todayEarnedRows[0]?.total ?? 0);

    const DISPLAY_NAMES: Record<string, string> = {
      coins_100:         "100 Coins",
      coins_500:         "500 Coins",
      coins_1200:        "1,200 Coins",
      coins_2500:        "2,500 Coins",
      coins_5000:        "5,000 Coins",
      mic_pass_lifetime: "Mic Pass",
    };

    const totalCoinsPurchased = purchaseRows.reduce(
      (sum, r) => sum + (COIN_PRODUCT_MAP[r.productId] ?? 0),
      0,
    );

    return res.json({
      success: true,
      coin_balance: {
        current:          bal.currentBalance,
        lifetime_earned:  bal.lifetimeEarned,
        lifetime_spent:   bal.lifetimeSpent,
        earned_today:     earnedToday,
      },
      iap: {
        total_purchases:       purchaseRows.length,
        total_coins_purchased: totalCoinsPurchased,
        has_mic_pass:          hasMicPass,
      },
      purchase_history: purchaseRows.map((r) => ({
        id:           r.id,
        product_id:   r.productId,
        display_name: DISPLAY_NAMES[r.productId] ?? r.productId,
        platform:     r.platform,
        status:       r.status,
        coin_amount:  COIN_PRODUCT_MAP[r.productId] ?? null,
        is_mic_pass:  r.productId === "mic_pass_lifetime",
        created_at:   r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    req.log.error({ err, userId }, "[purchases/summary] query failed");
    return res.status(500).json({ success: false, message: "Failed to load purchase summary." });
  }
});

// ── POST /api/races/:raceId/voice-token ───────────────────────────────────────
// Validates race access and Mic Pass ownership, then issues a short-lived
// LiveKit token scoped to room "race_<raceId>".
// Token secret never leaves the backend.
router.post("/races/:raceId/voice-token", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  // Express route params are always plain strings, but TypeScript widens to
  // string | string[] at type level — cast once here to satisfy Drizzle.
  const raceId = req.params.raceId as string;

  const livekitUrl    = process.env.LIVEKIT_URL;
  const livekitApiKey = process.env.LIVEKIT_API_KEY;
  const livekitSecret = process.env.LIVEKIT_API_SECRET;

  if (!livekitUrl || !livekitApiKey || !livekitSecret) {
    req.log.warn("[VoiceSDK] config present: false — LIVEKIT env vars missing");
    return res.status(503).json({
      success: false,
      code: "VOICE_SDK_NOT_CONFIGURED",
      message: "Voice chat is not configured on this server.",
    });
  }

  // 1. Verify race exists and is in progress.
  const [race] = await db
    .select({ id: raceRoomsTable.id, status: raceRoomsTable.status })
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.id, raceId))
    .limit(1);

  if (!race) {
    return res.status(404).json({ success: false, code: "RACE_NOT_FOUND", message: "Race not found." });
  }
  if (race.status !== "in_progress") {
    return res.status(403).json({ success: false, code: "RACE_NOT_LIVE", message: "Race is not currently live." });
  }

  // 2. Check whether the user is an active participant.
  const [participant] = await db
    .select({ status: raceParticipantsTable.status })
    .from(raceParticipantsTable)
    .where(
      and(
        eq(raceParticipantsTable.raceRoomId, raceId),
        eq(raceParticipantsTable.userId, userId),
        inArray(raceParticipantsTable.status, ["joined", "active"]),
      ),
    )
    .limit(1);

  // 3. Publishing rights — active participants with Mic Pass may speak.
  // Spectators can still join the room, but only as listen-only.
  let canPublishAudio = false;
  if (participant) {
    const [micPassRow] = await db
      .select({ id: userEntitlementsTable.id })
      .from(userEntitlementsTable)
      .where(
        and(
          eq(userEntitlementsTable.userId, userId),
          eq(userEntitlementsTable.entitlementKey, "mic_pass"),
          eq(userEntitlementsTable.status, "active"),
        ),
      )
      .limit(1);

    canPublishAudio = !!micPassRow;
    req.log.info({ userId, raceId, canPublishAudio }, "[MicPass] has_mic_pass: %s", canPublishAudio);
  } else {
    req.log.info({ userId, raceId }, "[Voice] spectator listen-only token issued");
  }

  // 4. Generate a short-lived LiveKit token scoped to this race's room.
  const roomName = `race_${raceId}`;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  const at = new AccessToken(livekitApiKey, livekitSecret, {
    identity: userId,
    ttl: "1h",
  });

  at.addGrant({
    roomJoin:       true,
    room:           roomName,
    canPublish:     canPublishAudio,
    canSubscribe:   true,
    canPublishData: canPublishAudio,
  });

  const token = await at.toJwt();

  // 5. Log the session (best-effort — never store the token itself).
  db.insert(voiceSessionsTable)
    .values({
      raceId,
      userId,
      provider: "livekit",
      roomName,
      canPublishAudio,
      connectedAt: new Date(),
    })
    .catch(() => {});

  req.log.info({ userId, raceId, roomName, canPublishAudio }, "[VoiceSDK] config present: true");

  return res.json({
    success: true,
    provider: "livekit",
    url: livekitUrl,
    room_name: roomName,
    token,
    can_publish_audio: canPublishAudio,
    expires_at: expiresAt.toISOString(),
  });
});

// ── POST /api/voice/token  (legacy — deprecated, use /api/races/:id/voice-token) ─
const voiceTokenSchema = z.object({
  race_id: z.string().optional(),
  room_id: z.string().optional(),
});

router.post("/voice/token", requireAuth, async (req, res) => {
  const parse = voiceTokenSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ success: false, message: "Invalid request." });
  const { race_id, room_id } = parse.data;
  if (!race_id && !room_id) {
    return res.status(400).json({ success: false, message: "race_id or room_id required." });
  }
  return res.status(301).json({
    success: false,
    code: "ENDPOINT_MOVED",
    message: "Use POST /api/races/:raceId/voice-token instead.",
    location: `/api/races/${race_id ?? room_id}/voice-token`,
  });
});

export default router;
