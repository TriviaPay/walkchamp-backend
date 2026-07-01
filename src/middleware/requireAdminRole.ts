import { type NextFunction, type Request, type Response } from "express";
import { type AuthenticatedRequest } from "./requireAuth.js";
import { logger } from "../lib/logger.js";

function getAdminUserIds(): Set<string> {
  const raw = process.env.ADMIN_USER_IDS ?? "";
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function requireAdminRole(req: Request, res: Response, next: NextFunction) {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const adminUserIds = getAdminUserIds();

  if (!userId || !adminUserIds.has(userId)) {
    logger.warn({ userId, path: req.path }, "Admin RBAC: forbidden");
    return res.status(403).json({ error: "Admin role required" });
  }

  return next();
}
