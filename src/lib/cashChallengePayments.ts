import { and, eq, sql } from "drizzle-orm";
import { walletsTable, walletTransactionsTable } from "../../db/src/schema/index.js";
import { calcPerPlayerFees, type PaymentProvider } from "./cashChallengeFees.js";
import { debitWalletForCashChallenge } from "./refundService.js";
import { lockWalletByUserId, type DbTx } from "./raceIntegrity.js";

function normalizePaymentProvider(provider?: string): PaymentProvider {
  return provider === "razorpay" ? "razorpay" : "stripe";
}

export async function debitCashChallengeEntry(
  tx: DbTx,
  input: {
    userId: string;
    raceRoomId: string;
    entryFeeCents: number;
    paymentProvider?: string;
    description: string;
  },
) {
  const provider = normalizePaymentProvider(input.paymentProvider);
  const fees = calcPerPlayerFees(input.entryFeeCents, provider);
  return debitWalletForCashChallenge(tx, {
    ...input,
    debitAmountCents: fees.totalPayableCents,
    idempotencyKey: `challenge_entry:${input.raceRoomId}:${input.userId}`,
    metadata: {
      entryFeeCents: fees.entryFeeCents,
      paymentProcessingFeeCents: fees.paymentProcessingFeeCents,
      platformServiceFeeCents: fees.platformServiceFeeCents,
      totalPayableCents: fees.totalPayableCents,
      refundableAmountCents: fees.entryFeeCents,
      paymentProvider: provider,
    },
  });
}

export async function hasCompletedEntryPayment(tx: DbTx, userId: string, raceRoomId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: walletTransactionsTable.id })
    .from(walletTransactionsTable)
    .where(and(
      eq(walletTransactionsTable.userId, userId),
      eq(walletTransactionsTable.raceRoomId, raceRoomId),
      eq(walletTransactionsTable.transactionType, "race_entry_wallet_debit"),
      eq(walletTransactionsTable.status, "completed"),
    ))
    .limit(1);
  return Boolean(row);
}

// Rank-independent check: has this user already been paid a prize for this race?
// Mirrors hasCompletedEntryPayment. Guards against a re-ranking anomaly (e.g. a
// disqualification promotes rank 2 -> rank 1) producing a fresh idempotency key
// and double-crediting the same winner.
export async function hasCompletedPrizePayment(tx: DbTx, userId: string, raceRoomId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: walletTransactionsTable.id })
    .from(walletTransactionsTable)
    .where(and(
      eq(walletTransactionsTable.userId, userId),
      eq(walletTransactionsTable.raceRoomId, raceRoomId),
      eq(walletTransactionsTable.transactionType, "race_prize_paid"),
      eq(walletTransactionsTable.status, "completed"),
    ))
    .limit(1);
  return Boolean(row);
}

export async function creditCashChallengePrizes(
  tx: DbTx,
  input: {
    raceRoomId: string;
    payouts: Array<{ userId: string; rank: number; prizeCents: number }>;
  },
) {
  let credited = 0;

  // Dedupe by userId so a payouts array that lists the same user twice cannot
  // double-credit within a single call (keep the highest prize for that user).
  const byUser = new Map<string, { userId: string; rank: number; prizeCents: number }>();
  for (const p of input.payouts) {
    const existing = byUser.get(p.userId);
    if (!existing || p.prizeCents > existing.prizeCents) byUser.set(p.userId, p);
  }

  for (const payout of byUser.values()) {
    if (payout.prizeCents <= 0) continue;

    // Rank-independent guard: skip anyone already paid a prize for this race.
    if (await hasCompletedPrizePayment(tx, payout.userId, input.raceRoomId)) continue;

    let wallet = await lockWalletByUserId(tx, payout.userId);
    if (!wallet) {
      const [created] = await tx
        .insert(walletsTable)
        .values({ userId: payout.userId, currency: "usd" })
        .returning();
      wallet = created;
    }
    if (wallet.currency.toLowerCase() !== "usd") {
      throw new Error(`Cash challenge prize requires USD wallet for user ${payout.userId}`);
    }

    const before = wallet.availableBalanceCents;
    const after = before + payout.prizeCents;
    const idempotencyKey = `prize:${input.raceRoomId}:${payout.userId}:${payout.rank}`;

    const inserted = await tx
      .insert(walletTransactionsTable)
      .values({
        walletId: wallet.id,
        userId: payout.userId,
        transactionType: "race_prize_paid",
        amountCents: payout.prizeCents,
        currency: wallet.currency,
        status: "completed",
        description: `Prize payout for race ${input.raceRoomId}`,
        source: "cash_challenge",
        raceRoomId: input.raceRoomId,
        idempotencyKey,
        balanceBeforeCents: before,
        balanceAfterCents: after,
        metadata: {
          rank: payout.rank,
        },
      })
      .onConflictDoNothing()
      .returning({ id: walletTransactionsTable.id });

    if (inserted.length === 0) continue;

    await tx
      .update(walletsTable)
      .set({
        availableBalanceCents: after,
        totalEarnedCents: sql`${walletsTable.totalEarnedCents} + ${payout.prizeCents}`,
        updatedAt: new Date(),
      })
      .where(eq(walletsTable.id, wallet.id));

    credited += 1;
  }

  return { credited };
}

/**
 * Idempotently credit entry-fee refunds back to wallets — used only by the Unlimited Challenge
 * zero-winner "refund_entry_contributions" policy (nobody completed, so entries are returned). The
 * fixed platform fee is NOT refunded. Keyed by `refund:{sourceId}:{userId}` so duplicate/retried
 * settlements never double-refund. Balance snapshots are written so the wallet-ledger reconciliation
 * stays consistent.
 */
export async function creditEntryRefunds(
  tx: DbTx,
  input: {
    sourceId: string; // the unlimited challenge id
    refunds: Array<{ userId: string; amountCents: number }>;
  },
) {
  let credited = 0;
  const byUser = new Map<string, number>();
  for (const r of input.refunds) {
    if (r.amountCents > 0) byUser.set(r.userId, Math.max(byUser.get(r.userId) ?? 0, r.amountCents));
  }

  for (const [userId, amountCents] of byUser) {
    let wallet = await lockWalletByUserId(tx, userId);
    if (!wallet) {
      const [created] = await tx.insert(walletsTable).values({ userId, currency: "usd" }).returning();
      wallet = created;
    }
    if (wallet.currency.toLowerCase() !== "usd") continue;

    const before = wallet.availableBalanceCents;
    const after = before + amountCents;
    const inserted = await tx
      .insert(walletTransactionsTable)
      .values({
        walletId: wallet.id,
        userId,
        transactionType: "race_entry_refund",
        amountCents,
        currency: wallet.currency,
        status: "completed",
        description: `Entry refund (no qualified winners) for challenge ${input.sourceId}`,
        source: "cash_challenge",
        raceRoomId: input.sourceId,
        idempotencyKey: `refund:${input.sourceId}:${userId}`,
        balanceBeforeCents: before,
        balanceAfterCents: after,
        metadata: { reason: "zero_winner_refund" },
      })
      .onConflictDoNothing()
      .returning({ id: walletTransactionsTable.id });
    if (inserted.length === 0) continue;

    await tx
      .update(walletsTable)
      .set({ availableBalanceCents: after, updatedAt: new Date() })
      .where(eq(walletsTable.id, wallet.id));
    credited += 1;
  }

  return { credited };
}
