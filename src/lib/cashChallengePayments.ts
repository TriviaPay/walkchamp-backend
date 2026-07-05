import { and, eq } from "drizzle-orm";
import { walletTransactionsTable } from "../../db/src/schema/index.js";
import { debitWalletForCashChallenge } from "./refundService.js";
import type { DbTx } from "./raceIntegrity.js";

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
  return debitWalletForCashChallenge(tx, input);
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
