import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildCashChallengeQuote,
  calcPaymentProcessingFeeCents,
  calcPerPlayerFees,
  formatQuoteForApi,
  inrCashChallengesEnabled,
  isCashChallengeUnsupportedForCountry,
  resolvePaymentProvider,
} from "../lib/cashChallengeFees.js";

const INR_FLAG = "ENABLE_INR_CASH_CHALLENGES";
const RAZORPAY_BPS = "CASH_CHALLENGE_RAZORPAY_PROCESSING_BASIS_POINTS";

afterEach(() => {
  delete process.env[INR_FLAG];
  delete process.env[RAZORPAY_BPS];
});

describe("INR cash-challenge rollout gate", () => {
  it("blocks India by default, so production behaviour is unchanged", () => {
    expect(inrCashChallengesEnabled()).toBe(false);
    expect(isCashChallengeUnsupportedForCountry("IN")).toBe(true);
    expect(isCashChallengeUnsupportedForCountry("in")).toBe(true);
    expect(isCashChallengeUnsupportedForCountry(" IN ")).toBe(true);
  });

  it("unblocks India when the flag is on", () => {
    process.env[INR_FLAG] = "true";

    expect(inrCashChallengesEnabled()).toBe(true);
    expect(isCashChallengeUnsupportedForCountry("IN")).toBe(false);
    expect(isCashChallengeUnsupportedForCountry("in")).toBe(false);
  });

  it("only 'true' enables it — no truthy-string surprises", () => {
    for (const value of ["false", "1", "yes", "TRUE", ""]) {
      process.env[INR_FLAG] = value;
      expect(inrCashChallengesEnabled()).toBe(false);
      expect(isCashChallengeUnsupportedForCountry("IN")).toBe(true);
    }
  });

  it("never blocks non-India regardless of the flag", () => {
    for (const flag of [undefined, "true", "false"]) {
      if (flag === undefined) delete process.env[INR_FLAG];
      else process.env[INR_FLAG] = flag;
      expect(isCashChallengeUnsupportedForCountry("US")).toBe(false);
      expect(isCashChallengeUnsupportedForCountry(null)).toBe(false);
      expect(isCashChallengeUnsupportedForCountry(undefined)).toBe(false);
    }
  });

  it("routes India to razorpay and everyone else to stripe, flag-independently", () => {
    // The provider is a function of country, not of the rollout gate.
    expect(resolvePaymentProvider("IN")).toBe("razorpay");
    expect(resolvePaymentProvider(" in ")).toBe("razorpay");
    expect(resolvePaymentProvider("US")).toBe("stripe");
    expect(resolvePaymentProvider(null)).toBe("stripe");

    process.env[INR_FLAG] = "true";
    expect(resolvePaymentProvider("IN")).toBe("razorpay");
    expect(resolvePaymentProvider("US")).toBe("stripe");
  });
});

describe("razorpay quote fees", () => {
  it("charges a percentage with no fixed component", () => {
    // 2% of $3.00 = 6c. Stripe would be 2.9% + 30c = 39c.
    expect(calcPaymentProcessingFeeCents(300, "razorpay")).toBe(6);
    expect(calcPaymentProcessingFeeCents(2500, "razorpay")).toBe(50);
    expect(calcPaymentProcessingFeeCents(0, "razorpay")).toBe(0);
  });

  it("leaves the stripe fee untouched", () => {
    expect(calcPaymentProcessingFeeCents(300, "stripe")).toBe(39);
    expect(calcPaymentProcessingFeeCents(500, "stripe")).toBe(45);
  });

  it("allows the razorpay rate to be tuned with env", () => {
    process.env[RAZORPAY_BPS] = "300";
    expect(calcPaymentProcessingFeeCents(1000, "razorpay")).toBe(30);
  });

  it("rejects a malformed razorpay rate rather than silently using a default", () => {
    process.env[RAZORPAY_BPS] = "-5";
    expect(() => calcPaymentProcessingFeeCents(1000, "razorpay")).toThrow(/basis points/);
  });

  it("produces a fully populated quote for an India user", () => {
    // The reported symptom was tax / platform fee / total rendering blank because the
    // quote 403'd. With the flag on, every field the client reads must be present.
    const quote = formatQuoteForApi(
      buildCashChallengeQuote({ entryFeeCents: 300, numberOfPlayers: 10, paymentProvider: "razorpay" }),
      2_000,
    );

    expect(quote.paymentProvider).toBe("razorpay");
    expect(quote.entryFeeCents).toBe(300);
    expect(quote.paymentProcessingFeeCents).toBe(6);
    expect(quote.platformServiceFeeCents).toBe(60);
    expect(quote.totalPayableCents).toBe(366);
    expect(quote.totalPayable).toBe(3.66);
    expect(quote.prizePoolCents).toBe(3_000);
    expect(quote.rewardSplit.length).toBeGreaterThan(0);
    expect(quote.canAfford).toBe(true);
    // Option A keeps the ledger USD-denominated, so the response shape is unchanged
    // and the existing client needs no edit.
    expect(quote.currency).toBe("usd");
  });

  it("keeps per-player fee totals consistent for razorpay", () => {
    const fees = calcPerPlayerFees(1500, "razorpay");
    expect(fees).toEqual({
      entryFeeCents: 1500,
      paymentProcessingFeeCents: 30,
      platformServiceFeeCents: 60,
      totalPayableCents: 1590,
    });
  });
});

describe("the gate is enforced in exactly one place", () => {
  const races = readFileSync("src/routes/races.ts", "utf8");
  const unlimited = readFileSync("src/lib/unlimitedChallengeService.ts", "utf8");
  const refunds = readFileSync("src/lib/refundService.ts", "utf8");

  it("every cash country gate calls the shared predicate", () => {
    // Flipping the flag must open quote, host, start-debit, paid join and unlimited
    // together. A site that compared countryCode to "IN" itself would be left behind.
    expect(races.match(/isCashChallengeUnsupportedForCountry\(/g)?.length).toBeGreaterThanOrEqual(5);
    expect(unlimited).toContain("isCashChallengeUnsupportedForCountry(");

    const routeBody = races.slice(races.indexOf("const router = Router()"));
    expect(/countryCode\s*===\s*"IN"/.test(routeBody)).toBe(false);
    expect(/countryCode\s*===\s*"IN"/.test(unlimited)).toBe(false);
  });

  it("the wallet-currency guard is independent of the country gate", () => {
    // This is what keeps the USD ledger safe once a country is unblocked: a non-USD
    // wallet is refused at debit time no matter what the rollout flag says.
    const debit = refunds.slice(refunds.indexOf("export async function debitWalletForCashChallenge"));
    expect(debit).toContain('wallet.currency.toLowerCase() !== "usd"');
    expect(debit).not.toContain("isCashChallengeUnsupportedForCountry");
  });
});
