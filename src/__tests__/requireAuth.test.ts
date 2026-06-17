/**
 * requireAuth middleware — header validation tests.
 *
 * Tests the early-exit guards (missing header, malformed prefix, empty token)
 * and the "Descope rejects / accepts token" paths via a hoisted module mock.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

// ── Mock Descope client ────────────────────────────────────────────────────────
// Hoist a shared spy so individual tests can change the resolved / rejected value.
const mockValidateSession = vi.fn();

vi.mock("../lib/descope", () => ({
  getDescopeClient: () => ({ validateSession: mockValidateSession }),
}));

import { requireAuth } from "../middleware/requireAuth";

// Default: Descope rejects every token (most tests need this behaviour).
beforeEach(() => {
  mockValidateSession.mockRejectedValue(new Error("Simulated Descope rejection"));
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Creates a minimal Express mock triple.
 * `res.status()` returns `{ json }` so chaining works:
 *   res.status(401).json(...)
 */
function mockContext(authHeader?: string) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const req = {
    headers: authHeader !== undefined ? { authorization: authHeader } : {},
  } as unknown as Request;
  const res = { status, json } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next, status, json };
}

// ── Missing / malformed header ────────────────────────────────────────────────

describe("requireAuth — missing or malformed Authorization header", () => {
  it("returns 401 when Authorization header is absent", async () => {
    const { req, res, next, status, json } = mockContext();

    await requireAuth(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      error: "Missing or malformed Authorization header",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header uses Basic scheme", async () => {
    const { req, res, next, status, json } = mockContext("Basic dXNlcjpwYXNz");

    await requireAuth(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      error: "Missing or malformed Authorization header",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header is 'bearer' (lowercase)", async () => {
    const { req, res, next, status } = mockContext("bearer sometoken");

    await requireAuth(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header is an empty string", async () => {
    const { req, res, next, status } = mockContext("");

    await requireAuth(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// ── Empty token ───────────────────────────────────────────────────────────────

describe("requireAuth — empty token after Bearer prefix", () => {
  it("returns 401 for 'Bearer ' with no token (trailing space only)", async () => {
    const { req, res, next, status, json } = mockContext("Bearer ");

    await requireAuth(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "Empty token" });
    expect(next).not.toHaveBeenCalled();
  });
});

// ── Descope validation failure ─────────────────────────────────────────────────

describe("requireAuth — Descope validation failure", () => {
  it("returns 401 when Descope rejects the token", async () => {
    const { req, res, next, status, json } = mockContext(
      "Bearer invalid.jwt.token",
    );

    await requireAuth(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      error: "Invalid or expired session token",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("does not call next() on invalid token", async () => {
    const { req, res, next } = mockContext("Bearer expired.jwt.here");

    await requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
  });
});

// ── Valid token — next() is invoked ───────────────────────────────────────────

describe("requireAuth — valid token", () => {
  it("calls next() when Descope accepts the token", async () => {
    mockValidateSession.mockResolvedValueOnce({
      token: { sub: "user_abc123", email: "test@example.com" },
    });

    const { req, res, next } = mockContext("Bearer valid.jwt.token");

    await requireAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("does NOT call status(401) on a valid token", async () => {
    mockValidateSession.mockResolvedValueOnce({
      token: { sub: "user_abc123", email: "test@example.com" },
    });

    const { req, res, next, status } = mockContext("Bearer valid.jwt.token");

    await requireAuth(req, res, next);

    expect(status).not.toHaveBeenCalled();
  });

  it("attaches descopeUserId to the request from the JWT sub claim", async () => {
    const FAKE_USER_ID = "user_test_42";
    mockValidateSession.mockResolvedValueOnce({
      token: { sub: FAKE_USER_ID, email: "user@example.com" },
    });

    const { req, res, next } = mockContext("Bearer valid.jwt.token");

    await requireAuth(req, res, next);

    expect((req as Request & { descopeUserId: string }).descopeUserId).toBe(
      FAKE_USER_ID,
    );
  });
});
