import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canRunTestDb, setupTestDb, type TestDatabase } from "./helpers/testDb.js";

const describeDb = describe.skipIf(!canRunTestDb());

describeDb("postgres test database harness", () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await setupTestDb();
  }, 60_000);

  afterAll(async () => {
    await testDb?.close();
  });

  it("runs the repository migrations", async () => {
    const migrationCount = await testDb.pool.query<{ count: string }>(
      `SELECT count(*) FROM drizzle.__drizzle_migrations`,
    );
    const profilesTable = await testDb.pool.query<{ exists: string | null }>(
      `SELECT to_regclass('public.profiles')::text AS exists`,
    );

    expect(Number(migrationCount.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    expect(profilesTable.rows[0]?.exists).toBe("profiles");
  });

  it("truncates fixture data without dropping the migrated schema", async () => {
    await testDb.reset();

    const userId = `user-${randomUUID()}`;
    await testDb.pool.query(
      `INSERT INTO profiles (id, email, full_name, username)
       VALUES ($1, $2, $3, $4)`,
      [userId, `${userId}@example.test`, "Fixture User", `fixture_${randomUUID().slice(0, 8)}`],
    );
    await testDb.pool.query(
      `INSERT INTO step_daily_totals (id, user_id, date, steps)
       VALUES ($1, $2, $3, $4)`,
      [`daily-${randomUUID()}`, userId, "2026-01-02", 1234],
    );

    await testDb.reset();

    const profileRows = await testDb.pool.query<{ count: string }>(`SELECT count(*) FROM profiles`);
    const stepRows = await testDb.pool.query<{ count: string }>(`SELECT count(*) FROM step_daily_totals`);
    const profilesTable = await testDb.pool.query<{ exists: string | null }>(
      `SELECT to_regclass('public.profiles')::text AS exists`,
    );

    expect(Number(profileRows.rows[0]?.count ?? 0)).toBe(0);
    expect(Number(stepRows.rows[0]?.count ?? 0)).toBe(0);
    expect(profilesTable.rows[0]?.exists).toBe("profiles");
  });
});
