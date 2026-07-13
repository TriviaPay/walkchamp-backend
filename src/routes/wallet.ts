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
import { assertOperationalLockOpen, WALLET_LEDGER_ANOMALY_LOCK } from "../lib/operationalLocks.js";

const router = Router();

router.use("/wallet", requireCashFeaturesEnabled);

// ── Helpers ───────────────────────────────────────────────────────────────────

const MIN_WITHDRAWAL_CENTS = 500; // $5.00
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,120}$/;

class WithdrawalRequestError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function getWithdrawalIdempotencyKey(
  req: AuthenticatedRequest,
  bodyKey?: string,
): { key: string | null; error: string | null } {
  const header = req.headers["idempotency-key"];
  const headerKey = Array.isArray(header) ? header[0] : header;
  const raw = (headerKey ?? bodyKey ?? "").trim();
  if (!raw) return { key: null, error: "Withdrawal requests require an Idempotency-Key header." };
  if (!IDEMPOTENCY_KEY_RE.test(raw)) {
    return { key: null, error: "Idempotency key must be 8-120 characters using letters, numbers, '.', '_', ':', or '-'." };
  }
  return { key: raw, error: null };
}

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
    availableBalanceMinor: wallet.availableBalanceCents,
    pendingBalance: wallet.pendingBalanceCents / 100,
    heldBalanceMinor: wallet.pendingBalanceCents,
    withdrawableBalance: wallet.withdrawableBalanceCents / 100,
    totalEarned: wallet.totalEarnedCents / 100,
    totalBalanceMinor: wallet.availableBalanceCents + wallet.pendingBalanceCents,
    totalEarnedMinor: wallet.totalEarnedCents,
    currency: wallet.currency,
    updatedAt: wallet.updatedAt,
  };
}

// Map DB transaction type to frontend type
function mapTxType(type: string): "reward" | "withdrawal" | "bonus" | "referral" | "race_entry" | "prize" | "refund" {
  if (type.includes("prize") || type.includes("reward") || type === "sponsored_reward") return "reward";
  if (type.includes("withdrawal")) return "withdrawal";
  if (type === "deposit_credit") return "bonus";
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
    availableBalanceMinor: w.availableBalanceMinor,
    pendingBalance: w.pendingBalance,
    heldBalanceMinor: w.heldBalanceMinor,
    withdrawableBalance: w.withdrawableBalance,
    totalEarned: w.totalEarned,
    totalBalanceMinor: w.totalBalanceMinor,
    totalEarnedMinor: w.totalEarnedMinor,
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
  idempotencyKey: z.string().optional(),
});

router.post("/wallet/withdraw", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = withdrawSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
  }

  try {
    await assertOperationalLockOpen(
      WALLET_LEDGER_ANOMALY_LOCK,
      "Withdrawals are temporarily paused while wallet ledger reconciliation is under review.",
    );
  } catch (err) {
    if (err instanceof Error && err.name === "OPERATIONAL_LOCK_ACTIVE") {
      return res.status(503).json({
        error: err.message,
        code: "WITHDRAWALS_PAUSED_LEDGER_REVIEW",
      });
    }
    throw err;
  }

  const { amount, payoutMethod, payoutDetails } = parsed.data;
  const amountCents = Math.round(amount * 100);
  const idempotency = getWithdrawalIdempotencyKey(req as AuthenticatedRequest, parsed.data.idempotencyKey);
  if (!idempotency.key) {
    return res.status(400).json({
      error: idempotency.error,
      code: "IDEMPOTENCY_KEY_REQUIRED",
    });
  }
  const withdrawalIdempotencyKey = `withdrawal:${userId}:${idempotency.key}`;

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

  let reused = false;
  let withdrawal: typeof withdrawalsTable.$inferSelect;
  try {
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(withdrawalsTable)
        .where(eq(withdrawalsTable.idempotencyKey, withdrawalIdempotencyKey))
        .limit(1);

      if (existing) {
        if (existing.userId !== userId || existing.amountCents !== amountCents || existing.payoutMethod !== payoutMethod) {
          throw new WithdrawalRequestError(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used for a different withdrawal request.");
        }
        return { withdrawal: existing, reused: true };
      }

      let [wallet] = await tx
        .select()
        .from(walletsTable)
        .where(eq(walletsTable.userId, userId))
        .limit(1)
        .for("update");

      if (!wallet) {
        [wallet] = await tx
          .insert(walletsTable)
          .values({ userId })
          .returning();
      }

      if (amountCents > wallet.withdrawableBalanceCents || amountCents > wallet.availableBalanceCents) {
        throw new WithdrawalRequestError(
          400,
          "INSUFFICIENT_WITHDRAWABLE_BALANCE",
          `Insufficient withdrawable balance. Available: $${(wallet.withdrawableBalanceCents / 100).toFixed(2)}`,
        );
      }

      const [wd] = await tx
        .insert(withdrawalsTable)
        .values({
          userId,
          amountCents,
          currency: wallet.currency,
          payoutMethod,
          payoutDetails,
          idempotencyKey: withdrawalIdempotencyKey,
        })
        .onConflictDoNothing()
        .returning();

      if (!wd) {
        const [conflicting] = await tx
          .select()
          .from(withdrawalsTable)
          .where(eq(withdrawalsTable.idempotencyKey, withdrawalIdempotencyKey))
          .limit(1);
        if (!conflicting) {
          throw new WithdrawalRequestError(409, "WITHDRAWAL_IDEMPOTENCY_CONFLICT", "Withdrawal idempotency conflict.");
        }
        return { withdrawal: conflicting, reused: true };
      }

      const beforeAvailable = wallet.availableBalanceCents;
      const afterAvailable = beforeAvailable - amountCents;
      const beforeWithdrawable = wallet.withdrawableBalanceCents;
      const afterWithdrawable = beforeWithdrawable - amountCents;

      const updatedWallet = await tx
        .update(walletsTable)
        .set({
          availableBalanceCents: sql`${walletsTable.availableBalanceCents} - ${amountCents}`,
          withdrawableBalanceCents: sql`${walletsTable.withdrawableBalanceCents} - ${amountCents}`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(walletsTable.id, wallet.id),
          sql`${walletsTable.availableBalanceCents} >= ${amountCents}`,
          sql`${walletsTable.withdrawableBalanceCents} >= ${amountCents}`,
        ))
        .returning({ id: walletsTable.id });

      if (updatedWallet.length === 0) {
        throw new WithdrawalRequestError(
          400,
          "INSUFFICIENT_WITHDRAWABLE_BALANCE",
          "Insufficient withdrawable balance.",
        );
      }

      await tx.insert(walletTransactionsTable).values({
        walletId: wallet.id,
        userId,
        transactionType: "withdrawal_requested",
        amountCents: -amountCents,
        currency: wallet.currency,
        status: "pending",
        description: `Withdrawal via ${payoutMethod.replace("_", " ")} - pending admin review`,
        withdrawalId: wd.id,
        idempotencyKey: `withdrawal_requested:${wd.id}`,
        balanceBeforeCents: beforeAvailable,
        balanceAfterCents: afterAvailable,
        metadata: {
          withdrawalIdempotencyKey,
          withdrawableBeforeCents: beforeWithdrawable,
          withdrawableAfterCents: afterWithdrawable,
        },
      });

      return { withdrawal: wd, reused: false };
    });
    withdrawal = result.withdrawal;
    reused = result.reused;
  } catch (err) {
    if (err instanceof WithdrawalRequestError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  req.log.info({ withdrawalId: withdrawal.id, amountCents, payoutMethod, reused }, "withdrawal requested");

  return res.status(reused ? 200 : 201).json({
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
