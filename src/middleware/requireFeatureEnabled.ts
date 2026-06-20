import { type NextFunction, type Request, type Response } from "express";
import { isFeatureEnabled } from "../lib/featureFlags";
import { logger } from "../lib/logger";

export function requireFeatureEnabled(
  key: string,
  opts?: {
    statusCode?: number;
    message?: string;
  },
) {
  return async function featureGate(req: Request, res: Response, next: NextFunction) {
    const enabled = await isFeatureEnabled(key, false);
    if (enabled) {
      return next();
    }

    logger.warn({ key, method: req.method, path: req.path }, "[FeatureFlags] blocked disabled route");
    return res.status(opts?.statusCode ?? 404).json({
      error: opts?.message ?? "This feature is currently disabled.",
      code: "FEATURE_DISABLED",
    });
  };
}
