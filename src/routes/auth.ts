import { Router, type Request, type Response } from "express";
import { db } from "../../db/src/index.js";
import { profilesTable, walletsTable } from "../../db/src/schema/index.js";
import { eq } from "drizzle-orm";
import { getDescopeClient } from "../lib/descope.js";
import { requireAuth, requireJwtOnly, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import { parseAndValidateDob } from "../lib/dateOfBirth.js";
import { config } from "../lib/config.js";
import {
  registerOrReplaceSession,
  revokeSession,
  resumeSession,
  type SessionErrorCode,
  type DeviceInfo,
} from "../lib/sessionService.js";
import { z } from "zod";

const SESSION_STATUS_MESSAGES: Record<SessionErrorCode, string> = {
  SESSION_REPLACED: "This account was signed in on another device.",
  SESSION_INVALID: "This session is no longer valid. Please sign in again.",
  SESSION_REVOKED: "This session has been signed out. Please sign in again.",
  SESSION_EXPIRED: "This session has expired. Please sign in again.",
};

const router = Router();

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

function getExpectedAppleAudiences(): Set<string> {
  const raw = process.env.APPLE_EXPECTED_AUDIENCES?.trim();
  const values = raw
    ? raw.split(",").map((value) => value.trim()).filter(Boolean)
    : ["com.globalwalkerleague.app"];
  return new Set(values);
}

// ── GET /api/me — authenticated: return profile for the JWT owner ─────────────
// Resume/read hook. JWT-only (bootstrap-safe: reachable before a session exists), and pure
// resume — it never registers a session, so a superseded device that calls /me cannot resurrect
// itself. When the client presents X-Session-Id we report its live status alongside the profile.
// Registration happens via POST /auth/session/register after a successful login.
router.get("/me", requireJwtOnly, async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.descopeUserId;

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

  // Report (do not mutate) session status when the client presented one.
  const presentedSessionId = sessionIdFromRequest(req);
  if (presentedSessionId) {
    const status = await resumeSession(presentedSessionId, userId);
    if (status.active) {
      return res.json({
        profile,
        session: {
          active: true,
          sessionId: status.session.sessionId,
          sessionGeneration: status.session.sessionGeneration,
        },
      });
    }
    return res.json({ profile, session: { active: false, code: status.code } });
  }
  return res.json({ profile });
});

// ── Session endpoints (single active session) ────────────────────────────────
function deviceFromRequest(req: AuthenticatedRequest): DeviceInfo {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const headerDevice = req.deviceInfo ?? {};
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    deviceId: str(body.deviceId) ?? headerDevice.deviceId ?? null,
    platform: str(body.platform) ?? headerDevice.platform ?? null,
    appVersion: str(body.appVersion) ?? headerDevice.appVersion ?? null,
    buildNumber: str(body.buildNumber) ?? headerDevice.buildNumber ?? null,
    deviceModel: str(body.deviceModel),
    manufacturer: str(body.manufacturer),
    osName: str(body.osName),
    osVersion: str(body.osVersion),
    androidApiLevel: typeof body.androidApiLevel === "number" ? body.androidApiLevel : str(body.androidApiLevel),
    clientSessionId: str(body.clientSessionId),
  };
}

function sessionIdFromRequest(req: Request): string | undefined {
  const h = req.headers["x-session-id"];
  const headerSid = Array.isArray(h) ? h[0] : h;
  if (headerSid) return headerSid;
  const body = (req.body ?? {}) as { sessionId?: unknown; clientSessionId?: unknown };
  if (typeof body.sessionId === "string") return body.sessionId;
  if (typeof body.clientSessionId === "string") return body.clientSessionId;
  return undefined;
}

/** Numeric-tuple version compare (e.g. "1.5.0" vs "1.10.2"). Non-numeric parts count as 0. */
function compareAppVersions(a: string, b: string): number {
  const pa = a.split(".").map((p) => parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => parseInt(p, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function sessionIdRequiredForRequest(req: Request): boolean {
  const min = config.auth.minSessionEnforceVersion;
  const rawAppVersion = req.headers["x-app-version"];
  const appVersion = Array.isArray(rawAppVersion) ? rawAppVersion[0] : rawAppVersion;
  return Boolean(min && appVersion && compareAppVersions(appVersion, min) >= 0);
}

// Login hook: call after any successful authentication (including client-side OTP/social flows).
// JWT-only so it is reachable before the client holds a session id (avoids a bootstrap deadlock
// once the enforcement version gate is enabled).
router.post("/auth/session/register", requireJwtOnly, async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const result = await registerOrReplaceSession({
    userId: authReq.descopeUserId,
    descopeSessionId: authReq.descopeSessionId ?? null,
    device: deviceFromRequest(authReq),
    currentSessionId: sessionIdFromRequest(req) ?? null,
  });
  if (!result) return res.status(404).json({ error: "profile_required" });
  return res.json({
    sessionId: result.sessionId,
    sessionGeneration: result.sessionGeneration,
    replaced: result.replaced,
    createdAt: result.createdAt,
  });
});

const refreshSessionSchema = z.object({
  refreshJwt: z.string().trim().min(1).optional(),
  refreshToken: z.string().trim().min(1).optional(),
}).refine((value) => Boolean(value.refreshJwt || value.refreshToken), {
  message: "refreshJwt required",
  path: ["refreshJwt"],
});

// Refresh a short-lived Descope session JWT. This endpoint deliberately does not create or replace
// the backend single-active-session row; it only exchanges a valid refresh token for fresh JWTs.
router.post("/auth/session/refresh", async (req, res) => {
  const parsed = refreshSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  }

  const refreshToken = parsed.data.refreshJwt ?? parsed.data.refreshToken!;

  try {
    const client = getDescopeClient();
    const refreshed = await client.refreshSession(refreshToken);
    const sessionJwt = refreshed.jwt;
    const refreshJwt = refreshed.refreshJwt ?? null;
    const userId = typeof refreshed.token.sub === "string" ? refreshed.token.sub : null;
    const email = typeof refreshed.token.email === "string" ? refreshed.token.email : null;

    return res.json({
      sessionJwt,
      refreshJwt,
      user: userId
        ? {
            userId,
            loginIds: email ? [email] : [],
            name: typeof refreshed.token.name === "string" ? refreshed.token.name : null,
            email,
            verifiedEmail: Boolean(refreshed.token.email_verified),
          }
        : null,
    });
  } catch (err) {
    req.log.warn({ err }, "auth/session/refresh failed");
    return res.status(401).json({
      error: "invalid_refresh_token",
      message: "Refresh token is invalid or expired.",
    });
  }
});

// Fast app-resume check. JWT-only so a replaced session gets a 200 status body rather than being
// blocked by the session gate. Accepts GET (X-Session-Id header) or POST ({ sessionId } body).
async function sessionStatusHandler(req: Request, res: Response) {
  const authReq = req as AuthenticatedRequest;
  const sid = sessionIdFromRequest(req);
  if (!sid) {
    if (sessionIdRequiredForRequest(req)) {
      return res.json({ active: false, code: "SESSION_INVALID", message: SESSION_STATUS_MESSAGES.SESSION_INVALID });
    }
    return res.json({
      active: true,
      sessionRequired: false,
      code: "SESSION_NOT_PRESENT",
      message: "No backend session id presented; continuing in monitor mode.",
    });
  }
  const status = await resumeSession(sid, authReq.descopeUserId);
  if (!status.active) {
    return res.json({ active: false, code: status.code, message: SESSION_STATUS_MESSAGES[status.code] });
  }
  return res.json({
    active: true,
    sessionId: status.session.sessionId,
    sessionGeneration: status.session.sessionGeneration,
    createdAt: status.session.createdAt,
  });
}
router.get("/auth/session/status", requireJwtOnly, sessionStatusHandler);
router.post("/auth/session/status", requireJwtOnly, sessionStatusHandler);

// Logout of the current session. Idempotent; JWT-only so an already-replaced session can still
// clean itself up.
router.post("/auth/session/revoke-current", requireJwtOnly, async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const sid = sessionIdFromRequest(req);
  if (!sid) return res.json({ ok: true });
  const result = await revokeSession(sid, authReq.descopeUserId, "logout");
  return res.json({ ok: result.ok });
});

// ── GET /api/auth/username-check?username=xxx ────────────────────────────────
router.get("/auth/username-check", async (req, res) => {
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

// JWT-only: onboarding runs before the client holds a session id.
router.post("/auth/profile", requireJwtOnly, async (req, res) => {
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

  const dob = parseAndValidateDob(data.dateOfBirth);
  if (!dob.ok) {
    return res.status(400).json({ error: "invalid_date_of_birth", message: dob.message });
  }
  const age = dob.age;
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
        dateOfBirth: dob.normalized,
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
        profileCompleted: true,
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

// ── GET /api/auth/profile/:userId — authenticated self profile restore ────────
router.get("/auth/profile/:userId", requireAuth, async (req, res) => {
  const { userId } = req.params;
  const authUserId = (req as AuthenticatedRequest).descopeUserId;

  if (userId !== authUserId) {
    return res.status(403).json({ error: "Forbidden" });
  }

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

// JWT-only: onboarding runs before the client holds a session id.
router.post("/auth/complete-signup", requireJwtOnly, async (req, res) => {
  const authUserId = (req as AuthenticatedRequest).descopeUserId;

  const parse = completeSignupSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid data", details: parse.error.issues });
  }
  const data = parse.data;

  // Validate DOB before any side effects (e.g. setting the Descope password).
  const dob = parseAndValidateDob(data.dateOfBirth);
  if (!dob.ok) {
    return res.status(400).json({ error: "invalid_date_of_birth", message: dob.message });
  }

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

  const age = dob.age;
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
          dateOfBirth: dob.normalized,
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

// ── POST /api/auth/password/signin — password login via Descope ───────────────
// Compatibility endpoint for clients that route password login through the API.
// Password verification and session creation remain entirely in Descope.
const passwordSigninSchema = z.object({
  loginId: z.string().trim().min(1).optional(),
  email: z.string().trim().min(1).optional(),
  password: z.string().min(1),
}).refine((value) => Boolean(value.loginId || value.email), {
  message: "loginId required",
  path: ["loginId"],
});

router.post("/auth/password/signin", async (req, res) => {
  const parse = passwordSigninSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "invalid_request", details: parse.error.issues });
  }

  const loginId = (parse.data.loginId ?? parse.data.email ?? "").trim();

  try {
    const client = getDescopeClient();
    const signInResult = await client.password.signIn(loginId, parse.data.password);
    if (!signInResult.ok || !signInResult.data) {
      req.log.warn({ descopeCode: signInResult.code }, "password/signin: Descope rejected credentials");
      return res.status(401).json({
        error: "invalid_credentials",
        message: signInResult.error?.errorDescription ?? "Invalid login credentials",
      });
    }

    const { sessionJwt, refreshJwt, user } = signInResult.data as {
      sessionJwt: string;
      refreshJwt?: string;
      user?: { userId?: string; loginIds?: string[]; name?: string; email?: string; verifiedEmail?: boolean };
    };

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
  } catch (err) {
    req.log.error({ err }, "password/signin failed");
    return res.status(502).json({ error: "descope_unavailable", message: "Unable to sign in right now" });
  }
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
  aud: string | string[];
  nonce?: string;
}
async function verifyAppleIdentityToken(token: string, expectedAudiences: Set<string>, expectedNonce?: string): Promise<AppleClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed Apple JWT");
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString()) as {
    kid?: string;
  };
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as {
    iss?: string; sub?: string; email?: string;
    email_verified?: boolean | string; exp?: number;
    aud?: string | string[];
    nonce?: string;
  };

  if (payload.iss !== "https://appleid.apple.com") throw new Error("Invalid Apple token issuer");
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Apple token expired");
  if (!payload.sub) throw new Error("Missing sub in Apple token");
  const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (audiences.length === 0 || !audiences.some((audience) => expectedAudiences.has(audience))) {
    throw new Error("Apple token audience mismatch");
  }
  if (expectedNonce && payload.nonce !== expectedNonce) {
    throw new Error("Apple token nonce mismatch");
  }

  const keysRes = await fetch("https://appleid.apple.com/auth/keys") as {
    ok: boolean;
    json(): Promise<unknown>;
  };
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
    aud: payload.aud ?? audiences[0] ?? "",
    nonce: payload.nonce,
  };
}

// ── POST /api/auth/apple/native — verify Apple JWT, find/create Descope user, return session ──
// Replaces the old startNative/finishNative two-step (which required Apple
// native OAuth to be configured in Descope console). This approach verifies the
// Apple identityToken directly, then issues a Descope session via management API.
const appleNativeSchema = z.object({
  identityToken: z.string().min(1),
  authorizationCode: z.string().optional(),
  nonce: z.string().optional(),
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
  const { identityToken, nonce, user: appleUser } = parse.data;
  req.log.info("[AuthApple] native sign-in requested");

  try {
    // 1. Verify Apple identity token cryptographically
    let claims: AppleClaims;
    try {
      claims = await verifyAppleIdentityToken(identityToken, getExpectedAppleAudiences(), nonce);
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
