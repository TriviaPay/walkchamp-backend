/**
 * READ-ONLY distribution audit for the three leaderboard filter decisions that are
 * deliberately NOT implemented yet. Run this against production (or a snapshot) and
 * paste the output into the follow-up PR that adds the filters.
 *
 * This script issues SELECTs only. It never writes, and it rewrites no history —
 * same rule as migration 0030.
 *
 *   pnpm audit:leaderboard
 *
 * Decisions it unblocks:
 *   1. race_results.status  — is it safe to stop counting 'pending_verification' as a win?
 *   2. coin_transactions    — is the coins-won allowlist complete, and what sign do
 *                             'refund'/'adjustment' rows actually carry?
 *   3. profiles.country_code — do US / USA / United States variants coexist, i.e. is a
 *                             canonical mapping actually needed (vs. plain upper+trim)?
 */
import { db } from "@db";
import { sql } from "drizzle-orm";

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

function table(title: string, rows: Record<string, unknown>[]): void {
  console.log(`\n─── ${title} ${"─".repeat(Math.max(0, 68 - title.length))}`);
  if (rows.length === 0) {
    console.log("  (no rows)");
    return;
  }
  console.table(rows);
}

async function run() {
  // ── 1. race_results.status ────────────────────────────────────────────────
  // The leaderboard currently counts a row as a win on eligible_for_prize alone
  // (minus review_required / disqualified_simulation). 'pending_verification' is the
  // column DEFAULT, so legacy rows carry it; excluding it blindly would erase real
  // historical wins. The second block sizes exactly how many wins that would remove,
  // split by whether the room predates the new settlement path.
  table(
    "1a. race_results.status distribution (all rows)",
    rowsOf(await db.execute(sql`
      SELECT status,
             count(*)::int                                              AS rows,
             count(*) FILTER (WHERE eligible_for_prize)::int            AS eligible_rows,
             min(created_at)::date                                      AS first_seen,
             max(created_at)::date                                      AS last_seen
      FROM race_results
      GROUP BY status
      ORDER BY rows DESC
    `)),
  );

  table(
    "1b. wins that excluding 'pending_verification' would REMOVE",
    rowsOf(await db.execute(sql`
      SELECT CASE WHEN rm.starting_participant_count IS NULL THEN 'legacy room' ELSE 'new-settlement room' END AS era,
             rm.entry_type,
             count(*)::int                    AS wins_lost,
             count(DISTINCT rr.user_id)::int  AS users_affected
      FROM race_results rr
      JOIN race_rooms rm ON rr.race_room_id::uuid = rm.id
      WHERE rr.eligible_for_prize = true
        AND rm.status = 'completed'
        AND rr.status = 'pending_verification'
      GROUP BY 1, 2
      ORDER BY wins_lost DESC
    `)),
  );

  // ── 2. coin_transactions ──────────────────────────────────────────────────
  // 2a proves the allowlist is complete rather than inferred: any (type, source,
  // reward_code) triple that is NOT matched but IS conceptually a challenge winning
  // must be added before the filter is tightened further.
  const coinsWon = sql`(
    left(reward_code, 17) = 'COINS_BATTLE_WIN_'
    OR position('_RACE_WIN_' in reward_code) > 0
    OR reward_code IN ('PUBLIC_ROOM_WIN', 'PRIVATE_ROOM_WIN')
  )`;

  table(
    "2a. coin_transactions by (type, source, reward_code shape) vs the coins-won allowlist",
    rowsOf(await db.execute(sql`
      SELECT transaction_type,
             source,
             CASE
               WHEN reward_code IS NULL                              THEN '(null)'
               WHEN left(reward_code, 17) = 'COINS_BATTLE_WIN_'      THEN 'COINS_BATTLE_WIN_*'
               WHEN position('_RACE_WIN_' in reward_code) > 0        THEN '*_RACE_WIN_*'
               ELSE reward_code
             END                                    AS reward_code_shape,
             ${coinsWon}                            AS counted_as_won,
             count(*)::int                          AS rows,
             sum(amount)::bigint                    AS sum_amount,
             min(amount)::int                       AS min_amount,
             max(amount)::int                       AS max_amount
      FROM coin_transactions
      GROUP BY 1, 2, 3, 4
      ORDER BY rows DESC
    `)),
  );

  // 2b answers the ELSE -abs(amount) question directly. If refund/adjustment rows are
  // ALREADY stored negative, the current expression double-negates a correction and a
  // positive admin adjustment is wrongly subtracted.
  table(
    "2b. sign convention for refund / adjustment rows (drives the coins ELSE branch)",
    rowsOf(await db.execute(sql`
      SELECT transaction_type,
             count(*) FILTER (WHERE amount > 0)::int AS positive_rows,
             count(*) FILTER (WHERE amount < 0)::int AS negative_rows,
             count(*) FILTER (WHERE amount = 0)::int AS zero_rows,
             count(*) FILTER (WHERE ${coinsWon})::int AS rows_in_won_allowlist
      FROM coin_transactions
      WHERE transaction_type IN ('refund', 'adjustment')
      GROUP BY 1
      ORDER BY 1
    `)),
  );

  // ── 3. profiles.country_code ──────────────────────────────────────────────
  // Decides whether a canonical mapping is needed at all. The app writes ISO-2 from a
  // fixed picker list, so this is expected to be clean — but a non-ISO-2 value, or two
  // spellings of one country, would split a region across two leaderboards.
  table(
    "3a. distinct profiles.country_code (post upper+trim), ranked",
    rowsOf(await db.execute(sql`
      SELECT upper(trim(country_code))                     AS normalized,
             count(*)::int                                 AS profiles,
             count(*) FILTER (WHERE account_status NOT IN ('banned','deleted'))::int AS rankable,
             length(upper(trim(country_code)))             AS code_length
      FROM profiles
      WHERE country_code IS NOT NULL AND trim(country_code) <> ''
      GROUP BY 1, 4
      ORDER BY profiles DESC
    `)),
  );

  // Any row here means one country is split across two leaderboard buckets.
  table(
    "3b. same country name stored under MORE THAN ONE code (splits a region)",
    rowsOf(await db.execute(sql`
      SELECT upper(trim(country))                                  AS country_name,
             count(DISTINCT upper(trim(country_code)))::int        AS distinct_codes,
             string_agg(DISTINCT upper(trim(country_code)), ', ')  AS codes,
             count(*)::int                                         AS profiles
      FROM profiles
      WHERE country IS NOT NULL AND trim(country) <> ''
        AND country_code IS NOT NULL AND trim(country_code) <> ''
      GROUP BY 1
      HAVING count(DISTINCT upper(trim(country_code))) > 1
      ORDER BY profiles DESC
    `)),
  );

  table(
    "3c. non ISO-2 country codes (length <> 2) — would need canonical mapping",
    rowsOf(await db.execute(sql`
      SELECT upper(trim(country_code)) AS normalized,
             count(*)::int             AS profiles
      FROM profiles
      WHERE country_code IS NOT NULL
        AND length(trim(country_code)) <> 2
        AND trim(country_code) <> ''
      GROUP BY 1
      ORDER BY profiles DESC
    `)),
  );

  console.log("\nRead-only audit complete. No rows were modified.\n");
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
