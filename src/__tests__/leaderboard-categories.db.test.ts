import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canRunTestDb, setupTestDb, type TestDatabase } from "./helpers/testDb.js";

const describeDb = describe.skipIf(!canRunTestDb());

type DbIndexModule = typeof import("../../db/src/index.js");

const today = new Date().toISOString().split("T")[0] ?? "2026-01-01";
const raceIds = {
  b1: "11111111-1111-4111-8111-111111111111",
  b2: "11111111-1111-4111-8111-111111111112",
  b3: "11111111-1111-4111-8111-111111111113",
  c1: "22222222-2222-4222-8222-222222222221",
  a1: "33333333-3333-4333-8333-333333333331",
  cancelled: "44444444-4444-4444-8444-444444444441",
  unlimited: "55555555-5555-4555-8555-555555555551",
};

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

async function seedUsers(testDb: TestDatabase): Promise<void> {
  const users = ["A", "B", "C", "D", "E"];
  for (const id of users) {
    await testDb.pool.query(
      `INSERT INTO profiles (id, email, full_name, username, country, country_code, account_status, total_steps)
       VALUES ($1, $2, $3, $4, 'United States', 'US', 'active', 1000)`,
      [id, `${id.toLowerCase()}@example.test`, `User ${id}`, `user_${id.toLowerCase()}`],
    );
    await testDb.pool.query(
      `INSERT INTO wallets (id, user_id)
       VALUES (gen_random_uuid(), $1)`,
      [id],
    );
  }
}

async function seedRaceFixture(testDb: TestDatabase): Promise<void> {
  for (const [key, id] of Object.entries(raceIds)) {
    if (key === "unlimited") continue;
    await testDb.pool.query(
      `INSERT INTO race_rooms (id, creator_id, title, status, entry_type, starting_participant_count)
       VALUES ($1, 'A', $2, $3, 'free', 3)`,
      [id, `Race ${key}`, key === "cancelled" ? "cancelled" : "completed"],
    );
  }

  const results = [
    ["rr-b1", raceIds.b1, "B", 1, true],
    ["rr-b2", raceIds.b2, "B", 2, true],
    ["rr-b3", raceIds.b3, "B", 3, true],
    ["rr-c1", raceIds.c1, "C", 2, true],
    ["rr-a1", raceIds.a1, "A", 1, true],
    ["rr-cancelled", raceIds.cancelled, "C", 1, true],
    ["rr-not-winner", raceIds.b1, "D", 4, false],
  ];
  for (const [id, raceId, userId, rank, eligible] of results) {
    await testDb.pool.query(
      `INSERT INTO race_results (id, race_room_id, user_id, rank, eligible_for_prize, status)
       VALUES ($1, $2, $3, $4, $5, 'finalized')`,
      [id, raceId, userId, rank, eligible],
    );
  }

  await testDb.pool.query(
    `INSERT INTO unlimited_challenges (
       id, host_user_id, title, status, entry_fee_cents, duration_days, start_at_utc,
       registration_closes_at_utc, challenge_end_at_utc, settlement_not_before_utc,
       settlement_status
     )
     VALUES ($1, 'A', 'Unlimited', 'completed', 100, 1, now(), now(), now(), now(), 'completed')`,
    [raceIds.unlimited],
  );
  await testDb.pool.query(
    `INSERT INTO unlimited_challenge_payouts (id, challenge_id, participant_id, user_id, payout_cents, status)
     VALUES ('ucp-c', $1, 'participant-c', 'C', 700, 'credited')`,
    [raceIds.unlimited],
  );
  await testDb.pool.query(
    `INSERT INTO wallet_transactions (wallet_id, user_id, transaction_type, amount_cents, status, description, race_room_id)
     SELECT id, 'B', 'race_prize_paid', 1200, 'completed', 'B race prize', $1::uuid
     FROM wallets WHERE user_id = 'B'`,
    [raceIds.b1],
  );
}

async function seedCoinFixture(testDb: TestDatabase): Promise<void> {
  const rows = [
    ["coin-a-buy", "A", 10000, "earn", "iap_purchase", null],
    ["coin-a-win", "A", 200, "earn", "coins_battle", "PUBLIC_ROOM_WIN"],
    ["coin-b-win", "B", 900, "earn", "coins_battle", "COINS_BATTLE_WIN_room-1"],
    ["coin-b-refund", "B", 100, "refund", "coins_battle", "COINS_BATTLE_WIN_room-1"],
    ["coin-c-win", "C", 500, "earn", "coins_battle", "PRIVATE_ROOM_WIN"],
    ["coin-c-reversal", "C", 500, "adjustment", "coins_battle", "PRIVATE_ROOM_WIN"],
  ];
  for (const [id, userId, amount, type, source, rewardCode] of rows) {
    await testDb.pool.query(
      `INSERT INTO coin_transactions (
         id, user_id, amount, transaction_type, source, reward_code,
         reason_code, idempotency_key, description
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'test', $1, 'fixture')`,
      [id, userId, amount, type, source, rewardCode],
    );
  }
}

async function seedGroupFixture(testDb: TestDatabase): Promise<void> {
  await testDb.pool.query(
    `INSERT INTO walking_groups (id, group_name, group_type, admin_user_id, status)
     VALUES ('g1', 'Group 18k', 'friends', 'A', 'active'),
            ('g2', 'Group 24k', 'friends', 'E', 'active')`,
  );
  await testDb.pool.query(
    `INSERT INTO walking_group_members (id, group_id, user_id, role, status)
     VALUES ('g1-a', 'g1', 'A', 'admin', 'active'),
            ('g1-b', 'g1', 'B', 'member', 'active'),
            ('g1-c', 'g1', 'C', 'member', 'left'),
            ('g2-e', 'g2', 'E', 'admin', 'active')`,
  );
  const rows = [
    ["g1-a-steps", "g1", "A", 8000],
    ["g1-b-steps", "g1", "B", 10000],
    ["g1-c-steps", "g1", "C", 6000],
    ["g2-e-steps", "g2", "E", 24000],
  ];
  for (const [id, groupId, userId, steps] of rows) {
    await testDb.pool.query(
      `INSERT INTO walking_group_daily_steps (id, group_id, user_id, step_date, daily_steps, verified_steps)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [id, groupId, userId, today, steps],
    );
  }
}

describeDb("race, coins, and group leaderboard DB/API behavior", () => {
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
    await seedUsers(testDb);
    await seedRaceFixture(testDb);
    await seedCoinFixture(testDb);
    await seedGroupFixture(testDb);
  });

  afterAll(async () => {
    await dbIndex?.pool.end().catch(() => {});
    await testDb?.close();
    vi.doUnmock("../middleware/requireAuth.js");
    if (savedRuntimeUrl === undefined) delete process.env.DATABASE_RUNTIME_URL;
    else process.env.DATABASE_RUNTIME_URL = savedRuntimeUrl;
  });

  it("counts rewarded race placements, unlimited wins, and real winnings", async () => {
    const json = await getJson(app, "/api/leaderboard/races") as {
      leaderboard: { id: string; wins: number; totalWinning: number; rank: number }[];
      userRank: number;
      userWins: number;
      userTotalWinning: number;
    };

    expect(json.leaderboard.map((row) => [row.id, row.wins, row.rank])).toEqual([
      ["B", 3, 1],
      ["C", 2, 2],
      ["A", 1, 3],
    ]);
    expect(json.leaderboard.find((row) => row.id === "B")?.totalWinning).toBe(12);
    expect(json.leaderboard.find((row) => row.id === "C")?.totalWinning).toBe(7);
    expect(json.userRank).toBe(3);
    expect(json.userWins).toBe(1);
    expect(json.userTotalWinning).toBe(0);
  });

  it("ranks only won coins and nets reversals", async () => {
    const json = await getJson(app, "/api/leaderboard/coins") as {
      leaderboard: { id: string; metric: number; rank: number }[];
      userRank: number;
    };

    expect(json.leaderboard.map((row) => [row.id, row.metric, row.rank])).toEqual([
      ["B", 800, 1],
      ["A", 200, 2],
    ]);
    expect(json.userRank).toBe(2);
  });

  it("ranks group totals from active members only", async () => {
    const json = await getJson(app, `/api/leaderboard/groups?period=today&localDate=${today}`) as {
      leaderboard: { id: string; totalSteps: number; rank: number }[];
    };

    expect(json.leaderboard.map((row) => [row.id, row.totalSteps, row.rank])).toEqual([
      ["g2", 24000, 1],
      ["g1", 18000, 2],
    ]);
  });
});
