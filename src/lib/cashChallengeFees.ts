export type PaymentProvider = "stripe" | "razorpay";

const ALLOWED_ENTRY_AMOUNTS_CENTS = new Set([300, 500, 1000, 1500, 2000, 2500]);
const DEFAULT_PLATFORM_SERVICE_FEE_CENTS = 60;
const PLATFORM_SERVICE_FEE_ENV = "CASH_CHALLENGE_PLATFORM_SERVICE_FEE_CENTS";
const STRIPE_PROCESSING_BASIS_POINTS = 290;
const STRIPE_PROCESSING_FIXED_CENTS = 30;
/**
 * Razorpay domestic card pricing is a flat percentage with no fixed component
 * (contrast Stripe's 2.9% + 30c). 2% is Razorpay's standard domestic rate; override
 * per-deployment once real commercials are agreed.
 */
const RAZORPAY_PROCESSING_BASIS_POINTS = 200;
const RAZORPAY_PROCESSING_BASIS_POINTS_ENV = "CASH_CHALLENGE_RAZORPAY_PROCESSING_BASIS_POINTS";
const INR_CASH_CHALLENGES_ENV = "ENABLE_INR_CASH_CHALLENGES";
export const CASH_CHALLENGES_UNSUPPORTED_FOR_CURRENCY = "CASH_CHALLENGES_UNSUPPORTED_FOR_CURRENCY";
export const CASH_CHALLENGES_UNSUPPORTED_FOR_CURRENCY_MESSAGE =
  "Cash challenges are not available for INR/Razorpay wallets yet.";

export function isAllowedEntryAmountCents(amountCents: number): boolean {
  return ALLOWED_ENTRY_AMOUNTS_CENTS.has(amountCents);
}

function normalizeCountryCode(countryCode?: string | null): string | null {
  const normalized = countryCode?.trim().toUpperCase();
  return normalized ? normalized : null;
}

/**
 * Rollout gate for INR/Razorpay cash challenges. Read at call time (not module load) so
 * deployments and tests can flip it without a restart, matching how the platform service
 * fee env is handled below.
 *
 * Default OFF: production keeps the existing India block until the Razorpay cash path has
 * been exercised end to end. Enable in staging/test to run the flow with Razorpay test keys.
 */
export function inrCashChallengesEnabled(): boolean {
  return process.env[INR_CASH_CHALLENGES_ENV]?.trim() === "true";
}

export function resolvePaymentProvider(countryCode?: string | null): PaymentProvider {
  return normalizeCountryCode(countryCode) === "IN" ? "razorpay" : "stripe";
}

/**
 * Country-level availability gate for cash challenges.
 *
 * This is deliberately the ONLY place the India rule lives — every route and service gate
 * calls through here, so flipping the flag opens host / join / quote / unlimited together
 * rather than leaving one path behind.
 *
 * Note this is separate from the *currency* guard in debitWalletForCashChallenge, which
 * refuses any non-USD wallet regardless of this flag. Cash amounts are USD-denominated
 * (see formatQuoteForApi), so that guard is what keeps the ledger consistent; unblocking a
 * country never bypasses it.
 */
export function isCashChallengeUnsupportedForCountry(countryCode?: string | null): boolean {
  if (normalizeCountryCode(countryCode) !== "IN") return false;
  return !inrCashChallengesEnabled();
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

function parseConfiguredRazorpayBasisPoints(): number {
  const raw = process.env[RAZORPAY_PROCESSING_BASIS_POINTS_ENV]?.trim();
  if (!raw) return RAZORPAY_PROCESSING_BASIS_POINTS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${RAZORPAY_PROCESSING_BASIS_POINTS_ENV} must be a non-negative integer number of basis points`);
  }
  return value;
}

export function calcPaymentProcessingFeeCents(entryFeeCents: number, provider: PaymentProvider = "stripe"): number {
  const normalizedEntryFeeCents = Math.max(0, entryFeeCents);
  if (normalizedEntryFeeCents === 0) return 0;
  if (provider === "razorpay") {
    // Percentage only — no fixed component, unlike Stripe.
    return Math.ceil((normalizedEntryFeeCents * parseConfiguredRazorpayBasisPoints()) / 10_000);
  }
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
