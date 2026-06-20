import { Router } from "express";
import { db } from "@db";
import { profilesTable, walletsTable } from "@db/schema";
import { eq } from "drizzle-orm";
import { getDescopeClient } from "../lib/descope";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth";
import { z } from "zod";

const router = Router();

// ── IP rate limiter for unauthenticated endpoints (username-check, oauth) ────
// 60 checks per minute per IP — prevents username enumeration at scale
interface IpBucket { count: number; resetAt: number }
const _ipRateStore = new Map<string, IpBucket>();
function checkIpRateLimit(ip: string, max = 60, windowMs = 60_000): { allowed: boolean } {
  const now = Date.now();
  const existing = _ipRateStore.get(ip);
  const bucket: IpBucket = existing && now < existing.resetAt
    ? existing
    : { count: 0, resetAt: now + windowMs };
  if (bucket.count >= max) return { allowed: false };
  bucket.count++;
  _ipRateStore.set(ip, bucket);
  return { allowed: true };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _ipRateStore) { if (now >= v.resetAt) _ipRateStore.delete(k); }
}, 10 * 60_000);

// ── Username helpers ─────────────────────────────────────────────────────────
const BLOCKED_USERNAMES = new Set([
  "admin", "support", "official", "system", "moderator",
  "walkchamp", "walk_champ", "walkchampadmin", "staff", "help",
  "contact", "security", "root", "superadmin",
]);

function isBlockedUsername(username: string): boolean {
  const lower = username.toLowerCase().replace(/_/g, "");
  return (
    BLOCKED_USERNAMES.has(lower) ||
    lower.includes("admin") ||
    lower.includes("support") ||
    lower.includes("walkchamp") ||
    lower.includes("official")
  );
}

function calcAge(dob: string): number {
  const birth = new Date(dob);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

// ── GET /api/me — authenticated: return profile for the JWT owner ─────────────
router.get("/me", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const [profile] = await db
    .select()
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);

  if (!profile) {
    // User authenticated but has no profile yet
    return res.status(404).json({ profile_completed: false, profile: null });
  }

  // Update last_seen
  db.update(profilesTable)
    .set({ lastSeenAt: new Date() })
    .where(eq(profilesTable.id, userId))
    .catch(() => {});

  return res.json({ profile });
});

// ── GET /api/auth/username-check?username=xxx ────────────────────────────────
router.get("/auth/username-check", async (req, res) => {
  const { allowed } = checkIpRateLimit(req.ip ?? "unknown");
  if (!allowed) return res.status(429).json({ error: "Too many requests. Please slow down." });

  const username = String(req.query.username ?? "").trim().toLowerCase();
  if (!username) return res.status(400).json({ error: "username required" });

  const usernameRe = /^[a-zA-Z][a-zA-Z0-9_]{5,13}$/;
  if (!usernameRe.test(username)) {
    return res.json({ available: false, reason: "invalid_format" });
  }
  if (isBlockedUsername(username)) {
    return res.json({ available: false, reason: "blocked" });
  }

  const existing = await db
    .select({ id: profilesTable.id })
    .from(profilesTable)
    .where(eq(profilesTable.username, username))
    .limit(1);

  return res.json({ available: existing.length === 0 });
});

// ── POST /api/auth/profile — authenticated: create profile ──────────────────
const createProfileSchema = z.object({
  descopeUserId: z.string(),
  email: z.string().email(),
  fullName: z.string().min(1),
  username: z.string().min(6).max(14).regex(/^[a-zA-Z][a-zA-Z0-9_]{5,13}$/),
  dateOfBirth: z.string(),
  country: z.string(),
  countryCode: z.string(),
  countryFlag: z.string(),
  region: z.string().optional(),
  referredBy: z.string().optional(),
  authProvider: z.string().default("email"),
  avatarColor: z.string().default("#00E676"),
  termsAccepted: z.boolean(),
  privacyAccepted: z.boolean(),
  rewardDisclaimerAccepted: z.boolean(),
  marketingOptIn: z.boolean().default(false),
});

type CreateProfileData = z.infer<typeof createProfileSchema>;

router.post("/auth/profile", requireAuth, async (req, res) => {
  const authUserId = (req as AuthenticatedRequest).descopeUserId;

  const parse = createProfileSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid data", details: parse.error.issues });
  }
  const data: CreateProfileData = parse.data;

  // Security: ignore descopeUserId from body — always use the verified JWT subject
  if (data.descopeUserId !== authUserId) {
    return res.status(403).json({ error: "User ID mismatch" });
  }

  if (isBlockedUsername(data.username)) {
    return res.status(409).json({ error: "username_blocked" });
  }

  const existingUsername = await db
    .select({ id: profilesTable.id })
    .from(profilesTable)
    .where(eq(profilesTable.username, data.username.toLowerCase()))
    .limit(1);
  if (existingUsername.length > 0) {
    return res.status(409).json({ error: "username_taken" });
  }

  const age = calcAge(data.dateOfBirth);
  const isAdult = age >= 18;
  const referralCode = "WC" + Math.random().toString(36).substring(2, 8).toUpperCase();

  try {
    const [profile] = await db
      .insert(profilesTable)
      .values({
        id: authUserId,
        email: data.email.toLowerCase().trim(),
        fullName: data.fullName.trim(),
        username: data.username.toLowerCase().trim(),
        dateOfBirth: data.dateOfBirth,
        age,
        country: data.country,
        countryCode: data.countryCode,
        countryFlag: data.countryFlag,
        region: data.region,
        authProvider: data.authProvider,
        // Email was verified via OTP before this endpoint is reached
        emailVerified: true,
        termsAccepted: data.termsAccepted,
        privacyAccepted: data.privacyAccepted,
        rewardDisclaimerAccepted: data.rewardDisclaimerAccepted,
        marketingOptIn: data.marketingOptIn,
        isAdult,
        paidRaceEnabled: isAdult,
        withdrawalsEnabled: false,
        avatarColor: data.avatarColor,
        referralCode,
        referredBy: data.referredBy ?? null,
        accountStatus: "active",
        lastLoginAt: new Date(),
      })
      .returning();

    return res.status(201).json({ profile });
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === "23505") {
      return res.status(409).json({ error: "email_taken" });
    }
    req.log.error(err);
    return res.status(500).json({ error: "server_error" });
  }
});

// ── GET /api/auth/profile/:userId — internal use (profile restore on startup) ─
// No auth required here because it's called during session restore
// before we know if the JWT is still valid.
// The userId comes from decoding the locally stored JWT — not from the network.
router.get("/auth/profile/:userId", async (req, res) => {
  const { userId } = req.params;
  const [profile] = await db
    .select()
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);

  if (!profile) return res.status(404).json({ error: "not_found" });
  return res.json({ profile });
});

// ── PATCH /api/auth/profile/:userId — authenticated ─────────────────────────
const updateProfileSchema = z.object({
  emailVerified: z.boolean().optional(),
  lastLoginAt: z.string().optional(),
  lastSeenAt: z.string().optional(),
  avatarColor: z.string().optional(),
  bio: z.string().max(120).optional(),
});

router.patch("/auth/profile/:userId", requireAuth, async (req, res) => {
  const authUserId = (req as AuthenticatedRequest).descopeUserId;
  const { userId } = req.params;

  // Users can only update their own profile
  if (userId !== authUserId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const parse = updateProfileSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid data" });
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  const d = parse.data;
  if (d.emailVerified !== undefined) updates.emailVerified = d.emailVerified;
  if (d.avatarColor) updates.avatarColor = d.avatarColor;
  if (d.bio !== undefined) updates.bio = d.bio;
  if (d.lastLoginAt) updates.lastLoginAt = new Date(d.lastLoginAt);
  if (d.lastSeenAt) updates.lastSeenAt = new Date(d.lastSeenAt);

  const [updated] = await db
    .update(profilesTable)
    .set(updates)
    .where(eq(profilesTable.id, authUserId))
    .returning();

  if (!updated) return res.status(404).json({ error: "not_found" });
  return res.json({ profile: updated });
});

// ── POST /api/auth/complete-signup — set password + create profile ────────────
// The frontend has a verified OTP session JWT. This endpoint:
//   1. Looks up the user's loginId (email) in Descope by userId from the JWT
//   2. Sets the password in Descope using the management key (password NEVER
//      stored in NeonDB)
//   3. Creates the NeonDB profile linked to the Descope user ID
const completeSignupSchema = z.object({
  password: z.string().min(8),
  fullName: z.string().min(1),
  username: z.string().min(6).max(14).regex(/^[a-zA-Z][a-zA-Z0-9_]{5,13}$/),
  dateOfBirth: z.string(),
  country: z.string(),
  countryCode: z.string(),
  countryFlag: z.string(),
  region: z.string().optional(),
  referredBy: z.string().optional(),
  avatarColor: z.string().default("#00E676"),
  termsAccepted: z.boolean(),
  privacyAccepted: z.boolean(),
  rewardDisclaimerAccepted: z.boolean(),
  marketingOptIn: z.boolean().default(false),
});

router.post("/auth/complete-signup", requireAuth, async (req, res) => {
  const authUserId = (req as AuthenticatedRequest).descopeUserId;

  const parse = completeSignupSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid data", details: parse.error.issues });
  }
  const data = parse.data;

  // Resolve the user's loginId (email) from Descope using the verified userId
  const client = getDescopeClient();
  const userResult = await client.management.user.loadByUserId(authUserId);
  if (!userResult.ok || !userResult.data) {
    req.log.error({ authUserId }, "Could not load Descope user");
    return res.status(400).json({ error: "Could not find Descope user" });
  }

  const loginId = userResult.data.loginIds?.[0];
  if (!loginId) {
    return res.status(400).json({ error: "User has no login ID in Descope" });
  }

  // Set password in Descope via management SDK — NeonDB never stores passwords
  const pwResult = await client.management.user.setActivePassword(loginId, data.password);
  if (!pwResult.ok) {
    req.log.error({ loginId, error: pwResult.error }, "Failed to set Descope password");
    return res.status(500).json({ error: "Failed to set password. Ensure Password Authentication is enabled in Descope." });
  }

  // Validate username availability
  if (isBlockedUsername(data.username)) {
    return res.status(409).json({ error: "username_blocked" });
  }
  const existingUsername = await db
    .select({ id: profilesTable.id })
    .from(profilesTable)
    .where(eq(profilesTable.username, data.username.toLowerCase()))
    .limit(1);
  if (existingUsername.length > 0) {
    return res.status(409).json({ error: "username_taken" });
  }

  const age = calcAge(data.dateOfBirth);
  const isAdult = age >= 18;
  const referralCode = "WC" + Math.random().toString(36).substring(2, 8).toUpperCase();

  try {
    const [profile] = await db.transaction(async (tx) => {
      const [p] = await tx
        .insert(profilesTable)
        .values({
          id: authUserId,
          email: loginId.toLowerCase().trim(),
          fullName: data.fullName.trim(),
          username: data.username.toLowerCase().trim(),
          dateOfBirth: data.dateOfBirth,
          age,
          country: data.country,
          countryCode: data.countryCode,
          countryFlag: data.countryFlag,
          region: data.region,
          authProvider: "email_password",
          emailVerified: true,
          termsAccepted: data.termsAccepted,
          privacyAccepted: data.privacyAccepted,
          rewardDisclaimerAccepted: data.rewardDisclaimerAccepted,
          marketingOptIn: data.marketingOptIn,
          isAdult,
          paidRaceEnabled: isAdult,
          withdrawalsEnabled: false,
          avatarColor: data.avatarColor,
          referralCode,
          referredBy: data.referredBy ?? null,
          accountStatus: "active",
          profileCompleted: true,
          lastLoginAt: new Date(),
        })
        .returning();

      // Auto-create wallet for new users
      await tx
        .insert(walletsTable)
        .values({ userId: authUserId })
        .onConflictDoNothing();

      return [p];
    });

    return res.status(201).json({ profile });
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === "23505") {
      return res.status(409).json({ error: "email_taken" });
    }
    req.log.error(err);
    return res.status(500).json({ error: "server_error" });
  }
});

// ── POST /api/auth/verify-token — validate a Descope session token ───────────
router.post("/auth/verify-token", async (req, res) => {
  const { sessionToken } = req.body as { sessionToken?: string };
  if (!sessionToken) return res.status(400).json({ error: "token required" });

  try {
    const client = getDescopeClient();
    const authInfo = await client.validateSession(sessionToken);
    return res.json({ valid: true, userId: authInfo.token.sub });
  } catch {
    return res.status(401).json({ valid: false, error: "invalid_token" });
  }
});

// ── GET /api/auth/reset-password/open ─────────────────────────────────────────
// HTTPS bridge for password-reset emails on mobile. Descope appends ?t=&loginId=
// to the redirectUrl; this page immediately deep-links into the native app.
// Required because walkchamp.app may not have DNS yet — email clients need HTTPS.
const APP_DEEP_LINK_SCHEME = process.env.APP_DEEP_LINK_SCHEME ?? "globalwalkerleague";

router.get("/auth/reset-password/open", (req, res) => {
  const token = String(req.query.t ?? req.query.token ?? req.query.code ?? "").trim();
  const loginId = String(req.query.loginId ?? "").trim();

  const params = new URLSearchParams();
  if (token) params.set("t", token);
  if (loginId) params.set("loginId", loginId);
  const qs = params.toString();
  const deepLink = `${APP_DEEP_LINK_SCHEME}://reset-password${qs ? `?${qs}` : ""}`;

  const href = deepLink
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Walk Champ — Reset Password</title>
  <meta http-equiv="refresh" content="0;url=${href}" />
  <style>
    body { font-family: system-ui, sans-serif; background: #0A0B14; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; text-align: center; }
    a { color: #00E676; }
  </style>
</head>
<body>
  <div>
    <p>Opening Walk Champ…</p>
    <p><a href="${href}">Tap here if the app doesn’t open automatically</a></p>
  </div>
  <script>location.replace(${JSON.stringify(deepLink)});</script>
</body>
</html>`);
});

// ── POST /api/auth/reset-password/complete ───────────────────────────────────
// Completes the password reset flow entirely server-side:
//  1. Verifies the magic-link token from the reset email (needs DESCOPE_PROJECT_ID)
//  2. Extracts loginId from the verified session
//  3. Sets the new password via the Descope management API (needs DESCOPE_MANAGEMENT_KEY)
//
// This runs on the backend so we never need to expose the project ID or
// management key to the Expo web/native bundle.
const resetPasswordCompleteSchema = z.object({
  token: z.string().min(1, "token required"),
  newPassword: z.string().min(8, "password too short"),
});

router.post("/auth/reset-password/complete", async (req, res) => {
  const parse = resetPasswordCompleteSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "invalid_request", details: parse.error.issues });
  }
  const { token, newPassword } = parse.data;

  try {
    const client = getDescopeClient();

    // Step 1: verify the magic-link token from the reset email.
    // The Descope Node SDK uses the project ID from the environment — no
    // EXPO_PUBLIC_ prefix issues.
    const verifyResp = await client.magicLink.verify(token);
    if (!verifyResp.ok || !verifyResp.data) {
      req.log.warn({ code: verifyResp.code }, "Magic link verify failed");
      return res.status(401).json({ error: "token_invalid", message: verifyResp.error?.errorDescription ?? "Invalid or expired reset link" });
    }

    // Step 2: extract the loginId (email) from the verified user object.
    const loginIds: string[] = verifyResp.data.user?.loginIds ?? [];
    const loginId = loginIds[0] ?? verifyResp.data.user?.email ?? "";
    if (!loginId) {
      req.log.error("No loginId found in magic link verify response");
      return res.status(500).json({ error: "no_login_id", message: "Unable to identify account from reset link" });
    }

    // Step 3: set the new password via the Descope management API.
    // This uses the management key and works regardless of session state.
    await client.management.user.setActivePassword(loginId, newPassword);

    return res.json({ ok: true });
  } catch (err: unknown) {
    const e = err as { message?: string; code?: string };
    req.log.error({ err, code: e.code }, "reset-password/complete failed");
    // Surface a typed error so the frontend can show a meaningful message.
    if (e.message?.toLowerCase().includes("expired") || e.message?.toLowerCase().includes("used")) {
      return res.status(401).json({ error: "token_expired", message: "Reset link has expired. Please request a new one." });
    }
    return res.status(500).json({ error: "server_error", message: e.message ?? "Password reset failed" });
  }
});

// ── Apple identity-token verifier (Node built-in crypto.subtle, no extra deps) ─
// Apple signs identity JWTs with RS256. We fetch their public JWKS, pick the
// matching key by `kid`, and verify the signature with Web Crypto API.
interface AppleClaims {
  sub: string;
  email?: string;
  emailVerified?: boolean;
}
async function verifyAppleIdentityToken(token: string): Promise<AppleClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed Apple JWT");
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString()) as {
    kid?: string;
  };
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as {
    iss?: string; sub?: string; email?: string;
    email_verified?: boolean | string; exp?: number;
  };

  if (payload.iss !== "https://appleid.apple.com") throw new Error("Invalid Apple token issuer");
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Apple token expired");
  if (!payload.sub) throw new Error("Missing sub in Apple token");

  const keysRes = await fetch("https://appleid.apple.com/auth/keys");
  if (!keysRes.ok) throw new Error("Failed to fetch Apple public keys");
  const { keys } = (await keysRes.json()) as { keys: Array<Record<string, string>> };

  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("No matching Apple public key for kid=" + String(header.kid));

  // importKey's "jwk" overload uses the DOM-only JsonWebKey type which is not
  // in scope for a Node-only tsconfig. Cast the function to accept unknown args.
  const importKeyFn = crypto.subtle.importKey.bind(crypto.subtle) as (
    format: string, keyData: Record<string, string>, algorithm: object,
    extractable: boolean, keyUsages: string[],
  ) => Promise<CryptoKey>;
  const cryptoKey = await importKeyFn(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
  );

  const sigBuf = Buffer.from(sigB64, "base64url");
  const msgBuf = Buffer.from(`${headerB64}.${payloadB64}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, sigBuf, msgBuf);
  if (!valid) throw new Error("Apple token signature invalid");

  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
  };
}

// ── POST /api/auth/apple/native — verify Apple JWT, find/create Descope user, return session ──
// Replaces the old startNative/finishNative two-step (which required Apple
// native OAuth to be configured in Descope console). This approach verifies the
// Apple identityToken directly, then issues a Descope session via management API.
const appleNativeSchema = z.object({
  identityToken: z.string().min(1),
  authorizationCode: z.string().optional(),
  user: z
    .object({
      name: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
    })
    .optional(),
});

router.post("/auth/apple/native", async (req, res) => {
  const parse = appleNativeSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "invalid_request", details: parse.error.issues });
  }
  const { identityToken, user: appleUser } = parse.data;
  req.log.info("[AuthApple] native sign-in requested");

  try {
    // 1. Verify Apple identity token cryptographically
    let claims: AppleClaims;
    try {
      claims = await verifyAppleIdentityToken(identityToken);
    } catch (verifyErr: unknown) {
      req.log.warn({ err: verifyErr }, "[AuthApple] identity token verification failed");
      const msg = (verifyErr as Error).message ?? "Apple identity token is invalid";
      return res.status(401).json({ error: "invalid_token", message: msg });
    }
    const { sub: appleUserId, email, emailVerified } = claims;
    // Use email as loginId; Apple private-relay / missing email falls back to apple:<sub>
    const loginId = email || `apple:${appleUserId}`;
    req.log.info({ loginId, hasEmail: !!email }, "[AuthApple] token verified");

    const client = getDescopeClient();

    // 2. Find or create Descope user
    const existingUser = await client.management.user.load(loginId);
    if (!existingUser.ok) {
      const displayName = appleUser?.name ?? undefined;
      const createResp = await client.management.user.create(
        loginId,
        email ?? undefined,
        undefined,
        displayName ?? undefined,
        [],
        [],
        {},
        undefined,
        !!(emailVerified && email),
      );
      if (!createResp.ok) {
        const msg = createResp.error?.errorDescription ?? "Failed to create user account";
        req.log.warn({ descopeCode: createResp.code }, "[AuthApple] user creation failed");
        return res.status(502).json({ error: "user_create_failed", message: msg });
      }
      req.log.info({ loginId }, "[AuthApple] user created");
    } else {
      req.log.info({ loginId }, "[AuthApple] existing user found");
    }

    // 3. Generate an embedded link token (management API — no email sent to user)
    const linkResp = await client.management.user.generateEmbeddedLink(loginId);
    if (!linkResp.ok || !linkResp.data?.token) {
      const msg = linkResp.error?.errorDescription ?? "Unable to generate login token";
      req.log.warn({ descopeCode: linkResp.code }, "[AuthApple] generateEmbeddedLink failed");
      return res.status(502).json({ error: "link_failed", message: msg });
    }

    // 4. Exchange the embedded link token for a Descope session JWT
    const sessionResp = await client.magicLink.verify(linkResp.data.token);
    if (!sessionResp.ok || !sessionResp.data) {
      const msg = sessionResp.error?.errorDescription ?? "Unable to create session";
      req.log.warn({ descopeCode: sessionResp.code }, "[AuthApple] magicLink.verify failed");
      return res.status(502).json({ error: "session_failed", message: msg });
    }

    const { sessionJwt, refreshJwt, user: descopeUser } = sessionResp.data as {
      sessionJwt: string;
      refreshJwt?: string;
      user?: { userId?: string; loginIds?: string[]; name?: string; email?: string; verifiedEmail?: boolean };
    };
    req.log.info({ userId: descopeUser?.userId }, "[AuthApple] sign-in success");
    return res.json({
      sessionJwt,
      refreshJwt: refreshJwt ?? null,
      user: descopeUser
        ? {
            userId: descopeUser.userId,
            loginIds: descopeUser.loginIds ?? [],
            name: descopeUser.name ?? null,
            email: descopeUser.email ?? null,
            verifiedEmail: descopeUser.verifiedEmail ?? false,
          }
        : null,
    });
  } catch (err: unknown) {
    req.log.error(err, "[AuthApple] unexpected error");
    return res.status(500).json({ error: "server_error", message: "Unable to sign in with Apple." });
  }
});

// ── POST /api/auth/oauth/start — get the OAuth provider redirect URL ──────────
// The backend calls Descope (using the real DESCOPE_PROJECT_ID, never exposed
// to the frontend) and returns the URL to open in the browser. The redirectUrl
// is where Descope sends the user after successful authentication.
// Accepted Descope OAuth provider identifiers (must match OAuthProviders enum)
const DESCOPE_OAUTH_PROVIDERS = ["google", "apple"] as const;
type DescopeOAuthProvider = (typeof DESCOPE_OAUTH_PROVIDERS)[number];

// Accept both standard HTTP/HTTPS URLs and native deep-link schemes (e.g. globalwalkerleague://)
function isValidRedirectUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol.length > 0;
  } catch {
    return false;
  }
}

const oauthStartSchema = z.object({
  provider: z.enum(DESCOPE_OAUTH_PROVIDERS),
  redirectUrl: z.string().min(1, "redirectUrl required").refine(isValidRedirectUrl, {
    message: "Invalid redirect URL — must be a valid URL or deep-link scheme",
  }),
});

router.post("/auth/oauth/start", async (req, res) => {
  const parse = oauthStartSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "invalid_request", details: parse.error.issues });
  }
  const { provider, redirectUrl } = parse.data;
  req.log.info({ provider, redirectUrl }, "oauth/start: initiating");
  try {
    const client = getDescopeClient();
    const resp = await client.oauth.start(provider as DescopeOAuthProvider, redirectUrl, {});
    if (!resp.ok || !resp.data) {
      req.log.warn(
        { provider, descopeCode: resp.code, descopeError: resp.error },
        "oauth/start: Descope rejected the request",
      );
      const msg = resp.error?.errorDescription ?? "Unable to start sign-in";
      return res.status(502).json({ error: "oauth_start_failed", message: msg });
    }
    req.log.info({ provider }, "oauth/start: success");
    return res.json({ url: resp.data.url });
  } catch (err: unknown) {
    req.log.error(err, "oauth/start: unexpected error");
    return res.status(500).json({ error: "server_error", message: "Unable to start sign-in" });
  }
});

// ── POST /api/auth/password/signin — password login via Descope SDK ───────────
// Proxied through the backend so sessionJwt + refreshJwt are always returned in
// the JSON body. Direct mobile calls to Descope REST can miss refreshJwt when
// Descope sets it only as an HttpOnly cookie (invisible to React Native fetch).
const passwordSigninSchema = z.object({
  loginId: z.string().email(),
  password: z.string().min(1),
});

router.post("/auth/password/signin", async (req, res) => {
  const ip = req.ip ?? "unknown";
  if (!checkIpRateLimit(ip, 30, 60_000).allowed) {
    return res.status(429).json({ error: "rate_limited", message: "Too many sign-in attempts. Try again shortly." });
  }

  const parse = passwordSigninSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "invalid_request", details: parse.error.issues });
  }

  const { loginId, password } = parse.data;
  req.log.info({ loginId }, "[AuthPassword] sign-in requested");

  try {
    const client = getDescopeClient();
    const resp = await client.password.signIn(loginId, password);
    if (!resp.ok || !resp.data?.sessionJwt) {
      const msg = resp.error?.errorDescription ?? "Invalid email or password";
      req.log.warn({ descopeCode: resp.code }, "[AuthPassword] sign-in rejected");
      return res.status(401).json({ error: "signin_failed", message: msg });
    }

    const { sessionJwt, refreshJwt, user } = resp.data;
    if (!refreshJwt) {
      req.log.warn({ loginId }, "[AuthPassword] sign-in succeeded but Descope returned no refreshJwt");
    } else {
      req.log.info({ loginId }, "[AuthPassword] sign-in success — refresh token issued");
    }

    return res.json({
      sessionJwt,
      refreshJwt: refreshJwt ?? null,
      user: user
        ? {
            userId: user.userId,
            loginIds: user.loginIds ?? [],
            name: user.name ?? null,
            email: user.email ?? null,
            verifiedEmail: user.verifiedEmail ?? false,
          }
        : null,
    });
  } catch (err: unknown) {
    req.log.error(err, "[AuthPassword] unexpected error");
    return res.status(500).json({ error: "server_error", message: "Unable to sign in right now." });
  }
});

// ── POST /api/auth/session/refresh — exchange refresh JWT for new session ─────
const sessionRefreshSchema = z.object({
  refreshJwt: z.string().min(1),
});

router.post("/auth/session/refresh", async (req, res) => {
  const ip = req.ip ?? "unknown";
  if (!checkIpRateLimit(ip, 120, 60_000).allowed) {
    return res.status(429).json({ error: "rate_limited", message: "Too many refresh attempts." });
  }

  const parse = sessionRefreshSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "invalid_request", details: parse.error.issues });
  }

  const { refreshJwt } = parse.data;

  try {
    const client = getDescopeClient();
    const authInfo = await client.refreshSession(refreshJwt);
    const sessionJwt = authInfo.jwt;
    if (!sessionJwt) {
      req.log.warn("[AuthRefresh] Descope refresh returned no session JWT");
      return res.status(502).json({ error: "refresh_failed", message: "Unable to refresh session." });
    }

    return res.json({
      sessionJwt,
      // Rotation disabled in Descope → refreshJwt may be absent; client keeps existing.
      refreshJwt: authInfo.refreshJwt ?? refreshJwt,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Refresh rejected";
    req.log.warn({ err: msg }, "[AuthRefresh] refresh rejected by Descope");
    return res.status(401).json({ error: "refresh_failed", message: msg });
  }
});

// ── POST /api/auth/oauth/exchange — exchange OAuth code for a Descope session ─
// The frontend passes the ?code= from the OAuth callback URL. The backend
// exchanges it with Descope and returns a session JWT (never storing the OAuth
// provider tokens in the response or in NeonDB).
const oauthExchangeSchema = z.object({
  code: z.string().min(1, "code required"),
});

router.post("/auth/oauth/exchange", async (req, res) => {
  const parse = oauthExchangeSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "invalid_request", details: parse.error.issues });
  }
  const { code } = parse.data;
  req.log.info("oauth/exchange: exchanging authorization code");
  try {
    const client = getDescopeClient();
    const resp = await client.oauth.exchange(code);
    if (!resp.ok || !resp.data) {
      req.log.warn(
        { descopeCode: resp.code, descopeError: resp.error },
        "oauth/exchange: Descope rejected the code",
      );
      const msg = resp.error?.errorDescription ?? "Unable to complete sign-in";
      return res.status(401).json({ error: "exchange_failed", message: msg });
    }
    req.log.info("oauth/exchange: success");
    const { sessionJwt, refreshJwt, user } = resp.data;
    return res.json({
      sessionJwt,
      refreshJwt: refreshJwt ?? null,
      user: user
        ? {
            userId: user.userId,
            loginIds: user.loginIds ?? [],
            name: user.name ?? null,
            email: user.email ?? null,
            verifiedEmail: user.verifiedEmail ?? false,
          }
        : null,
    });
  } catch (err: unknown) {
    req.log.error(err, "oauth/exchange: unexpected error");
    return res.status(500).json({ error: "server_error", message: "Unable to complete sign-in" });
  }
});

export default router;
