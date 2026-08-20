import { Router } from "express";
import { logger } from "../lib/logger.js";
import {
  verifyAppleSignedPayload,
  appleRefundTransactionId,
  applyStoreRefund,
} from "../lib/storeNotificationsService.js";

const router = Router();

/**
 * Store refund / revocation webhooks (audit 2026-08-17 M1). These claw back coins / Mic Pass when
 * a user refunds a purchase after we granted the value.
 *
 * Deploy note: these URLs must be registered in the store consoles —
 *   Apple:  App Store Connect → App Information → App Store Server Notifications V2 production URL →
 *           https://<host>/api/webhooks/apple/store-notifications
 *   Google: Play Console → Monetization setup → Real-time developer notifications topic, with a
 *           Pub/Sub push subscription to
 *           https://<host>/api/webhooks/google/rtdn?token=<GOOGLE_RTDN_VERIFICATION_TOKEN>
 * Both authenticate the caller (Apple by JWS x5c chain; Google by the shared push token) and
 * fail closed — an unverifiable notification performs no clawback. End-to-end verification requires
 * the store-side configuration above and should be exercised against staging before launch.
 */

// ── Apple App Store Server Notifications V2 ──────────────────────────────────
router.post("/webhooks/apple/store-notifications", async (req, res) => {
  const signedPayload = (req.body as { signedPayload?: unknown })?.signedPayload;
  if (typeof signedPayload !== "string") {
    return res.status(400).json({ error: "missing signedPayload" });
  }

  let refundTransactionId: string | null;
  try {
    const payload = verifyAppleSignedPayload(signedPayload);
    refundTransactionId = appleRefundTransactionId(payload);
    logger.info(
      { notificationType: payload.notificationType, subtype: payload.subtype },
      "[AppleASSN] verified notification",
    );
  } catch (err) {
    // Fail closed: reject an unverifiable notification and do not claw back anything.
    logger.warn({ err }, "[AppleASSN] signature verification failed — ignoring");
    return res.status(401).json({ error: "invalid signedPayload" });
  }

  // Not a refund/revoke, or no transaction id — acknowledge so Apple stops retrying.
  if (!refundTransactionId) return res.status(200).json({ ok: true });

  try {
    const result = await applyStoreRefund({
      provider: "apple",
      transactionId: refundTransactionId,
      reason: "apple_refund_notification",
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err, transactionId: refundTransactionId }, "[AppleASSN] clawback failed");
    // 500 so Apple retries the (verified) notification later.
    return res.status(500).json({ error: "clawback_failed" });
  }
});

// ── Google Play Real-time Developer Notifications (Pub/Sub push) ──────────────
type GoogleRtdnData = {
  voidedPurchaseNotification?: { purchaseToken?: string; orderId?: string; productType?: number; refundType?: number };
};

router.post("/webhooks/google/rtdn", async (req, res) => {
  const expectedToken = process.env.GOOGLE_RTDN_VERIFICATION_TOKEN?.trim();
  // Fail closed: without a configured shared token we cannot authenticate the push, so reject.
  if (!expectedToken) {
    logger.warn("[GoogleRTDN] GOOGLE_RTDN_VERIFICATION_TOKEN not set — rejecting");
    return res.status(503).json({ error: "rtdn_not_configured" });
  }
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (token !== expectedToken) {
    return res.status(401).json({ error: "invalid_token" });
  }

  const message = (req.body as { message?: { data?: unknown } })?.message;
  const dataB64 = typeof message?.data === "string" ? message.data : null;
  if (!dataB64) return res.status(204).end(); // subscription validation / empty — ack

  let voided: GoogleRtdnData["voidedPurchaseNotification"];
  try {
    const decoded = JSON.parse(Buffer.from(dataB64, "base64").toString("utf8")) as GoogleRtdnData;
    voided = decoded.voidedPurchaseNotification;
  } catch (err) {
    logger.warn({ err }, "[GoogleRTDN] undecodable message — acking to stop redelivery");
    return res.status(204).end();
  }

  // Only voided (refunded/charged-back) purchases trigger a clawback; ack everything else.
  if (!voided?.purchaseToken) return res.status(204).end();

  try {
    const result = await applyStoreRefund({
      provider: "google",
      purchaseToken: voided.purchaseToken,
      reason: "google_voided_purchase",
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err }, "[GoogleRTDN] clawback failed");
    // 500 so Pub/Sub redelivers the (authenticated) message.
    return res.status(500).json({ error: "clawback_failed" });
  }
});

export default router;
