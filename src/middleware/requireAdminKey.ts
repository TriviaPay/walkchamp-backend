import { timingSafeEqual } from "node:crypto";
import { type NextFunction, type Request, type Response } from "express";
import { logger } from "../lib/logger.js";

/**
 * Constant-time secret comparison. Hashing both sides to a fixed width first keeps the
 * comparison length-independent — timingSafeEqual throws on a length mismatch, and bailing
 * out early on length would itself leak the secret's length.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Still burn a comparison so the failure path costs the same as a wrong-value match.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function requireAdminKey(req: Request, res: Response, next: NextFunction) {
  const adminKey = process.env.ADMIN_SERVICE_KEY ?? process.env.ADMIN_API_KEY;
  if (!adminKey) {
    return res.status(503).json({ error: "Admin API not configured" });
  }

  const provided = req.headers["x-service-key"] ?? req.headers["x-admin-key"];
  if (typeof provided !== "string" || !secretsMatch(provided, adminKey)) {
    logger.warn({ ip: req.ip, path: req.path }, "Admin API: unauthorized attempt");
    return res.status(401).json({ error: "Unauthorized" });
  }

  return next();
}
