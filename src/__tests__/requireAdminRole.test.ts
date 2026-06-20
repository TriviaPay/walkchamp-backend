import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { requireAdminRole } from "../middleware/requireAdminRole";

function mockContext(userId?: string) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const req = { path: "/api/admin/users", descopeUserId: userId } as unknown as Request;
  const res = { status, json } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next, status, json };
}

describe("requireAdminRole", () => {
  beforeEach(() => {
    process.env.ADMIN_USER_IDS = "admin-1,admin-2";
  });

  it("rejects non-admin users", () => {
    const { req, res, next, status, json } = mockContext("user-1");

    requireAdminRole(req, res, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: "Admin role required" });
    expect(next).not.toHaveBeenCalled();
  });

  it("allows configured admin users", () => {
    const { req, res, next, status } = mockContext("admin-2");

    requireAdminRole(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });
});
