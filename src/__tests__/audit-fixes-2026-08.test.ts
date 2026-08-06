import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { validateRecentLocalDate } from "../lib/localDate.js";

// Regression guards for the 2026-08 security scan remediation. Same approach as
// audit-fixes-2026-07: assert the key invariant of each fix, at the source level where the
// handler is DB-heavy and behaviorally where the logic is pure. See SECURITY-SCAN.md.

const read = (p: string) => readFileSync(p, "utf8");

describe("H1 deposit done page cannot be used for reflected XSS", () => {
  it("only interpolates a server-validated UUID into the inline script", () => {
    const deposit = read("src/routes/deposit.ts");
    const doneBlock = deposit.slice(
      deposit.indexOf('router.get("/wallet/deposit/done"'),
      deposit.indexOf("RAZORPAY BROWSER CANCEL"),
    );

    expect(doneBlock).toContain("UUID_PATTERN.test(rawTransactionId)");
    // The old client-side fallback re-read the unvalidated query param.
    expect(doneBlock).not.toContain("params.get('transaction_id')");
  });

  it("anchors the UUID pattern so a payload cannot be appended", () => {
    const deposit = read("src/routes/deposit.ts");
    const source = /const UUID_PATTERN = (\S+);/.exec(deposit)?.[1];

    // Anchoring is what stops "<valid-uuid></script>…" from matching.
    expect(source).toContain("^");
    expect(source).toContain("$");
    expect(source).toBe("/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i");
  });

  it("renders the status icon via hasOwnProperty, not a bare truthy lookup", () => {
    const deposit = read("src/routes/deposit.ts");
    expect(deposit).toContain("Object.prototype.hasOwnProperty.call(icons, status)");
  });
});

describe("H2 OAuth start only accepts allowlisted redirect URLs", () => {
  it("matches against config.auth.oauthRedirectUrls instead of any parseable URL", () => {
    const auth = read("src/routes/auth.ts");
    const fn = auth.slice(
      auth.indexOf("function isValidRedirectUrl"),
      auth.indexOf("const oauthStartSchema"),
    );

    expect(fn).toContain("config.auth.oauthRedirectUrls");
    // The old check passed anything with a protocol, including https://attacker.example.
    expect(fn).not.toContain("parsed.protocol.length > 0");
  });

  it("derives the default allowlist from the native scheme and configured origins", () => {
    const config = read("src/lib/config.ts");
    expect(config).toContain("OAUTH_ALLOWED_REDIRECT_URLS");
    expect(config).toContain('"globalwalkerleague://auth-callback"');
    expect(config).toContain("oauthRedirectUrls: oauthAllowedRedirectUrls");
  });
});

describe("H3 ad rewards are bounded to a recent local date", () => {
  it("routes localDate through validateRecentLocalDate on both the award and limit paths", () => {
    const coins = read("src/routes/coins.ts");
    const block = coins.slice(coins.indexOf('router.post("/coins/ad-reward"'));

    expect(block).toContain("validateRecentLocalDate");
    // The old format-only check let any well-formed date through.
    expect(block).not.toContain("/^\\d{4}-\\d{2}-\\d{2}$/.test(rawLD)");
    // Both the success path and the AD_REWARD_LIMIT catch block must validate.
    expect(block.match(/validateRecentLocalDate/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects the backdating that reset the daily cap", () => {
    const now = new Date("2026-08-06T12:00:00Z");

    expect(validateRecentLocalDate("2020-01-01", { pastDays: 1, futureDays: 1, now }).ok).toBe(false);
    expect(validateRecentLocalDate("2030-01-01", { pastDays: 1, futureDays: 1, now }).ok).toBe(false);
    expect(validateRecentLocalDate("2026-08-06", { pastDays: 1, futureDays: 1, now }).ok).toBe(true);
    expect(validateRecentLocalDate("2026-08-05", { pastDays: 1, futureDays: 1, now }).ok).toBe(true);
  });
});

describe("H4 Apple sign-in never links an account by an unverified email", () => {
  it("falls back to the Apple subject unless the email claim is verified", () => {
    const auth = read("src/routes/auth.ts");
    const block = auth.slice(
      auth.indexOf('router.post("/auth/apple/native"'),
      auth.indexOf("POST /api/auth/oauth/start"),
    );

    expect(block).toContain("const verifiedEmail = emailVerified && email ? email : null");
    expect(block).toContain("const loginId = verifiedEmail ?? `apple:${appleUserId}`");
    // The old form resolved an existing account from an unverified address.
    expect(block).not.toContain("const loginId = email || `apple:${appleUserId}`");
  });
});

describe("M5 signup binds the profile email to the verified JWT claim", () => {
  it("rejects a body email that disagrees with the token", () => {
    const auth = read("src/routes/auth.ts");
    const block = auth.slice(
      auth.indexOf('router.post("/auth/profile"'),
      auth.indexOf("GET /api/auth/profile/:userId"),
    );

    expect(block).toContain('res.status(403).json({ error: "Email mismatch" })');
    expect(block).toContain("email: verifiedEmail ?? data.email.toLowerCase().trim()");
  });
});

describe("M6 the admin service key is compared in constant time", () => {
  it("uses timingSafeEqual rather than string equality", () => {
    const mw = read("src/middleware/requireAdminKey.ts");
    expect(mw).toContain("timingSafeEqual");
    expect(mw).toContain("secretsMatch(provided, adminKey)");
    expect(mw).not.toContain("provided !== adminKey");
  });
});

describe("M7 sponsored event target steps require admin auth", () => {
  it("gates the route behind requireAdminKey", () => {
    const sponsored = read("src/routes/sponsoredEvents.ts");
    expect(sponsored).toContain(
      'router.patch("/sponsored-events/:roomId/target-steps", requireAuth, requireAdminKey',
    );
  });
});

describe("M4 the public profile route bounds its per-request work", () => {
  it("aggregates the all-time total in SQL and caps the streak scan", () => {
    const profile = read("src/routes/profile.ts");
    const block = profile.slice(
      profile.indexOf('router.get("/profile/public/:username"'),
      profile.indexOf('router.get("/users/:userId/public-profile"'),
    );

    expect(block).toContain("PUBLIC_STREAK_SCAN_DAYS");
    expect(block).toContain("coalesce(sum(");
    // The old code summed every transferred daily row in Node.
    expect(block).not.toContain("pubStreakRows.reduce((sum, r) => sum + (r.steps ?? 0), 0)");
  });
});
