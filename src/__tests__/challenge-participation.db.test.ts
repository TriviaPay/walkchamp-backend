import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchChallengeParticipationBreakdown } from "../lib/challengeParticipation.js";
import { canRunTestDb, setupTestDb, type TestDatabase } from "./helpers/testDb.js";

const describeDb = describe.skipIf(!canRunTestDb());

const USER_ID = "participation-user";
const TEST_USER_ID = "participation-test-user";

const roomIds = {
  freeCompleted: "10000000-0000-4000-8000-000000000001",
  freeForfeited: "10000000-0000-4000-8000-000000000002",
  freeDisqualified: "10000000-0000-4000-8000-000000000003",
  coinsCompleted: "20000000-0000-4000-8000-000000000001",
  coinsRejectedAtStart: "20000000-0000-4000-8000-000000000002",
  paidForfeited: "30000000-0000-4000-8000-000000000001",
  paidDisqualifiedAfterStart: "30000000-0000-4000-8000-000000000002",
  paidRejectedAtStart: "30000000-0000-4000-8000-000000000003",
  sponsored: "40000000-0000-4000-8000-000000000001",
  waitingLeave: "50000000-0000-4000-8000-000000000001",
  neverStarted: "50000000-0000-4000-8000-000000000002",
  testUserRace: "50000000-0000-4000-8000-000000000003",
};

describeDb("challenge participation SQL semantics", () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await setupTestDb();

    await testDb.pool.query(
      `INSERT INTO profiles (id, email, full_name, username, account_status)
       VALUES ($1, 'walker@walkchamp.app', 'Walker', 'walker_profile', 'active'),
              ($2, 'test.account@walkchamp.app', 'Test Account', 'test_account', 'active')`,
      [USER_ID, TEST_USER_ID],
    );
    await testDb.pool.query(
      `INSERT INTO wallets (id, user_id)
       VALUES (gen_random_uuid(), $1), (gen_random_uuid(), $2)`,
      [USER_ID, TEST_USER_ID],
    );

    const rooms: Array<[string, string, string, string, boolean]> = [
      [roomIds.freeCompleted, "free", "quick", "completed", true],
      [roomIds.freeForfeited, "free", "quick", "in_progress", true],
      [roomIds.freeDisqualified, "free", "quick", "completed", true],
      [roomIds.coinsCompleted, "coins_battle", "quick", "completed", true],
      [roomIds.coinsRejectedAtStart, "coins_battle", "quick", "in_progress", true],
      [roomIds.paidForfeited, "paid_usd", "quick", "completed", true],
      [roomIds.paidDisqualifiedAfterStart, "paid_usd", "quick", "completed", true],
      [roomIds.paidRejectedAtStart, "paid_usd", "quick", "in_progress", true],
      [roomIds.sponsored, "free", "sponsored", "completed", true],
      [roomIds.waitingLeave, "free", "quick", "in_progress", true],
      [roomIds.neverStarted, "free", "quick", "cancelled", false],
      [roomIds.testUserRace, "free", "quick", "completed", true],
    ];
    for (const [id, entryType, type, status, started] of rooms) {
      await testDb.pool.query(
        `INSERT INTO race_rooms (id, creator_id, title, entry_type, type, status, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7 THEN now() ELSE NULL END)`,
        [id, USER_ID, `Room ${id}`, entryType, type, status, started],
      );
    }

    const participants: Array<[string, string, string]> = [
      [roomIds.freeCompleted, USER_ID, "completed"],
      [roomIds.freeForfeited, USER_ID, "forfeited"],
      [roomIds.freeDisqualified, USER_ID, "disqualified"],
      [roomIds.coinsCompleted, USER_ID, "completed"],
      [roomIds.coinsRejectedAtStart, USER_ID, "disqualified"],
      [roomIds.paidForfeited, USER_ID, "forfeited"],
      [roomIds.paidDisqualifiedAfterStart, USER_ID, "disqualified"],
      [roomIds.paidRejectedAtStart, USER_ID, "disqualified"],
      [roomIds.sponsored, USER_ID, "disqualified"],
      [roomIds.waitingLeave, USER_ID, "left"],
      [roomIds.neverStarted, USER_ID, "joined"],
      [roomIds.testUserRace, TEST_USER_ID, "completed"],
    ];
    for (const [raceRoomId, userId, status] of participants) {
      await testDb.pool.query(
        `INSERT INTO race_participants (race_room_id, user_id, status)
         VALUES ($1, $2, $3)`,
        [raceRoomId, userId, status],
      );
    }

    // Ledger evidence proves this paid participant passed admission before a later DQ.
    await testDb.pool.query(
      `INSERT INTO wallet_transactions (
         wallet_id, user_id, transaction_type, amount_cents, status, description, race_room_id
       )
       SELECT id, $1, 'race_entry_wallet_debit', -300, 'completed', 'fixture', $2
       FROM wallets WHERE user_id = $1`,
      [USER_ID, roomIds.paidDisqualifiedAfterStart],
    );

    const streaks: Array<[string, boolean, boolean]> = [
      ["streak-seven-days", true, true],
      ["streak-ninety-days", true, true],
      ["streak-left-before-start", true, false],
      ["streak-never-started", false, true],
    ];
    for (const [id, started, inPopulation] of streaks) {
      await testDb.pool.query(
        `INSERT INTO unlimited_challenges (
           id, host_user_id, title, status, entry_fee_cents, duration_days,
           start_at_utc, registration_closes_at_utc, challenge_end_at_utc,
           settlement_not_before_utc, started_at_utc
         ) VALUES (
           $1, $2, $1, $3, 300, 7,
           now(), now(), now() + interval '7 days', now() + interval '8 days',
           CASE WHEN $4 THEN now() ELSE NULL END
         )`,
        [id, USER_ID, started ? "active" : "waiting", started],
      );
      await testDb.pool.query(
        `INSERT INTO unlimited_challenge_participants (
           id, challenge_id, user_id, participant_timezone, entry_contribution_cents,
           qualification_status, in_settlement_population
         ) VALUES ($1, $2, $3, 'UTC', 300, $4, $5)`,
        [`participant-${id}`, id, USER_ID, inPopulation ? "active" : "left", inPopulation],
      );
    }
  });

  afterAll(async () => {
    await testDb.close();
  });

  it("counts only users frozen into a started challenge and keeps post-start failures", async () => {
    const result = await fetchChallengeParticipationBreakdown(testDb.db, USER_ID);

    expect(result).toEqual({
      totalParticipatedChallenges: 9,
      byType: {
        free: { count: 3, percentage: 33.33 },
        coins: { count: 1, percentage: 11.11 },
        topFinishers: { count: 2, percentage: 22.22 },
        sponsoredEvents: { count: 1, percentage: 11.11 },
        streakChallenge: { count: 2, percentage: 22.22 },
      },
    });
  });

  it("excludes reserved test accounts even when they have a started participant row", async () => {
    const result = await fetchChallengeParticipationBreakdown(testDb.db, TEST_USER_ID);
    expect(result.totalParticipatedChallenges).toBe(0);
  });
});
