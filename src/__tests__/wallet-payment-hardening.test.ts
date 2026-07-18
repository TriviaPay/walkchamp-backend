import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("wallet payment hardening", () => {
  it("keeps wallet deposit credits in the shared settlement service", () => {
    const depositRoute = readFileSync("src/routes/deposit.ts", "utf8");
    const settlementService = readFileSync("src/lib/depositSettlement.ts", "utf8");

    expect(depositRoute).toContain("settleRazorpayPayment");
    expect(depositRoute).toContain("processDepositWebhookEvent");
    expect(depositRoute).not.toContain("creditWalletForDeposit");
    expect(depositRoute).not.toContain("transactionType: \"manual_adjustment\"");

    expect(settlementService).toContain("export async function settleDepositOnce");
    expect(settlementService).toContain("transactionType: \"deposit_credit\"");
    expect(settlementService).toContain("idempotencyKey = `deposit_credit:${lockedDeposit.id}`");
  });

  it("blocks the legacy direct Stripe paid-race creation path", () => {
    const paymentsRoute = readFileSync("src/routes/payments.ts", "utf8");

    expect(paymentsRoute).toContain("DIRECT_RACE_PAYMENTS_DISABLED");
    expect(paymentsRoute).toContain("res.status(410)");
    expect(paymentsRoute).not.toContain("payment intent created");
    expect(paymentsRoute).not.toContain("joinOrReviveParticipant(tx");
  });

  it("adds ledger idempotency, deposit-credit uniqueness, and signed amount checks", () => {
    const migration = readFileSync("db/migrations/0009_wallet_payment_hardening.sql", "utf8");
    const walletSchema = readFileSync("db/src/schema/wallets.ts", "utf8");
    const hardeningSchema = readFileSync("db/src/schema/hardening.ts", "utf8");

    expect(walletSchema).toContain("deposit_credit");
    expect(walletSchema).toContain("depositTransactionId");
    expect(walletSchema).toContain("wallet_transactions_idempotency_key_unique_idx");
    expect(hardeningSchema).toContain("operationalLocksTable");

    expect(migration).toContain("wallet_transactions_deposit_credit_unique_idx");
    expect(migration).toContain("wallet_transactions_signed_amount_check");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS \"operational_locks\"");
    expect(migration).toContain("\"status\" = 'processing'");
  });

  it("uses deterministic idempotency keys for cash challenge debits and prizes", () => {
    const cashChallengePayments = readFileSync("src/lib/cashChallengePayments.ts", "utf8");
    const refundService = readFileSync("src/lib/refundService.ts", "utf8");

    expect(cashChallengePayments).toContain("challenge_entry:${input.raceRoomId}:${input.userId}");
    expect(cashChallengePayments).toContain("prize:${input.raceRoomId}:${payout.userId}:${payout.rank}");
    expect(cashChallengePayments).toContain("transactionType: \"race_prize_paid\"");
    expect(cashChallengePayments).toContain("Cash challenge prize requires USD wallet");
    expect(refundService).toContain("idempotencyKey: input.idempotencyKey");
    expect(refundService).toContain("CASH_CHALLENGES_UNSUPPORTED_FOR_CURRENCY");
  });

  it("hardens Razorpay checkout signatures, create-order idempotency, and manual capture", () => {
    const depositRoute = readFileSync("src/routes/deposit.ts", "utf8");
    const settlementService = readFileSync("src/lib/depositSettlement.ts", "utf8");
    const security = readFileSync("src/lib/razorpaySecurity.ts", "utf8");

    expect(security).toContain("timingSafeEqual");
    expect(depositRoute).toContain("verifyRazorpayCheckoutSignature");
    expect(depositRoute).toContain("verifyRazorpaySignature");
    expect(depositRoute).toContain("legacy create-order without stable idempotency key");
    expect(depositRoute).toContain("razorpay_deposit:${userId}:${clientKey}");
    expect(depositRoute).toContain("IDEMPOTENCY_KEY_CONFLICT");
    expect(depositRoute).toContain("IDEMPOTENCY_KEY_TERMINAL");
    expect(depositRoute).toContain("ORDER_CREATION_IN_PROGRESS");
    expect(depositRoute).toContain("status: \"order_creating\"");
    expect(depositRoute).toContain("router.post(\"/wallet/deposit/razorpay/verify\"");
    expect(settlementService).toContain("captureRazorpayAuthorizedPayment");
    expect(settlementService).toContain("payment.status === \"authorized\"");
    expect(settlementService).toContain(".capture(paymentId, amount, currency)");
    expect(settlementService).toContain("razorpay_capture_failed");
  });

  it("blocks INR/Razorpay cash challenges until multi-currency wallet support ships", () => {
    const fees = readFileSync("src/lib/cashChallengeFees.ts", "utf8");
    const racesRoute = readFileSync("src/routes/races.ts", "utf8");

    expect(fees).toContain("CASH_CHALLENGES_UNSUPPORTED_FOR_CURRENCY");
    expect(fees).toContain("isCashChallengeUnsupportedForCountry");
    expect(racesRoute).toContain("[CashChallenge] INR/Razorpay quote blocked");
    expect(racesRoute).toContain("[CashChallenge] INR/Razorpay host blocked");
    expect(racesRoute).toContain("[CashChallenge] INR/Razorpay paid join blocked");
    expect(racesRoute).toContain("[CashChallenge] INR/Razorpay private paid join blocked");
    expect(racesRoute).toContain("[CashChallenge] INR/Razorpay race start debit blocked");
    expect(racesRoute).toContain("const effectiveCountryCode = profileForQuote?.countryCode ?? countryCode");
    expect(racesRoute).toContain("class PaidJoinRollback");
    expect(racesRoute).toContain("throw new PaidJoinRollback(402");
  });

  it("does not create default USD wallets for provider-specific deposits", () => {
    const depositRoute = readFileSync("src/routes/deposit.ts", "utf8");

    expect(depositRoute).toContain("values({ userId, currency: expectedCurrency })");
    expect(depositRoute).not.toContain("const wallet = await getOrCreateWallet(userId)");
  });

  it("keeps user/browser cancel paths metadata-only", () => {
    const depositRoute = readFileSync("src/routes/deposit.ts", "utf8");

    expect(depositRoute).toContain("userCancelSeenAt");
    expect(depositRoute).toContain("displayStatus: \"cancelled\"");
    expect(depositRoute).not.toContain(".set({ status: \"cancelled\"");
    expect(depositRoute).not.toContain(".set({ status: \"failed\", failureReason: reason");
  });

  it("persists Razorpay failed attempts without terminal deposit mutation", () => {
    const webhookProcessor = readFileSync("src/lib/depositWebhookProcessor.ts", "utf8");

    expect(webhookProcessor).toContain("recordRazorpayFailedAttemptMetadata");
    expect(webhookProcessor).toContain("razorpayFailedAttempts");
    expect(webhookProcessor).toContain("payment.failed recorded without terminal deposit mutation");
  });

  it("creates durable sponsored gift-card fulfillment records for winners", () => {
    const giftCardSchema = readFileSync("db/src/schema/sponsoredGiftCards.ts", "utf8");
    const migration = readFileSync("db/migrations/0011_sponsored_gift_card_awards.sql", "utf8");
    const helper = readFileSync("src/lib/sponsoredGiftCards.ts", "utf8");
    const sponsoredEventsRoute = readFileSync("src/routes/sponsoredEvents.ts", "utf8");
    const racesRoute = readFileSync("src/routes/races.ts", "utf8");
    const adminRoute = readFileSync("src/routes/admin.ts", "utf8");
    const logger = readFileSync("src/lib/logger.ts", "utf8");

    expect(giftCardSchema).toContain("sponsoredGiftCardAwardsTable");
    expect(giftCardSchema).toContain("pending_fulfillment");
    expect(giftCardSchema).toContain("fulfillmentCode");
    expect(giftCardSchema).toContain("sponsored_gift_card_awards_room_user_uniq");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS \"sponsored_gift_card_awards\"");
    expect(helper).toContain("createPendingSponsoredGiftCardAwards");
    expect(helper).toContain(".onConflictDoNothing()");
    expect(sponsoredEventsRoute).toContain("source: \"sponsored_event_finalizer\"");
    expect(sponsoredEventsRoute).toContain("getSponsoredWinnerCount(parts.length)");
    expect(racesRoute).toContain("source: \"race_auto_completion\"");
    expect(racesRoute).toContain("assignSponsoredGiftCardPayouts");
    expect(adminRoute).toContain("/admin/sponsored-gift-card-awards");
    expect(adminRoute).toContain("redactGiftCardAward");
    expect(adminRoute).toContain("sponsored_gift_card_fulfilled");
    expect(adminRoute).toContain("hasFulfillmentCode");
    expect(logger).toContain("body.fulfillmentCode");
  });

  it("records provider deposit reversals as separate debit ledger rows", () => {
    const webhookProcessor = readFileSync("src/lib/depositWebhookProcessor.ts", "utf8");
    const settlementService = readFileSync("src/lib/depositSettlement.ts", "utf8");

    expect(settlementService).toContain("export async function recordDepositProviderReversal");
    expect(settlementService).toContain("transactionType: input.reversalType");
    expect(settlementService).toContain("deposit_refund_debit");
    expect(settlementService).toContain("chargeback_debit");
    expect(settlementService).toContain("remainingReversibleMinorUnits");
    expect(settlementService).toContain("reversal_exceeds_deposit_credit");
    expect(webhookProcessor).toContain("recordStripeDepositReversalFromEvent");
    expect(webhookProcessor).toContain("eventType.startsWith(\"dispute.\")");
  });

  it("preserves raw webhook bodies before JSON parsing", () => {
    const app = readFileSync("src/app.ts", "utf8");
    const rawIndex = app.indexOf("express.raw({ type: \"application/json\"");
    const jsonIndex = app.indexOf("express.json({ limit: config.runtime.jsonBodyLimit })");

    expect(app).toContain("\"/api/payments/webhook\"");
    expect(app).toContain("\"/api/webhooks/stripe\"");
    expect(app).toContain("\"/api/webhooks/razorpay\"");
    expect(rawIndex).toBeGreaterThan(-1);
    expect(jsonIndex).toBeGreaterThan(-1);
    expect(rawIndex).toBeLessThan(jsonIndex);
  });

  it("queues signature-verified deposit webhooks and processes them through workers", () => {
    const depositRoute = readFileSync("src/routes/deposit.ts", "utf8");
    const worker = readFileSync("src/worker.ts", "utf8");
    const processor = readFileSync("src/lib/depositWebhookProcessor.ts", "utf8");

    expect(depositRoute).toContain("processingStatus: \"signature_verified\"");
    expect(depositRoute).toContain("req.headers[\"x-razorpay-event-id\"]");
    expect(depositRoute).toContain("createHash(\"sha256\").update(rawBody)");
    expect(depositRoute).toContain("recordOutboxEvent");
    expect(depositRoute).toContain("eventType: \"deposit_webhook.process\"");
    expect(depositRoute).toContain("topic: \"webhook-processing\"");
    expect(worker).toContain("startQueueWorker(\"webhook-processing\"");
    expect(worker).toContain("processDepositWebhookEvent({ provider, providerEventId })");
    expect(processor).toContain("processingStatus: \"processing\"");
    expect(processor).toContain("processingStatus: \"failed_retryable\"");
    expect(processor).toContain("processingStatus: \"processed\"");
  });

  it("runs read-only wallet ledger reconciliation from background jobs", () => {
    const reconciliation = readFileSync("src/lib/walletLedgerReconciliation.ts", "utf8");
    const backgroundJobs = readFileSync("src/lib/backgroundJobs.ts", "utf8");
    const operationalLocks = readFileSync("src/lib/operationalLocks.ts", "utf8");

    expect(reconciliation).toContain("export async function runWalletLedgerReconciliationTick");
    expect(reconciliation).toContain("succeededDepositsMissingCredit");
    expect(reconciliation).toContain("duplicateIdempotencyKeys");
    expect(reconciliation).toContain("missingIdempotencyKeys");
    expect(reconciliation).toContain("negativeWalletBalances");
    expect(reconciliation).toContain("markMissingCreditDepositsRequiresReview");
    expect(reconciliation).toContain("setOperationalLock");
    expect(reconciliation).toContain("wallet.ledger_reconciliation");
    expect(operationalLocks).toContain("WALLET_LEDGER_ANOMALY_LOCK");
    expect(backgroundJobs).toContain("runWalletLedgerReconciliationTick");
    expect(backgroundJobs).toContain("wallet ledger reconciliation tick failed");
  });

  it("blocks withdrawals and withdrawal approvals while ledger anomalies are active", () => {
    const walletRoute = readFileSync("src/routes/wallet.ts", "utf8");
    const adminRoute = readFileSync("src/routes/admin.ts", "utf8");

    expect(walletRoute).toContain("WITHDRAWALS_PAUSED_LEDGER_REVIEW");
    expect(walletRoute).toContain("assertOperationalLockOpen");
    expect(adminRoute).toContain("WITHDRAWAL_APPROVALS_PAUSED_LEDGER_REVIEW");
    expect(adminRoute).toContain("assertOperationalLockOpen");
    expect(adminRoute).toContain("/admin/operational-locks");
    expect(adminRoute).toContain("admin.operational_lock.resolve");
  });

  it("makes withdrawal requests idempotent and balance-safe", () => {
    const walletRoute = readFileSync("src/routes/wallet.ts", "utf8");
    const withdrawalSchema = readFileSync("db/src/schema/withdrawals.ts", "utf8");
    const migration = readFileSync("db/migrations/0009_wallet_payment_hardening.sql", "utf8");

    expect(walletRoute).toContain("IDEMPOTENCY_KEY_REQUIRED");
    expect(walletRoute).toContain("withdrawalIdempotencyKey = `withdrawal:${userId}:${idempotency.key}`");
    expect(walletRoute).toContain(".for(\"update\")");
    expect(walletRoute).toContain("availableBalanceCents: sql`${walletsTable.availableBalanceCents} - ${amountCents}`");
    expect(walletRoute).toContain("withdrawableBalanceCents: sql`${walletsTable.withdrawableBalanceCents} - ${amountCents}`");
    expect(walletRoute).toContain("idempotencyKey: `withdrawal_requested:${wd.id}`");
    expect(withdrawalSchema).toContain("idempotencyKey: text(\"idempotency_key\")");
    expect(withdrawalSchema).toContain("withdrawals_idempotency_key_unique_idx");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS \"idempotency_key\" text");
    expect(migration).toContain("withdrawals_idempotency_key_unique_idx");
    expect(migration).toContain("'withdrawal_requested') AND \"amount_cents\" < 0");
  });

  it("rejects withdrawals atomically with a balancing ledger credit", () => {
    const adminRoute = readFileSync("src/routes/admin.ts", "utf8");
    const migration = readFileSync("db/migrations/0009_wallet_payment_hardening.sql", "utf8");

    expect(adminRoute).toContain("await db.transaction(async (tx) =>");
    expect(adminRoute).toContain("transactionType: \"withdrawal_rejected\"");
    expect(adminRoute).toContain("idempotencyKey: `withdrawal_rejected:${withdrawalId}`");
    expect(adminRoute).toContain("status: \"cancelled\"");
    expect(adminRoute).toContain("availableBalanceCents: afterAvailable");
    expect(adminRoute).toContain("withdrawableBalanceCents: afterWithdrawable");
    expect(migration).toContain("'withdrawal_rejected') AND \"amount_cents\" > 0");
  });

  it("requires explicit production readiness gates for real-money cash features", () => {
    const config = readFileSync("src/lib/config.ts", "utf8");

    expect(config).toContain("PAYMENTS_LIVE_MODE");
    expect(config).toContain("paymentsLiveMode: parseBoolean(rawEnv.PAYMENTS_LIVE_MODE, true)");
    expect(config).toContain("realMoneyReadiness.paymentsLiveMode && !realMoneyReadiness.productionApproved");
    expect(config).toContain("REAL_MONEY_PRODUCTION_APPROVED");
    expect(config).toContain("REAL_MONEY_LEGAL_APPROVED");
    expect(config).toContain("REAL_MONEY_KYC_TAX_READY");
    expect(config).toContain("REAL_MONEY_PROVIDER_SANDBOX_TESTED");
    expect(config).toContain("REAL_MONEY_WITHDRAWAL_CONTROLS_READY");
    expect(config).toContain("ENABLE_BULLMQ_WEBHOOK_PROCESSING=true is required when cash features are enabled in production");
    expect(config).toContain("RUN_BACKGROUND_JOBS=true is required for worker when cash features are enabled in production");
    expect(config).toContain("STRIPE_WEBHOOK_SECRET is required when cash features are enabled in production");
    expect(config).toContain("RAZORPAY_WEBHOOK_SECRET is required when cash features are enabled in production");
  });
});
