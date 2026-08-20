import { type NextFunction, type Request, type Response } from "express";
import { type AuthenticatedRequest } from "./requireAuth.js";
import { getAccountStatusForAuthGate } from "../lib/sessionService.js";

const BLOCKED_STATUSES = new Set(["suspended", "banned", "deleted"]);

export async function requireActiveAccount(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const authReq = req as AuthenticatedRequest;
  const accountStatus = authReq.accountStatus
    ?? await getAccountStatusForAuthGate(userId);
  authReq.accountStatus = accountStatus;

  if (!accountStatus) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }

  if (BLOCKED_STATUSES.has(accountStatus)) {
    res.status(403).json({
      error: "Account is not allowed to perform this action.",
      code: "ACCOUNT_RESTRICTED",
      status: accountStatus,
    });
    return;
  }

  next();
}
