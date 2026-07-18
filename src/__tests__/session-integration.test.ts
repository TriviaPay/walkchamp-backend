/**
 * DB-backed single-active-session verification. Exercises the real transaction, the partial
 * unique index on (user_id) WHERE status='active', and the replace/resume/same-device paths
 * against Postgres.
 *
 * Opt-in: set RUN_DB_SESSION_TESTS=1 and point the usual DB env at a migrated database
 * (auth_sessions must exist). Skipped by default so the normal suite needs no DB.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/src/index";
import { authSessionsTable, profilesTable } from "../../db/src/schema/index";
import {
  registerOrReplaceSession,
  resumeSession,
  getSessionById,
  revokeSession,
  SESSION_STATUS,
} from "../lib/sessionService";

const RUN = process.env.RUN_DB_SESSION_TESTS === "1";
const suite = RUN ? describe : describe.skip;

suite("single active session — against Postgres", () => {
  const userId = `test_${randomBytes(8).toString("hex")}`;

  beforeAll(async () => {
    await db.insert(profilesTable).values({
      id: userId,
      email: `${userId}@test.local`,
      fullName: "Test User",
      username: `u_${userId.slice(0, 12)}`,
    });
  });

  afterAll(async () => {
    // Cascade deletes the user's auth_sessions rows.
    await db.delete(profilesTable).where(eq(profilesTable.id, userId));
  });

  async function activeCount(): Promise<number> {
    const rows = await db
      .select({ id: authSessionsTable.id })
      .from(authSessionsTable)
      .where(and(eq(authSessionsTable.userId, userId), eq(authSessionsTable.status, SESSION_STATUS.ACTIVE)));
    return rows.length;
  }

  it("a new-device login replaces the previous active session", async () => {
    const a = await registerOrReplaceSession({ userId, device: { deviceId: "deviceA" } });
    expect(a).not.toBeNull();
    expect(a!.replaced).toBe(false);

    const b = await registerOrReplaceSession({ userId, device: { deviceId: "deviceB" } });
    expect(b!.replaced).toBe(true);
    expect(b!.replacedSessionId).toBe(a!.sessionId);
    expect(b!.sessionGeneration).toBe(a!.sessionGeneration + 1);

    expect(await activeCount()).toBe(1);

    // Old session is now replaced; resume reports it, and it cannot self-resurrect.
    const oldStatus = await resumeSession(a!.sessionId, userId);
    expect(oldStatus.active).toBe(false);
    expect((oldStatus as { code: string }).code).toBe("SESSION_REPLACED");

    const newStatus = await resumeSession(b!.sessionId, userId);
    expect(newStatus.active).toBe(true);
  });

  it("same-device re-register refreshes in place (no self-kick, no generation bump)", async () => {
    const first = await registerOrReplaceSession({ userId, device: { deviceId: "deviceB" } });
    const again = await registerOrReplaceSession({ userId, device: { deviceId: "deviceB" } });
    expect(again!.replaced).toBe(false);
    expect(again!.sessionId).toBe(first!.sessionId);
    expect(again!.sessionGeneration).toBe(first!.sessionGeneration);
    expect(await activeCount()).toBe(1);
  });

  it("concurrent different-device logins leave exactly one active session", async () => {
    await Promise.all([
      registerOrReplaceSession({ userId, device: { deviceId: "raceX" } }),
      registerOrReplaceSession({ userId, device: { deviceId: "raceY" } }),
      registerOrReplaceSession({ userId, device: { deviceId: "raceZ" } }),
    ]);
    expect(await activeCount()).toBe(1);
  });

  it("logout is idempotent and does not reactivate", async () => {
    const s = await registerOrReplaceSession({ userId, device: { deviceId: "deviceLogout" } });
    const r1 = await revokeSession(s!.sessionId, userId);
    expect(r1.ok).toBe(true);
    const r2 = await revokeSession(s!.sessionId, userId);
    expect(r2.ok).toBe(true);
    const after = await getSessionById(s!.sessionId);
    expect(after!.status).toBe(SESSION_STATUS.LOGGED_OUT);
    expect(await activeCount()).toBe(0);
  });
});
