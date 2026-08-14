import { sql, type SQL } from "drizzle-orm";

type SqlExecutor = {
  execute(query: SQL): Promise<unknown>;
};

function rowsFromExecute<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

export async function fetchTotalRaceWinningsCents(db: SqlExecutor, userId: string): Promise<number> {
  const result = await db.execute(sql`
    WITH cash_winnings AS (
      SELECT user_id, coalesce(sum(amount_cents), 0)::int AS cents
      FROM wallet_transactions
      WHERE transaction_type = 'race_prize_paid'
        AND status = 'completed'
        AND user_id = ${userId}
      GROUP BY user_id
    ),
    unlimited_winnings AS (
      SELECT up.user_id, coalesce(sum(up.payout_cents), 0)::int AS cents
      FROM unlimited_challenge_payouts up
      JOIN unlimited_challenges uc ON uc.id = up.challenge_id
      WHERE up.status = 'credited'
        AND up.payout_cents > 0
        AND up.user_id = ${userId}
        AND uc.settlement_status = 'completed'
        AND NOT EXISTS (
          SELECT 1 FROM wallet_transactions wt
          WHERE wt.user_id = up.user_id
            AND wt.race_room_id::text = up.challenge_id
            AND wt.transaction_type = 'race_prize_paid'
            AND wt.status = 'completed'
        )
      GROUP BY up.user_id
    )
    SELECT coalesce(sum(cents), 0)::int AS total_winning_cents
    FROM (
      SELECT * FROM cash_winnings
      UNION ALL
      SELECT * FROM unlimited_winnings
    ) all_money
  `);
  const [row] = rowsFromExecute<{ total_winning_cents: number | string | null }>(result);
  return Number(row?.total_winning_cents ?? 0);
}
