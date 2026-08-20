import { X509Certificate, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import {
  userPurchasesTable,
  userEntitlementsTable,
  coinTransactionsTable,
  coinBalancesTable,
  profilesTable,
} from "../../db/src/schema/index.js";
import { recordCoinLedgerEntry } from "./coinsService.js";
import { writeAuditLog } from "./auditLog.js";
import { logger } from "./logger.js";
import { cacheAccountStatus } from "./sessionService.js";

/**
 * Store refund / revocation handling (audit 2026-08-17 M1). Apple App Store Server Notifications v2
 * and Google Play RTDN (voided purchases) tell us when a user refunds a purchase AFTER we granted
 * the coins / Mic Pass. Without this, refunded value survives — a repeatable revenue leak. Both
 * endpoints (routes/storeNotifications.ts) authenticate the caller and then call applyStoreRefund,
 * which reverses the grant idempotently.
 *
 * Security posture is fail-closed: any verification failure rejects the notification and performs
 * NO clawback, so a forged refund can never confiscate a victim's coins.
 */

// Apple Root CA - G3 SHA-256 fingerprint (colon-free, lowercase). The signedPayload's x5c chain
// must terminate at this root, proving Apple signed the notification. Pinned rather than trusting
// the system store so a mis-configured trust store cannot widen what we accept.
const APPLE_ROOT_CA_G3_SHA256 =
  "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179";

function b64urlToBuffer(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function certFingerprintSha256(cert: X509Certificate): string {
  return cert.fingerprint256.replace(/:/g, "").toLowerCase();
}

/** Decode a JWS segment's JSON payload without verification (used only on already-verified JWS). */
function decodeJwsPayload<T>(jws: string): T {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("malformed JWS");
  return JSON.parse(b64urlToBuffer(parts[1]).toString("utf8")) as T;
}

type AppleNotificationPayload = {
  notificationType: string;
  subtype?: string;
  data?: { signedTransactionInfo?: string; bundleId?: string; environment?: string };
};

type AppleTransactionInfo = {
  transactionId?: string;
  originalTransactionId?: string;
  productId?: string;
  type?: string;
};

/**
 * Verify an Apple ASSN v2 signedPayload JWS: validate the x5c certificate chain terminates at the
 * pinned Apple Root CA and that the leaf signed the JWS (ES256). Throws on any failure.
 */
export function verifyAppleSignedPayload(signedPayload: string): AppleNotificationPayload {
  const [headerB64, payloadB64, signatureB64] = signedPayload.split(".");
  if (!headerB64 || !payloadB64 || !signatureB64) throw new Error("malformed signedPayload");

  const header = JSON.parse(b64urlToBuffer(headerB64).toString("utf8")) as { alg?: string; x5c?: string[] };
  if (header.alg !== "ES256") throw new Error(`unexpected JWS alg ${header.alg}`);
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length < 2) throw new Error("missing x5c chain");

  const chain = x5c.map((der) => new X509Certificate(Buffer.from(der, "base64")));
  const leaf = chain[0];
  const root = chain[chain.length - 1];

  // Root must be the pinned Apple root.
  if (certFingerprintSha256(root) !== APPLE_ROOT_CA_G3_SHA256) {
    throw new Error("x5c root is not the pinned Apple Root CA - G3");
  }
  // Each certificate must be signed by the next one up the chain, and each must be time-valid.
  const nowMs = Date.now();
  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i];
    if (nowMs < Date.parse(cert.validFrom) || nowMs > Date.parse(cert.validTo)) {
      throw new Error("x5c certificate outside validity window");
    }
    const issuer = chain[i + 1] ?? root;
    if (!cert.verify(issuer.publicKey)) {
      throw new Error("x5c chain signature verification failed");
    }
  }

  // Verify the JWS signature over `${header}.${payload}` with the leaf public key. JWS ES256
  // signatures are raw r||s (IEEE P1363), which Node's verify needs told explicitly.
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = b64urlToBuffer(signatureB64);
  const ok = cryptoVerify(
    "sha256",
    signingInput,
    { key: createPublicKey(leaf.publicKey), dsaEncoding: "ieee-p1363" },
    signature,
  );
  if (!ok) throw new Error("signedPayload signature invalid");

  return decodeJwsPayload<AppleNotificationPayload>(signedPayload);
}

/** Extract the refunded/revoked transaction id from a verified Apple notification, if any. */
export function appleRefundTransactionId(payload: AppleNotificationPayload): string | null {
  // REFUND = consumer refund; REVOKE = Family Sharing revocation. Both remove the entitlement.
  if (payload.notificationType !== "REFUND" && payload.notificationType !== "REVOKE") return null;
  const info = payload.data?.signedTransactionInfo;
  if (!info) return null;
  const tx = decodeJwsPayload<AppleTransactionInfo>(info);
  return tx.transactionId ?? tx.originalTransactionId ?? null;
}

type ClawbackInput = {
  provider: "apple" | "google";
  transactionId?: string | null;
  purchaseToken?: string | null;
  reason: string;
};

export function planCoinClawback(grantedCoins: number, currentBalance: number): {
  debitCoins: number;
  debtCoins: number;
} {
  const granted = Math.max(0, Math.floor(grantedCoins));
  const available = Math.max(0, Math.floor(currentBalance));
  const debitCoins = Math.min(granted, available);
  return { debitCoins, debtCoins: granted - debitCoins };
}

/**
 * Idempotently reverse a granted purchase: debit the coins it credited (consumables) or revoke the
 * entitlement it unlocked (Mic Pass), and mark the purchase row refunded. Safe to call more than
 * once — the status CAS and the clawback ledger idempotency key make repeats no-ops.
 */
export async function applyStoreRefund(input: ClawbackInput): Promise<{ clawedBack: boolean; reason: string }> {
  const [purchase] = await db
    .select()
    .from(userPurchasesTable)
    .where(
      input.transactionId
        ? eq(userPurchasesTable.transactionId, input.transactionId)
        : eq(userPurchasesTable.purchaseToken, input.purchaseToken ?? "__none__"),
    )
    .limit(1);

  if (!purchase) return { clawedBack: false, reason: "purchase_not_found" };
  if (purchase.status === "refunded") return { clawedBack: false, reason: "already_refunded" };

  let clawedBack = false;
  let debtCoins = 0;
  await db.transaction(async (tx) => {
    // Serialize duplicate Apple/Google deliveries before touching balances. Marking the purchase
    // refunded happens only after the reversal/debt state is durable in this same transaction.
    const [lockedPurchase] = await tx
      .select()
      .from(userPurchasesTable)
      .where(eq(userPurchasesTable.id, purchase.id))
      .limit(1)
      .for("update");
    if (!lockedPurchase || lockedPurchase.status === "refunded") return;

    if (lockedPurchase.productType === "consumable" && lockedPurchase.transactionId) {
      // Reverse the coins granted at purchase (recorded under `iap:{userId}:{transactionId}`).
      const [grant] = await tx
        .select({ amount: coinTransactionsTable.amount })
        .from(coinTransactionsTable)
        .where(and(
          eq(coinTransactionsTable.userId, lockedPurchase.userId),
          eq(coinTransactionsTable.idempotencyKey, `iap:${lockedPurchase.userId}:${lockedPurchase.transactionId}`),
        ))
        .limit(1);
      const coins = grant?.amount ?? 0;
      if (coins > 0) {
        const [balance] = await tx
          .select({ currentBalance: coinBalancesTable.currentBalance })
          .from(coinBalancesTable)
          .where(eq(coinBalancesTable.userId, lockedPurchase.userId))
          .limit(1)
          .for("update");
        const plan = planCoinClawback(coins, balance?.currentBalance ?? 0);
        debtCoins = plan.debtCoins;
        if (plan.debitCoins > 0) {
          await recordCoinLedgerEntry(tx, {
            userId: lockedPurchase.userId,
            amount: -plan.debitCoins,
            transactionType: "adjustment",
            source: "iap_refund_clawback",
            sourceId: lockedPurchase.transactionId,
            rewardCode: null,
            reasonCode: input.reason,
            idempotencyKey: `iap-clawback:${lockedPurchase.transactionId}`,
            description: `Coins reversed — store refund (${lockedPurchase.productId})`,
            metadata: {
              productId: lockedPurchase.productId,
              provider: input.provider,
              reason: input.reason,
              grantedCoins: coins,
              debtCoins,
            },
          });
        }

        if (debtCoins > 0) {
          // The refunded value was already spent. Preserve the non-negative coin invariant, record
          // the unrecovered amount on the purchase below, and freeze money/reward activity for ops
          // review instead of retrying the webhook forever.
          await tx
            .update(profilesTable)
            .set({
              accountStatus: sql`case when ${profilesTable.accountStatus} = 'active' then 'pending_verification'::account_status else ${profilesTable.accountStatus} end`,
              paidRaceEnabled: false,
              withdrawalsEnabled: false,
              fraudScore: sql`${profilesTable.fraudScore} + 25`,
              updatedAt: new Date(),
            })
            .where(eq(profilesTable.id, lockedPurchase.userId));
        }
      }
    } else {
      // Non-consumable (Mic Pass): revoke the entitlement unlocked by this purchase.
      await tx
        .update(userEntitlementsTable)
        .set({ status: "revoked", updatedAt: new Date() })
        .where(and(
          eq(userEntitlementsTable.userId, lockedPurchase.userId),
          or(
            lockedPurchase.transactionId ? eq(userEntitlementsTable.transactionId, lockedPurchase.transactionId) : undefined,
            lockedPurchase.purchaseToken ? eq(userEntitlementsTable.purchaseToken, lockedPurchase.purchaseToken) : undefined,
          ),
        ));
    }

    await tx
      .update(userPurchasesTable)
      .set({
        status: "refunded",
        rawReceiptJson: sql`coalesce(${userPurchasesTable.rawReceiptJson}, '{}'::jsonb) || ${JSON.stringify({
          refundProvider: input.provider,
          refundReason: input.reason,
          refundedAt: new Date().toISOString(),
        })}::jsonb || jsonb_build_object('clawbackDebtCoins', ${debtCoins})`,
        updatedAt: new Date(),
      })
      .where(eq(userPurchasesTable.id, lockedPurchase.id));
    clawedBack = true;
  });

  if (clawedBack && debtCoins > 0) {
    const [restricted] = await db
      .select({ accountStatus: profilesTable.accountStatus })
      .from(profilesTable)
      .where(eq(profilesTable.id, purchase.userId))
      .limit(1);
    if (restricted) await cacheAccountStatus(purchase.userId, restricted.accountStatus);
  }

  if (clawedBack) {
    void writeAuditLog({
      actorUserId: purchase.userId,
      actorType: "system",
      action: "iap.refund_clawback",
      entityType: "purchase",
      entityId: purchase.transactionId ?? purchase.purchaseToken ?? purchase.id,
      reason: input.reason,
      metadata: { provider: input.provider, productId: purchase.productId, productType: purchase.productType, debtCoins },
    });
    logger.info(
      { userId: purchase.userId, provider: input.provider, productId: purchase.productId, transactionId: purchase.transactionId },
      "[StoreRefund] clawed back refunded purchase",
    );
  }

  return { clawedBack, reason: clawedBack ? "refunded" : "already_refunded" };
}
