/**
 * requireAuth — single active session gate (monitor-first).
 *
 * A client that presents X-Session-Id is validated strictly (replaced/revoked/expired → rejected
 * with a machine code). A client that presents none is allowed through unless its X-App-Version is
 * at/above config.auth.minSessionEnforceVersion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { SESSION_STATUS } from "../lib/sessionService";
import { config } from "../lib/config";

// config is exported `as const` (readonly types); mutate through a mutable view for the version gate.
function setMinEnforceVersion(v: string | null) {
  (config.auth as { minSessionEnforceVersion: string | null }).minSessionEnforceVersion = v;
}

const { mockValidateSession, mockGetSessionById } = vi.hoisted(() => ({
  mockValidateSession: vi.fn(),
  mockGetSessionById: vi.fn(),
}));

vi.mock("../lib/descope", () => ({
  getDescopeClient: () => ({ validateSession: mockValidateSession }),
}));

vi.mock("../lib/sessionService", async (importActual) => {
  const actual = await importActual<typeof import("../lib/sessionService")>();
  return { ...actual, getSessionById: mockGetSessionById, touchSession: vi.fn() };
});

// Audit writes go to the DB; stub so rejection paths don't attempt a connection.
vi.mock("../lib/auditLog", () => ({ writeAuditLog: vi.fn().mockResolvedValue(undefined) }));

import { requireAuth } from "../middleware/requireAuth";

const USER = "user_1";

beforeEach(() => {
  mockValidateSession.mockResolvedValue({ token: { sub: USER, email: "u@example.com" } });
  mockGetSessionById.mockReset();
  setMinEnforceVersion(null);
});
afterEach(() => {
  setMinEnforceVersion(null);
});

function ctx(headers: Record<string, string>) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const req = { headers: { authorization: "Bearer valid.jwt", ...headers }, path: "/api/x" } as unknown as Request;
  const res = { status, json } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next, status, json };
}

describe("requireAuth session gate — with X-Session-Id", () => {
  it("passes an active session belonging to the user and attaches sessionId", async () => {
    mockGetSessionById.mockResolvedValue({
      sessionId: "sid_active",
      userId: USER,
      status: SESSION_STATUS.ACTIVE,
      sessionGeneration: 3,
    });
    const { req, res, next, status } = ctx({ "x-session-id": "sid_active" });

    await requireAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
    expect((req as Request & { sessionId?: string }).sessionId).toBe("sid_active");
  });

  it("rejects a replaced session with SESSION_REPLACED", async () => {
    mockGetSessionById.mockResolvedValue({
      sessionId: "sid_old",
      userId: USER,
      status: SESSION_STATUS.REPLACED,
      sessionGeneration: 2,
    });
    const { req, res, next, status, json } = ctx({ "x-session-id": "sid_old" });

    await requireAuth(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: "SESSION_REPLACED" }));
    expect(next).not.toHaveBeenCalled();
  });

  it("maps logged_out/revoked to SESSION_REVOKED and expired to SESSION_EXPIRED", async () => {
    mockGetSessionById.mockResolvedValueOnce({ sessionId: "s", userId: USER, status: SESSION_STATUS.LOGGED_OUT });
    let c = ctx({ "x-session-id": "s" });
    await requireAuth(c.req, c.res, c.next);
    expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ code: "SESSION_REVOKED" }));

    mockGetSessionById.mockResolvedValueOnce({ sessionId: "s", userId: USER, status: SESSION_STATUS.EXPIRED });
    c = ctx({ "x-session-id": "s" });
    await requireAuth(c.req, c.res, c.next);
    expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ code: "SESSION_EXPIRED" }));
  });

  it("rejects a session owned by a different user (cannot cross accounts)", async () => {
    mockGetSessionById.mockResolvedValue({
      sessionId: "sid_other",
      userId: "user_2",
      status: SESSION_STATUS.ACTIVE,
    });
    const { req, res, next, json } = ctx({ "x-session-id": "sid_other" });

    await requireAuth(req, res, next);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: "SESSION_INVALID" }));
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects an unknown session id with SESSION_INVALID", async () => {
    mockGetSessionById.mockResolvedValue(undefined);
    const { req, res, next, json } = ctx({ "x-session-id": "nope" });

    await requireAuth(req, res, next);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: "SESSION_INVALID" }));
    expect(next).not.toHaveBeenCalled();
  });
});

describe("requireAuth session gate — monitor-first (no X-Session-Id)", () => {
  it("fails open when no enforcement version is configured", async () => {
    const { req, res, next, status } = ctx({});
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
    expect(mockGetSessionById).not.toHaveBeenCalled();
  });

  it("rejects a supporting version (>= min) that sends no session id", async () => {
    setMinEnforceVersion("1.5.0");
    const { req, res, next, json } = ctx({ "x-app-version": "1.5.0" });
    await requireAuth(req, res, next);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: "SESSION_INVALID" }));
    expect(next).not.toHaveBeenCalled();
  });

  it("allows an older version (< min) that sends no session id", async () => {
    setMinEnforceVersion("1.5.0");
    const { req, res, next, status } = ctx({ "x-app-version": "1.4.9" });
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it("fails open when the version header is absent (cannot prove support)", async () => {
    setMinEnforceVersion("1.5.0");
    const { req, res, next, status } = ctx({});
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });
});
