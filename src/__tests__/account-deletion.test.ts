import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Audit 2026-08-16 F-03: account deletion used to be a bare status flip — no balance check, no
// PII removal, no session revocation. These contract tests pin the hardened handler's shape so
// a refactor cannot quietly regress to the flip.

describe("DELETE /api/me/account", () => {
  const source = readFileSync("src/routes/profile.ts", "utf8");
  const handler = source.slice(source.indexOf('router.delete("/me/account"'));

  it("exists and requires auth", () => {
    expect(handler.startsWith('router.delete("/me/account", requireAuth')).toBe(true);
  });

  it("refuses deletion while money is in play, before any status change", () => {
    const walletGuard = handler.indexOf("WALLET_BALANCE_REMAINING");
    const withdrawalGuard = handler.indexOf("WITHDRAWAL_IN_PROGRESS");
    const raceGuard = handler.indexOf("ACTIVE_PAID_RACE");
    const statusFlip = handler.indexOf('accountStatus: "deleted"');

    expect(walletGuard).toBeGreaterThan(-1);
    expect(withdrawalGuard).toBeGreaterThan(walletGuard);
    expect(raceGuard).toBeGreaterThan(withdrawalGuard);
    expect(statusFlip).toBeGreaterThan(raceGuard);
    // The guards return a 409, not a silent success.
    expect(handler).toContain("res.status(409)");
  });

  it("checks every wallet balance bucket under a row lock", () => {
    expect(handler).toContain("lockWalletByUserId(tx, userId)");
    for (const bucket of ["availableBalanceCents", "pendingBalanceCents", "withdrawableBalanceCents"]) {
      expect(handler).toContain(`wallet.${bucket} > 0`);
    }
  });

  it("anonymizes PII rather than only flipping the status", () => {
    for (const scrub of [
      "@anonymized.invalid",
      'fullName: "Deleted User"',
      "dateOfBirth: null",
      "phoneNumber: null",
      "avatarUrl: null",
      "bio: null",
    ]) {
      expect(handler).toContain(scrub);
    }
  });

  it("revokes local sessions and the Descope provider session", () => {
    expect(handler).toContain('revokeSession(session.sessionId, userId, "account_deleted")');
    expect(handler).toContain("logoutUserByUserId(userId)");
  });

  it("writes an audit log entry for the deletion", () => {
    expect(handler).toContain('action: "account_deleted"');
  });
});

describe("POST /api/me/account/deletion-request", () => {
  const source = readFileSync("src/routes/profile.ts", "utf8");
  const handler = source.slice(
    source.indexOf('router.post("/me/account/deletion-request"'),
    source.indexOf('// ── DELETE /api/me/account'),
  );

  it("requires auth, rate limits requests, and emails server-owned profile identity", () => {
    expect(handler.startsWith('router.post("/me/account/deletion-request", requireAuth, accountDeletionRequestLimiter')).toBe(true);
    expect(handler).toContain("profilesTable.email");
    expect(handler).toContain("profilesTable.username");
    expect(handler).toContain("sendAccountDeletionRequestEmail");
    expect(handler).toContain('action: "account_deletion_requested"');
    expect(handler).toContain("res.status(202)");
  });
});

describe("POST /api/account-deletion-request", () => {
  const source = readFileSync("src/routes/profile.ts", "utf8");
  const handler = source.slice(
    source.indexOf('router.post("/account-deletion-request"'),
    source.indexOf('// ── POST /api/me/account/deletion-request'),
  );

  it("rate limits the public form, validates its input, and emails without mutating an account", () => {
    expect(handler.startsWith('router.post("/account-deletion-request", accountDeletionRequestLimiter')).toBe(true);
    expect(handler).toContain("publicAccountDeletionRequestSchema.safeParse");
    expect(handler).toContain('source: "public_web_form"');
    expect(handler).toContain("sendAccountDeletionRequestEmail");
    expect(handler).toContain("res.status(202)");
    expect(handler).not.toContain("db.update");
    expect(handler).not.toContain("db.delete");
  });
});
