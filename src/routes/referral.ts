import { Router } from "express";
import { and, eq, ne, or, sql, desc } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import { profilesTable, referralBonusAwardsTable, walletTransactionsTable } from "../../db/src/schema/index.js";
import { requireAuth, requireJwtOnly, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import { REFERRAL_BONUS_CENTS, REFERRAL_BONUS_CURRENCY } from "../lib/referralBonusService.js";
import { z } from "zod";

const router = Router();

type Resolver = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Resolve a referral code to its owner using the same matching rules as the bonus service:
// a code may be either the referrer's profile id or their referralCode (case-insensitive),
// and can never resolve to the caller (no self-referral).
async function resolveReferrer(dbOrTx: Resolver, code: string, excludeUserId: string) {
  const raw = code.trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  const [ref] = await dbOrTx
    .select({
      id: profilesTable.id,
      username: profilesTable.username,
      fullName: profilesTable.fullName,
      referralCode: profilesTable.referralCode,
    })
    .from(profilesTable)
    .where(and(
      ne(profilesTable.id, excludeUserId),
      or(
        eq(profilesTable.id, raw),
        eq(profilesTable.referralCode, raw),
        eq(profilesTable.referralCode, upper),
      ),
    ))
    .limit(1);
  return ref ?? null;
}

// Count of the user's completed cash-challenge entries. The referral bonus only fires on the
// FIRST one, so once this is >= 1 the referral window has closed.
async function completedCashEntryCount(dbOrTx: Resolver, userId: string): Promise<number> {
  const [{ n }] = await dbOrTx
    .select({ n: sql<number>`count(*)::int` })
    .from(walletTransactionsTable)
    .where(and(
      eq(walletTransactionsTable.userId, userId),
      eq(walletTransactionsTable.transactionType, "race_entry_wallet_debit"),
      eq(walletTransactionsTable.status, "completed"),
    ));
  return n;
}

// ── GET /api/referral — the caller's referral dashboard ───────────────────────
router.get("/referral", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const [me] = await db
    .select({ id: profilesTable.id, referralCode: profilesTable.referralCode })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);
  if (!me) return res.status(404).json({ error: "profile_required" });

  const codeUpper = (me.referralCode ?? "").toUpperCase();

  // Everyone who signed up with this user's code (by id or code, case-insensitive).
  const referredUsers = me.referralCode
    ? await db
        .select({ id: profilesTable.id, username: profilesTable.username, joinedAt: profilesTable.createdAt })
        .from(profilesTable)
        .where(or(
          eq(profilesTable.referredBy, me.id),
          sql`upper(${profilesTable.referredBy}) = ${codeUpper}`,
        ))
        .orderBy(desc(profilesTable.createdAt))
        .limit(200)
    : [];

  // Bonuses already credited to this user as the referrer.
  const awards = await db
    .select({
      referredUserId: referralBonusAwardsTable.referredUserId,
      amountCents: referralBonusAwardsTable.amountCents,
      creditedAt: referralBonusAwardsTable.creditedAt,
    })
    .from(referralBonusAwardsTable)
    .where(eq(referralBonusAwardsTable.referrerUserId, me.id));

  const creditedByUser = new Map(awards.map((a) => [a.referredUserId, a]));
  const totalEarnedMinor = awards.reduce((sum, a) => sum + a.amountCents, 0);

  const referrals = referredUsers.map((u) => {
    const award = creditedByUser.get(u.id);
    return {
      userId: u.id,
      username: u.username,
      status: award ? "credited" : "pending",
      joinedAt: u.joinedAt.toISOString(),
      creditedAt: award?.creditedAt.toISOString() ?? null,
    };
  });

  return res.json({
    referralCode: me.referralCode,
    bonusAmount: REFERRAL_BONUS_CENTS / 100,
    bonusAmountMinor: REFERRAL_BONUS_CENTS,
    currency: REFERRAL_BONUS_CURRENCY,
    summary: {
      totalReferred: referredUsers.length,
      credited: awards.length,
      pending: Math.max(0, referredUsers.length - awards.length),
      totalEarned: totalEarnedMinor / 100,
      totalEarnedMinor,
    },
    referrals,
  });
});

// ── GET /api/referral/validate?code=XXX — check a code before/at signup ───────
// JWT-only so it works during onboarding before a profile exists.
router.get("/referral/validate", requireJwtOnly, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const code = String(req.query.code ?? "").trim();
  if (!code) return res.json({ valid: false, reason: "empty" });

  const referrer = await resolveReferrer(db, code, userId);
  if (!referrer) return res.json({ valid: false, reason: "not_found" });

  return res.json({
    valid: true,
    referrer: { username: referrer.username, fullName: referrer.fullName },
  });
});

// ── POST /api/referral/apply — attach a referral code after signup ────────────
const applySchema = z.object({ code: z.string().trim().min(1) });

router.post("/referral/apply", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", message: "A referral code is required." });
  }

  let status = 200;
  let body: Record<string, unknown> = {};

  await db.transaction(async (tx) => {
    const [me] = await tx
      .select({ id: profilesTable.id, referredBy: profilesTable.referredBy })
      .from(profilesTable)
      .where(eq(profilesTable.id, userId))
      .limit(1)
      .for("update");

    if (!me) {
      status = 404;
      body = { error: "profile_required" };
      return;
    }
    if (me.referredBy?.trim()) {
      status = 409;
      body = { error: "already_referred", message: "A referral code has already been applied to this account." };
      return;
    }

    const referrer = await resolveReferrer(tx, parsed.data.code, userId);
    if (!referrer) {
      status = 404;
      body = { error: "invalid_code", message: "That referral code is not valid." };
      return;
    }

    // The bonus only ever fires on the user's first cash challenge. If they have already entered
    // one, applying a code now could never earn the bonus — reject rather than silently no-op.
    if ((await completedCashEntryCount(tx, userId)) >= 1) {
      status = 409;
      body = {
        error: "window_closed",
        message: "You can only add a referral code before joining your first Cash Challenge.",
      };
      return;
    }

    // Store the referrer's canonical id so the bonus service resolves it unambiguously later.
    await tx
      .update(profilesTable)
      .set({ referredBy: referrer.id, updatedAt: new Date() })
      .where(eq(profilesTable.id, userId));

    body = {
      applied: true,
      referrer: { username: referrer.username },
      message: "Referral code applied. You'll both earn a bonus after your first Cash Challenge.",
    };
  });

  return res.status(status).json(body);
});

export default router;
