import { type Request, type Response, type NextFunction } from "express";
import { getDescopeClient } from "../lib/descope";

export interface AuthenticatedRequest extends Request {
  descopeUserId: string;
  descopeEmail?: string;
}

/**
 * Validates the Descope session JWT from the Authorization header.
 * Attaches descopeUserId (and optionally email) to the request.
 * Returns 401 for missing or invalid tokens.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or malformed Authorization header" });
    return;
  }

  const token = authHeader.slice(7);
  if (!token) {
    res.status(401).json({ error: "Empty token" });
    return;
  }

  try {
    const client = getDescopeClient();
    const authInfo = await client.validateSession(token);

    (req as AuthenticatedRequest).descopeUserId = authInfo.token.sub as string;
    // Descope includes email in the token claims under 'email' or in loginIds
    const claims = authInfo.token as Record<string, unknown>;
    (req as AuthenticatedRequest).descopeEmail = (claims.email ?? "") as string;

    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session token" });
  }
}
