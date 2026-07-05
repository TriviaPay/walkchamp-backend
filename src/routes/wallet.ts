import { Router } from "express";
import { db } from "../../db/src/index.js";
import {
  walletsTable,
  walletTransactionsTable,
  withdrawalsTable,
  profilesTable,
} from "../../db/src/schema/index.js";
import { eq, desc, sql, lt, and } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import { z } from "zod";
import { requireCashFeaturesEnabled } from "../middleware/requireCashFeaturesEnabled.js";

const router = Router();

router.use("/wallet", requireCashFeaturesEnabled);

// ── Helpers ───────────────────────────────────────────────────────────────────

const MIN_WITHDRAWAL_CENTS = 500; // $5.00

// Get or create a wallet for the user, returns the wallet row.
async function getOrCreateWallet(userId: string) {
  const [existing] = await db
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.userId, userId))
    .limit(1);
  if (existing) return existing;

  // Auto-create wallet for legacy users who don't have one yet
  const [created] = await db
    .insert(walletsTable)
    .values({ userId })
    .returning();
  return created;
}

// Convert wallet cents to dollars for API responses
function walletToDollars(wallet: typeof walletsTable.$inferSelect) {
  return {
    id: wallet.id,
    availableBalance: wallet.availableBalanceCents / 100,
    pendingBalance: wallet.pendingBalanceCents / 100,
    withdrawableBalance: wallet.withdrawableBalanceCents / 100,
    totalEarned: wallet.totalEarnedCents / 100,
    currency: wallet.currency,
    updatedAt: wallet.updatedAt,
  };
}

// Map DB transaction type to frontend type
function mapTxType(type: string): "reward" | "withdrawal" | "bonus" | "referral" | "race_entry" | "prize" | "refund" {
  if (type.includes("prize") || type.includes("reward") || type === "sponsored_reward") return "reward";
  if (type.includes("withdrawal")) return "withdrawal";
  if (type === "referral_credit") return "referral";
  if (type === "race_entry_refund") return "refund";
  if (type === "race_entry_payment" || type === "race_entry_wallet_debit") return "race_entry";
  if (type === "promo_discount") return "bonus";
  return "bonus";
}

// ── GET /api/wallet ───────────────────────────────────────────────────────────
router.get("/wallet", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const wallet = await getOrCreateWallet(userId);
  return res.json({ wallet: walletToDollars(wallet) });
});

// ── GET /api/wallet/summary ───────────────────────────────────────────────────
router.get("/wallet/summary", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const [wallet, profileRow] = await Promise.all([
    getOrCreateWallet(userId),
    db.select({ countryCode: profilesTable.countryCode })
      .from(profilesTable)
      .where(eq(profilesTable.id, userId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);

  const w = walletToDollars(wallet);
  const userCountryCode = profileRow?.countryCode ?? null;
  const isIndia = userCountryCode === "IN";
  const walletCurrency = isIndia ? "INR" : "USD";
  const availablePaymentProvider: string | null = userCountryCode
    ? isIndia ? "razorpay" : "stripe"
    : null;

  req.log.info(
    { userId, userCountryCode, walletCurrency, availablePaymentProvider },
    "[WalletCurrency] wallet summary",
  );

  return res.json({
    success: true,
    balance: w.availableBalance,
    pendingBalance: w.pendingBalance,
    withdrawableBalance: w.withdrawableBalance,
    totalEarned: w.totalEarned,
    currency: w.currency,
    walletCurrency,
    availablePaymentProvider,
    userCountryCode,
    updatedAt: w.updatedAt,
  });
});

// ── GET /api/wallet/transactions ─────────────────────────────────────────────
// Supports cursor pagination via ?before=<ISO-timestamp> (exclusive upper bound).
// Falls back to offset pagination when before is absent, for backwards compatibility.
router.get("/wallet/transactions", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = req.query.before as string | undefined;
  const beforeDate = before ? new Date(before) : null;
  const offset = beforeDate ? 0 : (Number(req.query.offset) || 0);

  const wallet = await getOrCreateWallet(userId);

  const txs = await db
    .select()
    .from(walletTransactionsTable)
    .where(
      beforeDate
        ? and(eq(walletTransactionsTable.walletId, wallet.id), lt(walletTransactionsTable.createdAt, beforeDate))
        : eq(walletTransactionsTable.walletId, wallet.id),
    )
    .orderBy(desc(walletTransactionsTable.createdAt))
    .limit(limit)
    .offset(offset);

  const nextCursor =
    txs.length === limit && txs.length > 0
      ? txs[txs.length - 1].createdAt.toISOString()
      : null;

  const formatted = txs.map((tx) => ({
    id: tx.id,
    type: mapTxType(tx.transactionType),
    amount: tx.amountCents / 100,
    description: tx.description,
    status: tx.status,
    date: tx.createdAt.toISOString(),
    raceRoomId: tx.raceRoomId,
    challengeId: tx.challengeId,
  }));

  return res.json({ transactions: formatted, total: txs.length, nextCursor });
});

// ── GET /api/wallet/withdrawals ───────────────────────────────────────────────
router.get("/wallet/withdrawals", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const withdrawals = await db
    .select({
      id: withdrawalsTable.id,
      amountCents: withdrawalsTable.amountCents,
      currency: withdrawalsTable.currency,
      payoutMethod: withdrawalsTable.payoutMethod,
      status: withdrawalsTable.status,
      requestedAt: withdrawalsTable.requestedAt,
      approvedAt: withdrawalsTable.approvedAt,
      paidAt: withdrawalsTable.paidAt,
      rejectedAt: withdrawalsTable.rejectedAt,
    })
    .from(withdrawalsTable)
    .where(eq(withdrawalsTable.userId, userId))
    .orderBy(desc(withdrawalsTable.requestedAt))
    .limit(50);

  return res.json({
    withdrawals: withdrawals.map((w) => ({
      ...w,
      amount: w.amountCents / 100,
    })),
  });
});

// ── POST /api/wallet/withdraw ─────────────────────────────────────────────────
const withdrawSchema = z.object({
  amount: z.number().positive().finite(),
  payoutMethod: z.enum(["paypal", "bank_transfer", "upi", "gift_card"]),
  payoutDetails: z.record(z.string()),
});

router.post("/wallet/withdraw", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = withdrawSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
  }

  const { amount, payoutMethod, payoutDetails } = parsed.data;
  const amountCents = Math.round(amount * 100);

  if (amountCents < MIN_WITHDRAWAL_CENTS) {
    return res.status(400).json({ error: `Minimum withdrawal is $${MIN_WITHDRAWAL_CENTS / 100}.00` });
  }

  // Validate user eligibility
  const [profile] = await db
    .select()
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);

  if (!profile) return res.status(404).json({ error: "Profile not found" });

  const status = profile.accountStatus;
  if (status === "suspended" || status === "banned" || status === "deleted") {
    return res.status(403).json({ error: "Account is not eligible for withdrawals." });
  }
  if (!profile.isAdult) {
    return res.status(403).json({ error: "You must be 18 or older to withdraw." });
  }
  if (!profile.withdrawalsEnabled) {
    return res.status(403).json({ error: "Withdrawals are not enabled for your account yet." });
  }
  if ((profile.fraudScore ?? 0) >= 70) {
    return res.status(403).json({ error: "Your account is under review and cannot withdraw at this time." });
  }

  const wallet = await getOrCreateWallet(userId);

  if (amountCents > wallet.withdrawableBalanceCents) {
    return res.status(400).json({
      error: `Insufficient withdrawable balance. Available: $${(wallet.withdrawableBalanceCents / 100).toFixed(2)}`,
    });
  }

  // Create withdrawal + deduct from withdrawable balance atomically
  const [withdrawal] = await db.transaction(async (tx) => {
    const [wd] = await tx
      .insert(withdrawalsTable)
      .values({
        userId,
        amountCents,
        currency: wallet.currency,
        payoutMethod,
        payoutDetails,
      })
      .returning();

    // Deduct from withdrawable balance
    await tx
      .update(walletsTable)
      .set({
        withdrawableBalanceCents: sql`${walletsTable.withdrawableBalanceCents} - ${amountCents}`,
        updatedAt: new Date(),
      })
      .where(eq(walletsTable.id, wallet.id));

    // Record ledger entry
    await tx.insert(walletTransactionsTable).values({
      walletId: wallet.id,
      userId,
      transactionType: "withdrawal_requested",
      amountCents: -amountCents,
      currency: wallet.currency,
      status: "pending",
      description: `Withdrawal via ${payoutMethod.replace("_", " ")} — pending admin review`,
      withdrawalId: wd.id,
    });

    return [wd];
  });

  req.log.info({ withdrawalId: withdrawal.id, amountCents, payoutMethod }, "withdrawal requested");

  return res.status(201).json({
    withdrawal: {
      id: withdrawal.id,
      amount: withdrawal.amountCents / 100,
      payoutMethod: withdrawal.payoutMethod,
      status: withdrawal.status,
      requestedAt: withdrawal.requestedAt,
    },
    message: "Withdrawal request submitted. Processing takes 1–3 business days.",
  });
});

export default router;
