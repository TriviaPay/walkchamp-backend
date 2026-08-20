import { and, eq, gte, ne, or, sql } from "drizzle-orm";
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

// Velocity cap (audit 2026-08-16 F-07): each award pays $6 of real wallet value, so an operator
// farming N self-referred accounts must not be able to mint bonuses at scale. The cap bounds a
// referrer's awards in a rolling 24h window; hitting it is logged as an abuse signal.
export const REFERRAL_BONUS_VELOCITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REFERRAL_BONUS_MAX_PER_REFERRER_PER_DAY = 5;

export function referralBonusDailyCap(): number {
  const raw = Number.parseInt(process.env.REFERRAL_BONUS_MAX_PER_REFERRER_PER_DAY ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_REFERRAL_BONUS_MAX_PER_REFERRER_PER_DAY;
}
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

  const velocityCap = referralBonusDailyCap();
  const windowStart = new Date(Date.now() - REFERRAL_BONUS_VELOCITY_WINDOW_MS);
  const [{ recentAwardCount }] = await tx
    .select({ recentAwardCount: sql<number>`count(*)::int` })
    .from(referralBonusAwardsTable)
    .where(
      and(
        eq(referralBonusAwardsTable.referrerUserId, referrer.id),
        gte(referralBonusAwardsTable.creditedAt, windowStart),
      ),
    );

  if (recentAwardCount >= velocityCap) {
    await tx.insert(auditLogsTable).values({
      actorType: "system",
      action: "referral_bonus_velocity_capped",
      entityType: "profile",
      entityId: referrer.id,
      reason: "daily_referral_bonus_cap_reached",
      metadata: {
        referrerUserId: referrer.id,
        referredUserId: input.referredUserId,
        triggerRaceRoomId: input.raceRoomId,
        recentAwardCount,
        velocityCap,
        windowHours: REFERRAL_BONUS_VELOCITY_WINDOW_MS / (60 * 60 * 1000),
      },
    });
    return { credited: false, reason: "referrer_velocity_capped" };
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
