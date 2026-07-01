import { type NextFunction, type Request, type Response } from "express";
import { areCashFeaturesEnabled } from "../lib/featureFlags.js";
import { logger } from "../lib/logger.js";

export async function requireCashFeaturesEnabled(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const enabled = await areCashFeaturesEnabled();
  if (enabled) {
    return next();
  }

  logger.error({ method: req.method, path: req.path, ip: req.ip }, "[CashGuard] cash route invoked while disabled");
  return res.status(404).json({
    error: "Cash features are disabled for this build.",
    code: "CASH_FEATURES_DISABLED",
  });
}
