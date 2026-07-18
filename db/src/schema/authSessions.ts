import { pgTable, text, integer, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { profilesTable } from "./profiles.js";

// ── Backend-authoritative auth sessions ───────────────────────────────────────
// Enforces exactly one active session per user. The internal `sessionId` is the
// authoritative identifier the client echoes back on every request; the Descope
// JWT still authenticates the user, but this row decides whether the device is
// still the current one. No raw JWTs or refresh tokens are ever stored here.
export const authSessionsTable = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    // High-entropy random token (crypto.randomBytes(32).base64url). Client-visible.
    sessionId: text("session_id").notNull(),
    sessionGeneration: integer("session_generation").notNull().default(1),
    // Opportunistic provider session id if extractable from the token. Best-effort;
    // correctness never depends on it.
    descopeSessionId: text("descope_session_id"),
    // Informational only — never trusted as proof of identity.
    deviceId: text("device_id"),
    platform: text("platform"),
    appVersion: text("app_version"),
    buildNumber: text("build_number"),
    // active | replaced | logged_out | expired | revoked
    status: text("status").notNull().default("active"),
    invalidationReason: text("invalidation_reason"),
    replacedBySessionId: text("replaced_by_session_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("auth_sessions_session_id_unique_idx").on(t.sessionId),
    // The database guarantee: at most one active session per user.
    uniqueIndex("auth_sessions_user_active_unique_idx")
      .on(t.userId)
      .where(sql`${t.status} = 'active'`),
    index("auth_sessions_user_status_idx").on(t.userId, t.status),
  ],
);

export type AuthSession = typeof authSessionsTable.$inferSelect;
export type InsertAuthSession = typeof authSessionsTable.$inferInsert;
