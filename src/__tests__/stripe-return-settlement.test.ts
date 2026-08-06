import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Stripe deposits were credited ONLY by the webhook: /stripe/return validated the session and
// redirected without ever settling. Razorpay's /verify settles inline via settleRazorpayPayment,
// so with no webhook registered Razorpay credited wallets and Stripe silently never did. These
// guard the parity — and the idempotency that makes settling in both places safe.

const deposit = readFileSync("src/routes/deposit.ts", "utf8");
const settlement = readFileSync("src/lib/depositSettlement.ts", "utf8");

const stripeReturnStart = deposit.indexOf('router.get("/wallet/deposit/stripe/return"');
// End at the next route declaration, not at "RAZORPAY" — that substring first appears in
// MIN_RAZORPAY_PAISE near the top of the file, which would slice to an empty string and make
// every assertion below silently vacuous.
const stripeReturn = deposit.slice(
  stripeReturnStart,
  deposit.indexOf("router.", deposit.indexOf("appDoneUrl(displayStatus, transaction_id)")),
);

describe("stripe return settles, like razorpay verify", () => {
  it("actually isolated the return handler (guards against a vacuous slice)", () => {
    expect(stripeReturnStart).toBeGreaterThan(-1);
    expect(stripeReturn.length).toBeGreaterThan(200);
    expect(stripeReturn).toContain("stripe/return");
  });

  it("calls settleStripeCheckoutSession on the return path", () => {
    expect(stripeReturn).toContain("settleStripeCheckoutSession(session.id, depositTx.id)");
  });

  it("only settles once Stripe itself reports the session paid", () => {
    expect(stripeReturn).toContain('session.payment_status === "paid"');
  });

  it("settles after the binding check, never before", () => {
    const bindingAt = stripeReturn.indexOf("bindingValid");
    const settleAt = stripeReturn.indexOf("settleStripeCheckoutSession");
    expect(bindingAt).toBeGreaterThan(-1);
    expect(settleAt).toBeGreaterThan(bindingAt);
  });

  it("never fails the user's return page on a settlement error", () => {
    // The webhook and the reconciliation tick both retry; a settle error must not
    // strand the user on an error page for a payment that actually succeeded.
    const settleBlock = stripeReturn.slice(stripeReturn.indexOf("settleStripeCheckoutSession"));
    expect(settleBlock).toContain("catch (settleErr)");
    expect(settleBlock).toContain("webhook/reconciler will retry");
  });
});

describe("settling in two places cannot double-credit", () => {
  it("settleStripeCheckoutSession re-fetches provider state rather than trusting the caller", () => {
    const fn = settlement.slice(
      settlement.indexOf("export async function settleStripeCheckoutSession"),
      settlement.indexOf("type RazorpayPaymentEntity"),
    );
    expect(fn).toContain("checkout.sessions.retrieve(sessionId)");
    expect(fn).toContain("settleDepositOnce(");
  });

  it("the credit is guarded by a row lock and an idempotent ledger key", () => {
    const once = settlement.slice(
      settlement.indexOf("export async function settleDepositOnce"),
      settlement.indexOf("export async function recordDepositProviderReversal"),
    );
    expect(once).toContain("lockDepositTransactionById");
    expect(once).toContain('lockedDeposit.status === "succeeded"');
    expect(once).toContain("idempotencyKey = `deposit_credit:${lockedDeposit.id}`");
    expect(once).toContain("onConflictDoNothing()");
    // Amount / currency / binding are re-verified against provider state before any credit.
    expect(once).toContain("amount_mismatch");
    expect(once).toContain("currency_mismatch");
  });
});

describe("a missing Stripe key names the setting", () => {
  it("returns a 503 an operator can act on", () => {
    expect(deposit).toContain("STRIPE_NOT_CONFIGURED");
    expect(deposit).toContain("Set STRIPE_SECRET_KEY");
    // The old body gave no indication of which provider or which variable.
    const createIntent = deposit.slice(
      deposit.indexOf('router.post("/wallet/deposit/stripe/create-payment-intent"'),
      deposit.indexOf('router.get("/wallet/deposit/stripe/return"'),
    );
    expect(createIntent).not.toContain('error: "Payment provider not configured."');
  });
});

describe("the IN → Razorpay split is untouched", () => {
  it("still blocks India from the Stripe deposit path", () => {
    const createIntent = deposit.slice(
      deposit.indexOf('router.post("/wallet/deposit/stripe/create-payment-intent"'),
      deposit.indexOf('router.get("/wallet/deposit/stripe/return"'),
    );
    expect(createIntent).toContain('userCountryCode === "IN"');
    expect(createIntent).toContain("403");
  });

  it("still creates USD wallets for the Stripe path", () => {
    expect(deposit).toContain('getOrCreateWalletForCurrency(userId, "usd")');
    expect(deposit).toContain('getOrCreateWalletForCurrency(userId, "inr")');
  });
});
