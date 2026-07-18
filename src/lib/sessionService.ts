import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import { authSessionsTable, profilesTable } from "../../db/src/schema/index.js";
import type { AuthSession } from "../../db/src/schema/index.js";
import { writeAuditLog } from "./auditLog.js";
import { triggerEvent } from "./pusher.js";
import { logger } from "./logger.js";

export const SESSION_STATUS = {
  ACTIVE: "active",
  REPLACED: "replaced",
  LOGGED_OUT: "logged_out",
  EXPIRED: "expired",
  REVOKED: "revoked",
} as const;

export type SessionErrorCode = "SESSION_REPLACED" | "SESSION_INVALID" | "SESSION_REVOKED" | "SESSION_EXPIRED";

/** Maps a stored session status to the machine-readable rejection code. Shared by middleware + routes. */
export function sessionErrorCodeForStatus(status: string): SessionErrorCode {
  switch (status) {
    case SESSION_STATUS.REPLACED:
      return "SESSION_REPLACED";
    case SESSION_STATUS.EXPIRED:
      return "SESSION_EXPIRED";
    case SESSION_STATUS.REVOKED:
    case SESSION_STATUS.LOGGED_OUT:
      return "SESSION_REVOKED";
    default:
      return "SESSION_INVALID";
  }
}

export type DeviceInfo = {
  deviceId?: string | null;
  platform?: string | null;
  appVersion?: string | null;
  buildNumber?: string | null;
  // Extended, open-ended device metadata stored in the session's `metadata` jsonb column.
  deviceModel?: string | null;
  manufacturer?: string | null;
  osName?: string | null;
  osVersion?: string | null;
  androidApiLevel?: string | number | null;
  clientSessionId?: string | null;
};

export type RegisterSessionResult = {
  sessionId: string;
  sessionGeneration: number;
  replaced: boolean;
  replacedSessionId: string | null;
  createdAt: Date;
};

export type SessionStatusResult =
  | { active: true; session: AuthSession }
  | { active: false; code: SessionErrorCode };

/** High-entropy, non-sequential internal session id echoed back by the client. */
export function generateSessionId(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Best-effort extraction of the provider session id from verified JWT claims. Correctness never
 * depends on this — the internal sessionId is authoritative. Returns null if no candidate claim
 * is present. (The exact Descope claim name is unconfirmed; we tolerate several.)
 */
export function extractDescopeSessionId(claims: Record<string, unknown> | undefined | null): string | null {
  if (!claims) return null;
  for (const key of ["sid", "sessionId", "session_id", "dsr"]) {
    const value = claims[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/** Collects the open-ended device fields (everything not stored in dedicated columns). */
function metadataFromDevice(device: DeviceInfo): Record<string, unknown> | null {
  const meta: Record<string, unknown> = {};
  if (device.deviceModel) meta.deviceModel = device.deviceModel;
  if (device.manufacturer) meta.manufacturer = device.manufacturer;
  if (device.osName) meta.osName = device.osName;
  if (device.osVersion) meta.osVersion = device.osVersion;
  if (device.androidApiLevel != null) meta.androidApiLevel = device.androidApiLevel;
  if (device.clientSessionId) meta.clientSessionId = device.clientSessionId;
  return Object.keys(meta).length > 0 ? meta : null;
}

/**
 * Registers/reconciles a session for `userId`. This is the LOGIN hook (call it after a successful
 * authentication) — not a per-request touch. It is idempotent in two ways so retries and
 * same-device re-logins never self-kick:
 *  1. Resume: the caller already holds the active session (`currentSessionId` matches) → touch.
 *  2. Same device: the active session has the same `deviceId` → refresh it in place (no replace,
 *     no invalidation event). Using deviceId (not the unreliable provider claim) as the
 *     same-device signal is deliberate; a genuinely different device has a different deviceId and
 *     is correctly replaced. deviceId is informational and never an auth decision — single-session
 *     uniqueness is still enforced by the DB partial unique index.
 *
 * A different device replaces the current active session transactionally. The per-user row lock
 * serializes concurrent logins; the partial unique index on (user_id) WHERE status='active' is the
 * final authority, with one retry on conflict (last login wins).
 *
 * Returns null when the user has no profile yet.
 */
export async function registerOrReplaceSession(params: {
  userId: string;
  descopeSessionId?: string | null;
  device?: DeviceInfo;
  currentSessionId?: string | null;
}): Promise<RegisterSessionResult | null> {
  const { userId, descopeSessionId = null, device = {}, currentSessionId = null } = params;
  const metadata = metadataFromDevice(device);

  const runTx = async (): Promise<RegisterSessionResult | null> =>
    db.transaction(async (tx) => {
      const [profile] = await tx
        .select({ id: profilesTable.id })
        .from(profilesTable)
        .where(eq(profilesTable.id, userId))
        .limit(1)
        .for("update");
      if (!profile) return null;

      const [active] = await tx
        .select()
        .from(authSessionsTable)
        .where(and(eq(authSessionsTable.userId, userId), eq(authSessionsTable.status, SESSION_STATUS.ACTIVE)))
        .limit(1);

      // (1) Resume: caller already holds the active session.
      // (2) Same device: refresh in place (deviceId is the same-device signal).
      const sameSession = active && currentSessionId && active.sessionId === currentSessionId;
      const sameDevice = active && device.deviceId && active.deviceId === device.deviceId;
      if (sameSession || sameDevice) {
        await tx
          .update(authSessionsTable)
          .set({
            lastSeenAt: new Date(),
            ...(descopeSessionId ? { descopeSessionId } : {}),
            ...(metadata ? { metadata } : {}),
            ...(device.appVersion ? { appVersion: device.appVersion } : {}),
            ...(device.buildNumber ? { buildNumber: device.buildNumber } : {}),
          })
          .where(eq(authSessionsTable.id, active.id));
        return {
          sessionId: active.sessionId,
          sessionGeneration: active.sessionGeneration,
          replaced: false,
          replacedSessionId: null,
          createdAt: active.createdAt,
        };
      }

      const newSessionId = generateSessionId();
      const newGeneration = (active?.sessionGeneration ?? 0) + 1;

      if (active) {
        await tx
          .update(authSessionsTable)
          .set({
            status: SESSION_STATUS.REPLACED,
            invalidatedAt: new Date(),
            invalidationReason: "login_on_new_device",
            replacedBySessionId: newSessionId,
          })
          .where(and(eq(authSessionsTable.id, active.id), eq(authSessionsTable.status, SESSION_STATUS.ACTIVE)));
      }

      const [created] = await tx
        .insert(authSessionsTable)
        .values({
          userId,
          sessionId: newSessionId,
          sessionGeneration: newGeneration,
          descopeSessionId: descopeSessionId ?? null,
          deviceId: device.deviceId ?? null,
          platform: device.platform ?? null,
          appVersion: device.appVersion ?? null,
          buildNumber: device.buildNumber ?? null,
          metadata,
          status: SESSION_STATUS.ACTIVE,
        })
        .returning();

      return {
        sessionId: created.sessionId,
        sessionGeneration: created.sessionGeneration,
        replaced: !!active,
        replacedSessionId: active?.sessionId ?? null,
        createdAt: created.createdAt,
      };
    });

  let result: RegisterSessionResult | null = null;
  try {
    result = await runTx();
  } catch (err) {
    // Rare: a concurrent login won the unique-active race. Retry once; the loser now sees the
    // winner as the active session and replaces it deterministically (last login wins).
    if (isUniqueViolation(err)) {
      result = await runTx();
    } else {
      throw err;
    }
  }

  if (!result) return null;

  void writeAuditLog({
    actorUserId: userId,
    actorType: "user",
    action: result.replaced ? "session_replaced" : "session_created",
    entityType: "session",
    entityId: result.sessionId,
    metadata: {
      platform: device.platform ?? null,
      appVersion: device.appVersion ?? null,
      replacedSessionId: result.replacedSessionId,
    },
  });

  if (result.replaced && result.replacedSessionId) {
    publishInvalidation(userId, result.replacedSessionId);
  }

  return result;
}

/**
 * Best-effort realtime nudge so the superseded device can react fast. Emitted to both the
 * session-scoped channel (old device subscribes to its own session while active) and the user
 * channel (carrying the old sessionId so other devices can ignore it). Security is enforced at the
 * API boundary regardless of delivery.
 */
function publishInvalidation(userId: string, oldSessionId: string): void {
  const payload = {
    type: "session_invalidated",
    reason: "login_on_new_device",
    sessionId: oldSessionId,
    message: "Your account was signed in on another device.",
  };
  void triggerEvent(`private-session-${oldSessionId}`, "session-invalidated", payload);
  void triggerEvent(`private-user-${userId}`, "session-invalidated", payload);
}

/** Bump last-seen for an active session. Fire-and-forget. */
export function touchSession(sessionId: string): void {
  db.update(authSessionsTable)
    .set({ lastSeenAt: new Date() })
    .where(and(eq(authSessionsTable.sessionId, sessionId), eq(authSessionsTable.status, SESSION_STATUS.ACTIVE)))
    .catch((err) => logger.error({ err }, "[Session] touch failed"));
}

export async function getSessionById(sessionId: string): Promise<AuthSession | undefined> {
  const [row] = await db
    .select()
    .from(authSessionsTable)
    .where(eq(authSessionsTable.sessionId, sessionId))
    .limit(1);
  return row;
}

/**
 * Resume/status check for a presented session id — never creates or replaces anything. Used by
 * /me and the session-status endpoint so a superseded device is told it lost without being able
 * to resurrect itself.
 */
export async function resumeSession(sessionId: string, userId: string): Promise<SessionStatusResult> {
  const session = await getSessionById(sessionId);
  if (!session || session.userId !== userId) return { active: false, code: "SESSION_INVALID" };
  if (session.status !== SESSION_STATUS.ACTIVE) {
    return { active: false, code: sessionErrorCodeForStatus(session.status) };
  }
  touchSession(sessionId);
  return { active: true, session };
}

/**
 * Marks the caller's current session logged_out. Idempotent: a session that is already
 * replaced/logged_out/revoked is left as-is (never reactivated) and reported as success.
 */
export async function revokeSession(
  sessionId: string,
  userId: string,
  reason = "logout",
): Promise<{ ok: boolean; alreadyInactive: boolean }> {
  const [row] = await db
    .select()
    .from(authSessionsTable)
    .where(and(eq(authSessionsTable.sessionId, sessionId), eq(authSessionsTable.userId, userId)))
    .limit(1);

  if (!row) return { ok: true, alreadyInactive: true };
  if (row.status !== SESSION_STATUS.ACTIVE) return { ok: true, alreadyInactive: true };

  await db
    .update(authSessionsTable)
    .set({
      status: SESSION_STATUS.LOGGED_OUT,
      invalidatedAt: new Date(),
      invalidationReason: reason,
    })
    .where(and(eq(authSessionsTable.id, row.id), eq(authSessionsTable.status, SESSION_STATUS.ACTIVE)));

  void writeAuditLog({
    actorUserId: userId,
    actorType: "user",
    action: "session_logged_out",
    entityType: "session",
    entityId: sessionId,
    reason,
  });

  return { ok: true, alreadyInactive: false };
}
