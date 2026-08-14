import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { canRunTestDb, setupTestDb, type TestDatabase } from "./helpers/testDb.js";
import { fetchStepLeaderboardRows } from "../lib/stepLeaderboardQuery.js";

const describeDb = describe.skipIf(!canRunTestDb());

type DbIndexModule = typeof import("../../db/src/index.js");

const today = new Date().toISOString().split("T")[0] ?? "2026-01-01";

async function getJson(app: express.Express, path: string): Promise<unknown> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));

  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a port");
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      headers: { authorization: "Bearer test-token" },
    });
    expect(response.status).toBe(200);
    return await response.json() as unknown;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function seedStepLeaderboardFixture(testDb: TestDatabase): Promise<void> {
  const users = [
    { id: "A", email: "a@example.test", username: "user_a", fullName: "User A", country: "United States", countryCode: "US", steps: 1_000 },
    { id: "B", email: "b@example.test", username: "user_b", fullName: "User B", country: "United States", countryCode: "US", steps: 3_000 },
    { id: "C", email: "c@example.test", username: "user_c", fullName: "User C", country: "India", countryCode: "IN", steps: 4_000 },
    { id: "D", email: "d@example.test", username: "user_d", fullName: "User D", country: "India", countryCode: "IN", steps: 500 },
    { id: "E", email: "e@example.test", username: "user_e", fullName: "User E", country: "United States", countryCode: "US", steps: 5_000 },
  ];

  for (const user of users) {
    await testDb.pool.query(
      `INSERT INTO profiles (id, email, full_name, username, country, country_code, account_status, total_steps)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)`,
      [user.id, user.email, user.fullName, user.username, user.country, user.countryCode, user.steps],
    );
    await testDb.pool.query(
      `INSERT INTO step_daily_totals (id, user_id, date, steps)
       VALUES ($1, $2, $3, $4)`,
      [`steps-${user.id}`, user.id, today, user.steps],
    );
  }

  await testDb.pool.query(
    `INSERT INTO friends (id, user_id, friend_id)
     VALUES ('friend-A-B', 'A', 'B'), ('friend-A-C', 'A', 'C')`,
  );
}

describeDb("step leaderboard DB/service/API agreement", () => {
  let testDb: TestDatabase;
  let app: express.Express;
  let dbIndex: DbIndexModule;
  const savedRuntimeUrl = process.env.DATABASE_RUNTIME_URL;

  beforeAll(async () => {
    testDb = await setupTestDb();
    process.env.DATABASE_RUNTIME_URL = testDb.connectionString;
    vi.resetModules();

    vi.doMock("../middleware/requireAuth.js", () => ({
      requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
        (req as express.Request & { descopeUserId: string }).descopeUserId = "A";
        next();
      },
    }));

    const [{ default: leaderboardRouter }, dbModule] = await Promise.all([
      import("../routes/leaderboard.js"),
      import("../../db/src/index.js"),
    ]);
    dbIndex = dbModule;
    app = express();
    app.use("/api", leaderboardRouter);
  }, 60_000);

  beforeEach(async () => {
    await testDb.reset();
    await seedStepLeaderboardFixture(testDb);
  });

  afterAll(async () => {
    await dbIndex?.pool.end().catch(() => {});
    await testDb?.close();
    vi.doUnmock("../middleware/requireAuth.js");
    if (savedRuntimeUrl === undefined) delete process.env.DATABASE_RUNTIME_URL;
    else process.env.DATABASE_RUNTIME_URL = savedRuntimeUrl;
  });

  it("matches direct SQL for global, regional, and friends step rankings", async () => {
    const directGlobal = await testDb.db.execute(sql`
      SELECT p.id
      FROM step_daily_totals s
      JOIN profiles p ON p.id = s.user_id
      WHERE s.date = ${today}::date
        AND p.account_status NOT IN ('banned', 'deleted')
      GROUP BY p.id
      HAVING sum(s.steps) > 0
      ORDER BY sum(s.steps) DESC
    `);
    const directIds = ((directGlobal as unknown as { rows: { id: string }[] }).rows ?? []).map((row) => row.id);
    const globalRows = await fetchStepLeaderboardRows(testDb.db, {
      userId: "A",
      period: "today",
      startDate: today,
      endDate: today,
    });

    expect(directIds).toEqual(["E", "C", "B", "A", "D"]);
    expect(globalRows.map((row) => row.id)).toEqual(directIds);
    expect(globalRows.find((row) => row.id === "A")?.rank).toBe(4);

    const regionalRows = await fetchStepLeaderboardRows(testDb.db, {
      userId: "A",
      period: "today",
      startDate: today,
      endDate: today,
      countryCode: "US",
    });
    expect(regionalRows.map((row) => row.id)).toEqual(["E", "B", "A"]);
    expect(regionalRows.find((row) => row.id === "A")?.rank).toBe(3);

    const friendRows = await fetchStepLeaderboardRows(testDb.db, {
      userId: "A",
      period: "today",
      startDate: today,
      endDate: today,
      friendIds: ["A", "B", "C"],
    });
    expect(friendRows.map((row) => row.id)).toEqual(["C", "B", "A"]);
    expect(friendRows.find((row) => row.id === "A")?.rank).toBe(3);
  });

  it("returns the same rankings through the leaderboard API", async () => {
    const global = await getJson(app, `/api/leaderboard?period=today&scope=global&localDate=${today}`) as {
      leaderboard: { id: string; rank: number }[];
      userRank: number;
    };
    expect(global.leaderboard.map((row) => row.id)).toEqual(["E", "C", "B", "A", "D"]);
    expect(global.userRank).toBe(4);

    const regional = await getJson(app, `/api/leaderboard?period=today&scope=regional&localDate=${today}`) as {
      leaderboard: { id: string; rank: number }[];
      userRank: number;
    };
    expect(regional.leaderboard.map((row) => row.id)).toEqual(["E", "B", "A"]);
    expect(regional.userRank).toBe(3);

    const friends = await getJson(app, `/api/leaderboard?period=today&scope=friends&localDate=${today}`) as {
      leaderboard: { id: string; rank: number }[];
      userRank: number;
    };
    expect(friends.leaderboard.map((row) => row.id)).toEqual(["C", "B", "A"]);
    expect(friends.userRank).toBe(3);
  });
});
