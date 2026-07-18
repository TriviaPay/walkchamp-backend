import { type Request, type Response, type NextFunction } from "express";
import { getDescopeClient } from "../lib/descope.js";
import { config } from "../lib/config.js";
import { writeAuditLog } from "../lib/auditLog.js";
import {
  getSessionById,
  touchSession,
  extractDescopeSessionId,
  sessionErrorCodeForStatus,
  SESSION_STATUS,
  type SessionErrorCode,
  type DeviceInfo,
} from "../lib/sessionService.js";

export interface AuthenticatedRequest extends Request {
  descopeUserId: string;
  descopeEmail?: string;
  /** Best-effort provider session id from verified claims (may be null). */
  descopeSessionId?: string | null;
  /** Validated internal session id, when the client presented an active one. */
  sessionId?: string;
  /** Informational device metadata from request headers (never trusted for auth). */
  deviceInfo?: DeviceInfo;
}

const SESSION_ERROR_MESSAGES: Record<SessionErrorCode, string> = {
  SESSION_REPLACED: "This account was signed in on another device.",
  SESSION_INVALID: "This session is no longer valid. Please sign in again.",
  SESSION_REVOKED: "This session has been signed out. Please sign in again.",
  SESSION_EXPIRED: "This session has expired. Please sign in again.",
};

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

function deviceInfoFromHeaders(req: Request): DeviceInfo {
  return {
    deviceId: header(req, "x-device-id") ?? null,
    platform: header(req, "x-platform") ?? null,
    appVersion: header(req, "x-app-version") ?? null,
    buildNumber: header(req, "x-build-number") ?? null,
  };
}

/**
 * Validates the Descope session JWT and, when present, the internal single-active-session id.
 *
 * Enforcement is monitor-first (see config.auth.minSessionEnforceVersion):
 * - A client that presents `X-Session-Id` is validated strictly — a replaced/revoked/expired
 *   session is rejected with a machine-readable code.
 * - A client that presents none is allowed through, unless its `X-App-Version` is at/above the
 *   configured minimum (then it must present a valid active session).
 */
/**
 * Validates the Descope JWT and attaches identity/claims/device to the request. Does NOT run the
 * single-active-session gate. Returns the verified userId, or null after having already sent a
 * 401 response. Used directly by endpoints that must inspect session state themselves
 * (e.g. session status), and composed by `requireAuth`.
 */
async function attachAuth(req: Request, res: Response): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or malformed Authorization header" });
    return null;
  }

  const token = authHeader.slice(7);
  if (!token) {
    res.status(401).json({ error: "Empty token" });
    return null;
  }

  try {
    const client = getDescopeClient();
    const authInfo = await client.validateSession(token);
    const claims = authInfo.token as Record<string, unknown>;

    const userId = authInfo.token.sub as string;
    const authReq = req as AuthenticatedRequest;
    authReq.descopeUserId = userId;
    authReq.descopeEmail = (claims.email ?? "") as string;
    authReq.descopeSessionId = extractDescopeSessionId(claims);
    authReq.deviceInfo = deviceInfoFromHeaders(req);
    return userId;
  } catch {
    res.status(401).json({ error: "Invalid or expired session token" });
    return null;
  }
}

/** JWT-only authentication (no single-session gate). */
export async function requireJwtOnly(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = await attachAuth(req, res);
  if (userId) next();
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = await attachAuth(req, res);
  if (!userId) return;

  // ── Single active session gate (monitor-first) ──────────────────────────────
  const sessionId = header(req, "x-session-id");

  if (sessionId) {
    const session = await getSessionById(sessionId);
    if (!session || session.userId !== userId) {
      rejectSession(req, res, userId, sessionId, "SESSION_INVALID");
      return;
    }
    if (session.status !== SESSION_STATUS.ACTIVE) {
      rejectSession(req, res, userId, sessionId, sessionErrorCodeForStatus(session.status));
      return;
    }
    (req as AuthenticatedRequest).sessionId = sessionId;
    touchSession(sessionId);
    next();
    return;
  }

  // No session id presented. Fail open unless the client's version is known to support it.
  const min = config.auth.minSessionEnforceVersion;
  const appVersion = header(req, "x-app-version");
  if (min && appVersion && compareAppVersions(appVersion, min) >= 0) {
    rejectSession(req, res, userId, null, "SESSION_INVALID");
    return;
  }

  next();
}

function rejectSession(
  req: Request,
  res: Response,
  userId: string,
  sessionId: string | null,
  code: SessionErrorCode,
): void {
  void writeAuditLog({
    actorUserId: userId,
    actorType: "user",
    action: "invalid_session_request",
    entityType: "session",
    entityId: sessionId,
    reason: code,
    metadata: { path: req.path },
  });
  res.status(401).json({ code, message: SESSION_ERROR_MESSAGES[code] });
}
