import { db } from "@db";
import { profilesTable } from "@db/schema";
import { eq } from "drizzle-orm";
import { type NextFunction, type Request, type Response } from "express";
import { type AuthenticatedRequest } from "./requireAuth.js";

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

  const [profile] = await db
    .select({ accountStatus: profilesTable.accountStatus })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);

  if (!profile) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }

  if (BLOCKED_STATUSES.has(profile.accountStatus)) {
    res.status(403).json({
      error: "Account is not allowed to perform this action.",
      code: "ACCOUNT_RESTRICTED",
      status: profile.accountStatus,
    });
    return;
  }

  next();
}
