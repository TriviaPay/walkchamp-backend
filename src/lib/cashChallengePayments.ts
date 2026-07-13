import { and, eq, sql } from "drizzle-orm";
import { walletsTable, walletTransactionsTable } from "../../db/src/schema/index.js";
import { debitWalletForCashChallenge } from "./refundService.js";
import { lockWalletByUserId, type DbTx } from "./raceIntegrity.js";

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
  return debitWalletForCashChallenge(tx, {
    ...input,
    idempotencyKey: `challenge_entry:${input.raceRoomId}:${input.userId}`,
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

export async function creditCashChallengePrizes(
  tx: DbTx,
  input: {
    raceRoomId: string;
    payouts: Array<{ userId: string; rank: number; prizeCents: number }>;
  },
) {
  let credited = 0;

  for (const payout of input.payouts) {
    if (payout.prizeCents <= 0) continue;

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
