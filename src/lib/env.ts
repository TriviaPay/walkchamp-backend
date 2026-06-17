import { logger } from "./logger";

/** Neon / Postgres connection string (Replit used NEON_DATABASE_URL or DATABASE_URL). */
export function getDatabaseUrl(): string | undefined {
  return process.env.NEON_DATABASE_URL ?? process.env.DATABASE_URL;
}

/**
 * Public API base URL for payment redirects and webhooks.
 * Priority: APP_BASE_URL → REPLIT_DOMAINS (legacy) → VERCEL_URL (auto on Vercel).
 */
export function getAppBaseUrl(): string {
  const explicit = process.env.APP_BASE_URL?.replace(/\/$/, "");
  if (explicit) return explicit;

  const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (replitDomain) {
    return replitDomain.startsWith("http")
      ? replitDomain.replace(/\/$/, "")
      : `https://${replitDomain}`;
  }

  const vercelUrl = process.env.VERCEL_URL?.replace(/\/$/, "");
  if (vercelUrl) {
    return vercelUrl.startsWith("http") ? vercelUrl : `https://${vercelUrl}`;
  }

  return "http://localhost:8080";
}

/** Fail fast when required secrets are missing (same set as Replit production). */
export function assertRequiredEnv(): void {
  const missing: string[] = [];

  if (!getDatabaseUrl()) {
    missing.push("NEON_DATABASE_URL");
  }
  if (!process.env.DESCOPE_PROJECT_ID) {
    missing.push("DESCOPE_PROJECT_ID");
  }
  if (!process.env.SESSION_SECRET) {
    missing.push("SESSION_SECRET");
  }

  if (missing.length > 0) {
    logger.fatal(
      { missingVars: missing },
      "Missing required environment variables — copy secrets from Replit into Vercel (see .env.example)",
    );
    process.exit(1);
  }
}
