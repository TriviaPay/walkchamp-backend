import { afterEach, describe, expect, it } from "vitest";
import { buildCashChallengeQuote, calcPerPlayerFees, formatQuoteForApi } from "../lib/cashChallengeFees.js";

const PLATFORM_FEE_ENV = "CASH_CHALLENGE_PLATFORM_SERVICE_FEE_CENTS";

afterEach(() => {
  delete process.env[PLATFORM_FEE_ENV];
});

describe("cash challenge fees", () => {
  it("calculates processing and platform fees from the entry fee", () => {
    const fees = calcPerPlayerFees(300, "stripe");

    expect(fees).toEqual({
      entryFeeCents: 300,
      paymentProcessingFeeCents: 39,
      platformServiceFeeCents: 60,
      totalPayableCents: 399,
    });
  });

  it("allows the platform service fee to be changed with env", () => {
    process.env[PLATFORM_FEE_ENV] = "75";

    const fees = calcPerPlayerFees(500, "stripe");

    expect(fees.paymentProcessingFeeCents).toBe(45);
    expect(fees.platformServiceFeeCents).toBe(75);
    expect(fees.totalPayableCents).toBe(620);
  });

  it("returns API quote fields in dollars and cents", () => {
    const quote = formatQuoteForApi(buildCashChallengeQuote({
      entryFeeCents: 300,
      numberOfPlayers: 10,
      paymentProvider: "stripe",
    }), 1_000);

    expect(quote.paymentProcessingFee).toBe(0.39);
    expect(quote.paymentProcessingFeeCents).toBe(39);
    expect(quote.platformServiceFee).toBe(0.6);
    expect(quote.platformServiceFeeCents).toBe(60);
    expect(quote.totalPayable).toBe(3.99);
    expect(quote.totalPayableCents).toBe(399);
    expect(quote.walletRefundAmountCents).toBe(300);
  });

  it("rejects invalid platform fee env values", () => {
    process.env[PLATFORM_FEE_ENV] = "0.60";

    expect(() => calcPerPlayerFees(300, "stripe")).toThrow(
      "CASH_CHALLENGE_PLATFORM_SERVICE_FEE_CENTS must be a non-negative integer number of cents",
    );
  });
});
