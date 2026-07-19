export type PaymentProvider = "stripe" | "razorpay";

const ALLOWED_ENTRY_AMOUNTS_CENTS = new Set([300, 500, 1000, 1500, 2000, 2500]);
const DEFAULT_PLATFORM_SERVICE_FEE_CENTS = 60;
const PLATFORM_SERVICE_FEE_ENV = "CASH_CHALLENGE_PLATFORM_SERVICE_FEE_CENTS";
const STRIPE_PROCESSING_BASIS_POINTS = 290;
const STRIPE_PROCESSING_FIXED_CENTS = 30;
export const CASH_CHALLENGES_UNSUPPORTED_FOR_CURRENCY = "CASH_CHALLENGES_UNSUPPORTED_FOR_CURRENCY";
export const CASH_CHALLENGES_UNSUPPORTED_FOR_CURRENCY_MESSAGE =
  "Cash challenges are not available for INR/Razorpay wallets yet.";

export function isAllowedEntryAmountCents(amountCents: number): boolean {
  return ALLOWED_ENTRY_AMOUNTS_CENTS.has(amountCents);
}

export function resolvePaymentProvider(countryCode?: string | null): PaymentProvider {
  return countryCode === "IN" ? "razorpay" : "stripe";
}

export function isCashChallengeUnsupportedForCountry(countryCode?: string | null): boolean {
  return countryCode?.trim().toUpperCase() === "IN";
}

export function cashChallengeUnsupportedForCurrencyBody() {
  return {
    success: false,
    code: CASH_CHALLENGES_UNSUPPORTED_FOR_CURRENCY,
    error: CASH_CHALLENGES_UNSUPPORTED_FOR_CURRENCY_MESSAGE,
  };
}

export function calcEntryPoolCents(entryFeeCents: number, numberOfPlayers: number): number {
  return Math.max(0, entryFeeCents) * Math.max(0, numberOfPlayers);
}

function parseConfiguredPlatformServiceFeeCents(): number {
  const raw = process.env[PLATFORM_SERVICE_FEE_ENV]?.trim();
  if (!raw) return DEFAULT_PLATFORM_SERVICE_FEE_CENTS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${PLATFORM_SERVICE_FEE_ENV} must be a non-negative integer number of cents`);
  }
  return value;
}

export function calcPaymentProcessingFeeCents(entryFeeCents: number, provider: PaymentProvider = "stripe"): number {
  const normalizedEntryFeeCents = Math.max(0, entryFeeCents);
  if (normalizedEntryFeeCents === 0) return 0;
  if (provider !== "stripe") return 0;
  return Math.ceil((normalizedEntryFeeCents * STRIPE_PROCESSING_BASIS_POINTS) / 10_000) + STRIPE_PROCESSING_FIXED_CENTS;
}

export function calcPerPlayerFees(entryFeeCents: number, provider: PaymentProvider = "stripe") {
  const normalizedEntryFeeCents = Math.max(0, entryFeeCents);
  const paymentProcessingFeeCents = calcPaymentProcessingFeeCents(normalizedEntryFeeCents, provider);
  const platformServiceFeeCents = normalizedEntryFeeCents > 0
    ? parseConfiguredPlatformServiceFeeCents()
    : 0;
  return {
    entryFeeCents: normalizedEntryFeeCents,
    paymentProcessingFeeCents,
    platformServiceFeeCents,
    totalPayableCents: normalizedEntryFeeCents + paymentProcessingFeeCents + platformServiceFeeCents,
  };
}

export function buildRewardSplitCents(entryFeeCents: number, numberOfPlayers: number) {
  if (entryFeeCents <= 0 || numberOfPlayers < 2) return [];
  const pool = calcEntryPoolCents(entryFeeCents, numberOfPlayers);
  const splits = numberOfPlayers <= 2 ? [1] : numberOfPlayers === 3 ? [0.6, 0.4] : [0.5, 0.3, 0.2];
  const labels = ["1st", "2nd", "3rd"] as const;
  const rows = splits.map((split, index) => ({
    rank: index + 1,
    label: labels[index] ?? `${index + 1}th`,
    percentage: Math.round(split * 100),
    amountCents: Math.floor(pool * split),
  }));
  const distributed = rows.reduce((sum, row) => sum + row.amountCents, 0);
  if (rows.length > 0) rows[0]!.amountCents += pool - distributed;
  return rows;
}

export function buildCashChallengeQuote(input: {
  entryFeeCents: number;
  numberOfPlayers: number;
  paymentProvider?: PaymentProvider;
}) {
  const provider = input.paymentProvider ?? "stripe";
  const fees = calcPerPlayerFees(input.entryFeeCents, provider);
  return {
    paymentProvider: provider,
    numberOfPlayers: input.numberOfPlayers,
    entryFeeCents: fees.entryFeeCents,
    paymentProcessingFeeCents: fees.paymentProcessingFeeCents,
    platformServiceFeeCents: fees.platformServiceFeeCents,
    totalPayableCents: fees.totalPayableCents,
    prizePoolCents: calcEntryPoolCents(input.entryFeeCents, input.numberOfPlayers),
    rewardSplit: buildRewardSplitCents(input.entryFeeCents, input.numberOfPlayers),
  };
}

export function formatQuoteForApi(quote: ReturnType<typeof buildCashChallengeQuote>, walletBalanceCents = 0) {
  return {
    paymentProvider: quote.paymentProvider,
    numberOfPlayers: quote.numberOfPlayers,
    entryFee: quote.entryFeeCents / 100,
    entryFeeCents: quote.entryFeeCents,
    entryPool: quote.prizePoolCents / 100,
    entryPoolCents: quote.prizePoolCents,
    paymentProcessingFee: quote.paymentProcessingFeeCents / 100,
    paymentProcessingFeeCents: quote.paymentProcessingFeeCents,
    platformServiceFee: quote.platformServiceFeeCents / 100,
    platformServiceFeeCents: quote.platformServiceFeeCents,
    totalPayable: quote.totalPayableCents / 100,
    totalPayableCents: quote.totalPayableCents,
    prizePool: quote.prizePoolCents / 100,
    prizePoolCents: quote.prizePoolCents,
    rewardSplit: quote.rewardSplit.map((row) => ({
      ...row,
      amount: row.amountCents / 100,
      currency: "USD",
    })),
    walletBalance: walletBalanceCents / 100,
    walletBalanceCents,
    canAfford: walletBalanceCents >= quote.totalPayableCents,
    walletRefundAmount: quote.entryFeeCents / 100,
    walletRefundAmountCents: quote.entryFeeCents,
    refundDestination: "wallet" as const,
    currency: "usd" as const,
  };
}
