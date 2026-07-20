import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Regression guards for the 2026-07 security audit remediation. These assert the
// key invariant of each fix at the source level (the handlers are DB-heavy and
// tested behaviorally elsewhere); if a fix is reverted, the matching case fails.
// See docs/security/audit-2026-07-19.md.

const read = (p: string) => readFileSync(p, "utf8");

describe("H-3 withdrawal approval is an atomic compare-and-swap", () => {
  it("wraps approval in a transaction with a pending-guarded update", () => {
    const admin = read("src/routes/admin.ts");
    const approveBlock = admin.slice(admin.indexOf("/admin/withdrawals/:id/approve"), admin.indexOf("/admin/withdrawals/:id/reject"));
    expect(approveBlock).toContain("db.transaction");
    expect(approveBlock).toContain('.for("update")');
    expect(approveBlock).toContain('eq(withdrawalsTable.status, "pending")');
    expect(approveBlock).toContain("updated.length === 0");
  });
});

describe("H-4 coin ledger locks the balance row before read-modify-write", () => {
  it("selects the balance FOR UPDATE inside recordCoinLedgerEntry", () => {
    const svc = read("src/lib/coinsService.ts");
    const fn = svc.slice(svc.indexOf("export async function recordCoinLedgerEntry"), svc.indexOf("export async function awardCoins"));
    expect(fn).toContain('.for("update")');
    expect(fn).toContain("NEGATIVE_COIN_BALANCE");
  });
});

describe("H-1 coins-battle requires full entry or disqualifies", () => {
  it("no longer admits partial/zero payers to the prize pool", () => {
    const races = read("src/routes/races.ts");
    expect(races).toContain("balance < room.coinEntryAmount");
    expect(races).toContain('status: "disqualified"');
    // The old free-ride path (charge min(balance, entry) then continue) is gone.
    expect(races).not.toContain("const toDeduct = Math.min(bal?.currentBalance ?? 0, room.coinEntryAmount)");
  });
});

describe("H-5 host removal from a paid room refunds the entry fee", () => {
  it("routes paid-room removals through the refund path and reports real amounts", () => {
    const races = read("src/routes/races.ts");
    const block = races.slice(races.indexOf("participants/:userId/remove"), races.indexOf("online-invite-candidates"));
    expect(block).toContain("room.entryAmountCents > 0");
    expect(block).toContain("createRefundForRaceLeave");
    expect(block).toContain('reasonCode: "host_removed"');
    // Refund fields are computed, not hardcoded false/0.
    expect(block).not.toContain("refundProcessed: false");
    expect(block).not.toContain("refundAmount: 0");
  });
});

describe("M-1 prize payout cannot double-credit across ranks", () => {
  it("adds a rank-independent existence check and dedupes payouts by user", () => {
    const pay = read("src/lib/cashChallengePayments.ts");
    expect(pay).toContain("export async function hasCompletedPrizePayment");
    expect(pay).toContain('eq(walletTransactionsTable.transactionType, "race_prize_paid")');
    expect(pay).toContain("if (await hasCompletedPrizePayment(tx, payout.userId, input.raceRoomId)) continue");
    expect(pay).toContain("byUser.set");
  });
});

describe("H-6 profile PATCH cannot mass-assign trust fields", () => {
  it("drops emailVerified/lastLoginAt/lastSeenAt from the client schema", () => {
    const auth = read("src/routes/auth.ts");
    const schema = auth.slice(auth.indexOf("const updateProfileSchema"), auth.indexOf("router.patch(\"/auth/profile/:userId\""));
    expect(schema).not.toContain("emailVerified");
    expect(schema).not.toContain("lastLoginAt");
    expect(schema).not.toContain("lastSeenAt");
    expect(schema).toContain("#[0-9a-fA-F]{6}");
  });
});

describe("M-3 membership is verified before writes/broadcasts", () => {
  it("chat react checks conversation membership and message ownership", () => {
    const chat = read("src/routes/chat.ts");
    const block = chat.slice(chat.indexOf('/chat/private/react'), chat.indexOf("DELETE /api/chat/private/conversations"));
    expect(block).toContain("Not a member of this conversation");
    expect(block).toContain("privateChatMessagesTable");
  });

  it("race comments require the caller to be a participant", () => {
    const races = read("src/routes/races.ts");
    expect(races).toContain("Only race participants can comment.");
    expect(races).toContain("isRaceParticipant(userId, raceId)");
  });
});

describe("M-5 theme ownership fails closed", () => {
  it("denies access on an unexpected error", () => {
    const themes = read("src/routes/trackThemes.ts");
    const fn = themes.slice(themes.indexOf("export async function validateThemeOwnership"));
    expect(fn).not.toContain("return true; // fail-open");
    expect(fn).toContain("return false");
  });
});

describe("L-2 OneSignal device is not silently reassigned", () => {
  it("rejects a device owned by another user", () => {
    const push = read("src/routes/push.ts");
    expect(push).toContain("Device is registered to another account.");
    expect(push).toContain("existingDevice.userId !== userId");
  });
});

describe("M-4 unauthenticated deposit callbacks are hardened", () => {
  it("caps reason and only patches pending transactions", () => {
    const deposit = read("src/routes/deposit.ts");
    expect(deposit).toContain("reason: z.string().max(200).optional()");
    expect(deposit).toContain("onlyIfPending");
    expect(deposit).toContain('depositTx.status !== "pending"');
  });
});

describe("H-2 reconciliation cannot exceed server-tracked steps", () => {
  it("caps at server steps and derives verified from server evidence", () => {
    const races = read("src/routes/races.ts");
    expect(races).toContain("exceeds server-tracked progress");
    expect(races).toContain("const serverCap = serverSteps + RECONCILE_TOLERANCE");
    // No longer trusts the client `source` field to grant "verified".
    expect(races).not.toContain('source === "healthkit" ? "verified"');
  });
});

describe("M-2 spectate reward is keyed per race, not per session", () => {
  it("grants SPECTATE_MATCH using raceRoomId as the idempotency source", () => {
    const spectate = read("src/routes/spectate.ts");
    expect(spectate).toContain('grantCoinReward(userId, "SPECTATE_MATCH", session.raceRoomId');
  });
});

describe("M-6 group step sync is bounded", () => {
  it("caps dailySteps and validates the step date window", () => {
    const groups = read("src/routes/groups.ts");
    expect(groups).toContain("max(MAX_DAILY_STEPS)");
    expect(groups).toContain("validateRecentLocalDate(stepDate");
  });
});
