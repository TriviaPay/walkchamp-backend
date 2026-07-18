import { and, eq, ne, or, sql } from "drizzle-orm";
import {
  auditLogsTable,
  profilesTable,
  referralBonusAwardsTable,
  walletsTable,
  walletTransactionsTable,
} from "../../db/src/schema/index.js";
import { lockWalletByUserId, type DbTx } from "./raceIntegrity.js";

export const REFERRAL_BONUS_CENTS = 300;
export const REFERRAL_BONUS_CURRENCY = "usd";
export const REFERRER_REFERRAL_BONUS_DESCRIPTION = "Invited friend joined a Cash Challenge";
export const REFERRED_REFERRAL_BONUS_DESCRIPTION = "Joined first Cash Challenge using referral";

type ReferralBonusResult =
  | { credited: true; awardId: string; referrerUserId: string; referredUserId: string }
  | { credited: false; reason: string };

async function ensureLockedUsdWallet(tx: DbTx, userId: string) {
  let wallet = await lockWalletByUserId(tx, userId);
  if (wallet) return wallet;

  await tx
    .insert(walletsTable)
    .values({ userId, currency: REFERRAL_BONUS_CURRENCY })
    .onConflictDoNothing();

  wallet = await lockWalletByUserId(tx, userId);
  return wallet;
}

async function creditReferralWallet(tx: DbTx, input: {
  userId: string;
  wallet: typeof walletsTable.$inferSelect;
  idempotencyKey: string;
  description: string;
  role: "referrer" | "referred";
  awardId: string;
  referrerUserId: string;
  referredUserId: string;
  raceRoomId: string;
  creditedAt: Date;
}) {
  const before = input.wallet.availableBalanceCents;
  const after = before + REFERRAL_BONUS_CENTS;

  const inserted = await tx
    .insert(walletTransactionsTable)
    .values({
      walletId: input.wallet.id,
      userId: input.userId,
      transactionType: "referral_credit",
      amountCents: REFERRAL_BONUS_CENTS,
      currency: input.wallet.currency,
      status: "completed",
      description: input.description,
      source: "referral_bonus",
      idempotencyKey: input.idempotencyKey,
      raceRoomId: input.raceRoomId,
      balanceBeforeCents: before,
      balanceAfterCents: after,
      metadata: {
        referralAwardId: input.awardId,
        referralRole: input.role,
        referrerUserId: input.referrerUserId,
        referredUserId: input.referredUserId,
        triggerRaceRoomId: input.raceRoomId,
      },
      createdAt: input.creditedAt,
    })
    .onConflictDoNothing()
    .returning({ id: walletTransactionsTable.id });

  if (inserted.length === 0) return null;

  await tx
    .update(walletsTable)
    .set({
      availableBalanceCents: after,
      totalEarnedCents: sql`${walletsTable.totalEarnedCents} + ${REFERRAL_BONUS_CENTS}`,
      updatedAt: input.creditedAt,
    })
    .where(eq(walletsTable.id, input.wallet.id));

  return inserted[0].id;
}

export async function grantReferralBonusForCashChallenge(
  tx: DbTx,
  input: { referredUserId: string; raceRoomId: string },
): Promise<ReferralBonusResult> {
  const [{ paidEntryCount }] = await tx
    .select({ paidEntryCount: sql<number>`count(*)::int` })
    .from(walletTransactionsTable)
    .where(
      and(
        eq(walletTransactionsTable.userId, input.referredUserId),
        eq(walletTransactionsTable.transactionType, "race_entry_wallet_debit"),
        eq(walletTransactionsTable.status, "completed"),
      ),
    );

  if (paidEntryCount !== 1) {
    return { credited: false, reason: "not_first_cash_challenge" };
  }

  const [referred] = await tx
    .select({
      id: profilesTable.id,
      referredBy: profilesTable.referredBy,
    })
    .from(profilesTable)
    .where(eq(profilesTable.id, input.referredUserId))
    .limit(1)
    .for("update");

  const rawReferral = referred?.referredBy?.trim();
  if (!referred || !rawReferral) {
    return { credited: false, reason: "no_referral" };
  }

  const normalizedReferralCode = rawReferral.toUpperCase();
  const [referrer] = await tx
    .select({
      id: profilesTable.id,
      referralCode: profilesTable.referralCode,
    })
    .from(profilesTable)
    .where(
      and(
        ne(profilesTable.id, input.referredUserId),
        or(
          eq(profilesTable.id, rawReferral),
          eq(profilesTable.referralCode, rawReferral),
          eq(profilesTable.referralCode, normalizedReferralCode),
        ),
      ),
    )
    .limit(1)
    .for("update");

  if (!referrer) {
    return { credited: false, reason: "referrer_not_found" };
  }

  const creditedAt = new Date();
  const referrerWallet = await ensureLockedUsdWallet(tx, referrer.id);
  const referredWallet = await ensureLockedUsdWallet(tx, input.referredUserId);

  if (!referrerWallet || !referredWallet) {
    return { credited: false, reason: "wallet_not_available" };
  }
  if (
    referrerWallet.currency.toLowerCase() !== REFERRAL_BONUS_CURRENCY ||
    referredWallet.currency.toLowerCase() !== REFERRAL_BONUS_CURRENCY
  ) {
    return { credited: false, reason: "unsupported_wallet_currency" };
  }

  const insertedAward = await tx
    .insert(referralBonusAwardsTable)
    .values({
      referrerUserId: referrer.id,
      referredUserId: input.referredUserId,
      referralCode: referrer.referralCode ?? normalizedReferralCode,
      triggerRaceRoomId: input.raceRoomId,
      amountCents: REFERRAL_BONUS_CENTS,
      currency: REFERRAL_BONUS_CURRENCY,
      status: "completed",
      creditedAt,
      metadata: {
        trigger: "first_cash_challenge_entry",
      },
    })
    .onConflictDoNothing()
    .returning({ id: referralBonusAwardsTable.id });

  if (insertedAward.length === 0) {
    return { credited: false, reason: "already_credited" };
  }

  const awardId = insertedAward[0].id;
  const referrerTransactionId = await creditReferralWallet(tx, {
    userId: referrer.id,
    wallet: referrerWallet,
    idempotencyKey: `referral_bonus:referrer:${input.referredUserId}`,
    description: REFERRER_REFERRAL_BONUS_DESCRIPTION,
    role: "referrer",
    awardId,
    referrerUserId: referrer.id,
    referredUserId: input.referredUserId,
    raceRoomId: input.raceRoomId,
    creditedAt,
  });
  const referredTransactionId = await creditReferralWallet(tx, {
    userId: input.referredUserId,
    wallet: referredWallet,
    idempotencyKey: `referral_bonus:referred:${input.referredUserId}`,
    description: REFERRED_REFERRAL_BONUS_DESCRIPTION,
    role: "referred",
    awardId,
    referrerUserId: referrer.id,
    referredUserId: input.referredUserId,
    raceRoomId: input.raceRoomId,
    creditedAt,
  });

  if (!referrerTransactionId || !referredTransactionId) {
    throw new Error("Referral bonus ledger row already exists without award record.");
  }

  await tx
    .update(referralBonusAwardsTable)
    .set({
      referrerTransactionId,
      referredTransactionId,
      updatedAt: creditedAt,
    })
    .where(eq(referralBonusAwardsTable.id, awardId));

  await tx.insert(auditLogsTable).values({
    actorType: "system",
    action: "referral_bonus_credited",
    entityType: "referral_bonus_award",
    entityId: awardId,
    reason: "first_cash_challenge_entry",
    metadata: {
      referrerUserId: referrer.id,
      referredUserId: input.referredUserId,
      triggerRaceRoomId: input.raceRoomId,
      amountCents: REFERRAL_BONUS_CENTS,
      referrerTransactionId,
      referredTransactionId,
    },
  });

  return {
    credited: true,
    awardId,
    referrerUserId: referrer.id,
    referredUserId: input.referredUserId,
  };
}
