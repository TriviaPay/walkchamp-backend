import { type NextFunction, type Request, type Response } from "express";
import { logger } from "../lib/logger";

export function requireAdminKey(req: Request, res: Response, next: NextFunction) {
  const adminKey = process.env.ADMIN_SERVICE_KEY ?? process.env.ADMIN_API_KEY;
  if (!adminKey) {
    return res.status(503).json({ error: "Admin API not configured" });
  }

  const provided = req.headers["x-service-key"] ?? req.headers["x-admin-key"];
  if (typeof provided !== "string" || provided !== adminKey) {
    logger.warn({ ip: req.ip, path: req.path }, "Admin API: unauthorized attempt");
    return res.status(401).json({ error: "Unauthorized" });
  }

  return next();
}
