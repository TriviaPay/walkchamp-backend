import { sql, type SQL } from "drizzle-orm";

export const CHALLENGE_PARTICIPATION_TYPES = [
  "free",
  "coins",
  "topFinishers",
  "sponsoredEvents",
  "streakChallenge",
] as const;

export type ChallengeParticipationType = (typeof CHALLENGE_PARTICIPATION_TYPES)[number];

export type ChallengeParticipationBreakdown = {
  totalParticipatedChallenges: number;
  byType: Record<ChallengeParticipationType, { count: number; percentage: number }>;
};

type SqlExecutor = {
  execute(query: SQL): Promise<unknown>;
};

type ParticipationCountRow = {
  free_count?: number | string | null;
  coins_count?: number | string | null;
  top_finishers_count?: number | string | null;
  sponsored_events_count?: number | string | null;
  streak_challenge_count?: number | string | null;
};

function rowsFromExecute<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

function percentage(count: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((count / total) * 10_000) / 100;
}

export function buildChallengeParticipationBreakdown(
  counts: Record<ChallengeParticipationType, number>,
): ChallengeParticipationBreakdown {
  const totalParticipatedChallenges = CHALLENGE_PARTICIPATION_TYPES.reduce(
    (total, type) => total + Math.max(0, Math.trunc(counts[type] ?? 0)),
    0,
  );

  return {
    totalParticipatedChallenges,
    byType: Object.fromEntries(
      CHALLENGE_PARTICIPATION_TYPES.map((type) => {
        const count = Math.max(0, Math.trunc(counts[type] ?? 0));
        return [type, { count, percentage: percentage(count, totalParticipatedChallenges) }];
      }),
    ) as ChallengeParticipationBreakdown["byType"],
  };
}

export function emptyChallengeParticipationBreakdown(): ChallengeParticipationBreakdown {
  return buildChallengeParticipationBreakdown({
    free: 0,
    coins: 0,
    topFinishers: 0,
    sponsoredEvents: 0,
    streakChallenge: 0,
  });
}

function isConfiguredExcludedUser(userId: string): boolean {
  const configured = [process.env.ADMIN_USER_IDS, process.env.PARTICIPATION_EXCLUDED_USER_IDS]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return configured.includes(userId);
}

/**
 * Count challenges whose authoritative start boundary included this user.
 *
 * Fixed-player races materialize scheduled/sponsored registrations into race_participants only
 * at start. A normal pre-start departure is retained as `left`, while a departure after start is
 * retained as `forfeited`, so the latter continues to count. Cash/coin participants rejected while
 * the room is starting are marked `disqualified`; payment-ledger evidence distinguishes them from
 * a participant disqualified after admission.
 *
 * Unlimited/Streak challenges already freeze the exact start population in
 * `in_settlement_population`, which remains true after a later leave or disqualification.
 */
export async function fetchChallengeParticipationBreakdown(
  executor: SqlExecutor,
  userId: string,
): Promise<ChallengeParticipationBreakdown> {
  if (isConfiguredExcludedUser(userId)) return emptyChallengeParticipationBreakdown();

  const result = await executor.execute(sql`
    WITH eligible_user AS (
      SELECT p.id
      FROM profiles p
      WHERE p.id = ${userId}
        -- Reserved/system identities are not real challenge participants. Explicit production
        -- test accounts should additionally be listed in PARTICIPATION_EXCLUDED_USER_IDS.
        AND lower(p.username) !~ '^(admin|ghost|system|test)([._+0-9-].*)?$'
        AND lower(split_part(p.email, '@', 1)) !~ '^(admin|ghost|system|test)([._+0-9-].*)?$'
        AND lower(split_part(p.email, '@', 2)) NOT IN ('example.com', 'example.test', 'test', 'invalid')
    ),
    fixed_participation AS (
      SELECT DISTINCT
        rr.id::text AS challenge_id,
        CASE
          WHEN rr.type = 'sponsored' THEN 'sponsoredEvents'
          WHEN rr.entry_type = 'coins_battle' THEN 'coins'
          WHEN rr.entry_type IN ('paid_1', 'paid_3', 'paid_5', 'paid_usd') THEN 'topFinishers'
          ELSE 'free'
        END AS challenge_type
      FROM race_participants rp
      JOIN race_rooms rr ON rr.id = rp.race_room_id
      JOIN eligible_user eu ON eu.id = rp.user_id
      WHERE rr.started_at IS NOT NULL
        -- Pre-start lobby departures/removals are left. Post-start departures are forfeited
        -- and deliberately remain included.
        AND rp.status <> 'left'
        AND (
          rp.status <> 'disqualified'
          -- Sponsored participants are materialized only after the event start transition.
          OR rr.type = 'sponsored'
          -- Free-race disqualification only occurs after admission (there is no entry charge).
          OR rr.entry_type = 'free'
          -- A successful entry ledger proves a cash/coin participant survived the pre-start
          -- admission check; a later disqualification must not erase participation.
          OR EXISTS (
            SELECT 1
            FROM wallet_transactions wt
            WHERE wt.user_id = rp.user_id
              AND wt.race_room_id = rr.id
              AND wt.transaction_type = 'race_entry_wallet_debit'
              AND wt.status = 'completed'
          )
          OR EXISTS (
            SELECT 1
            FROM payments pay
            WHERE pay.id = rp.payment_id
              AND pay.user_id = rp.user_id
              AND pay.race_room_id = rr.id
              AND pay.status = 'succeeded'
          )
          OR EXISTS (
            SELECT 1
            FROM coin_transactions ct
            WHERE ct.user_id = rp.user_id
              AND ct.source = 'coins_battle_entry'
              AND ct.source_id = rr.id::text
              AND ct.transaction_type = 'spend'
              AND ct.amount < 0
          )
        )
    ),
    streak_participation AS (
      SELECT DISTINCT
        uc.id AS challenge_id,
        'streakChallenge'::text AS challenge_type
      FROM unlimited_challenge_participants ucp
      JOIN unlimited_challenges uc ON uc.id = ucp.challenge_id
      JOIN eligible_user eu ON eu.id = ucp.user_id
      WHERE uc.started_at_utc IS NOT NULL
        AND ucp.in_settlement_population = true
    ),
    participation AS (
      SELECT challenge_id, challenge_type FROM fixed_participation
      UNION ALL
      SELECT challenge_id, challenge_type FROM streak_participation
    )
    SELECT
      count(*) FILTER (WHERE challenge_type = 'free')::int AS free_count,
      count(*) FILTER (WHERE challenge_type = 'coins')::int AS coins_count,
      count(*) FILTER (WHERE challenge_type = 'topFinishers')::int AS top_finishers_count,
      count(*) FILTER (WHERE challenge_type = 'sponsoredEvents')::int AS sponsored_events_count,
      count(*) FILTER (WHERE challenge_type = 'streakChallenge')::int AS streak_challenge_count
    FROM participation
  `);

  const [row] = rowsFromExecute<ParticipationCountRow>(result);
  return buildChallengeParticipationBreakdown({
    free: Number(row?.free_count ?? 0),
    coins: Number(row?.coins_count ?? 0),
    topFinishers: Number(row?.top_finishers_count ?? 0),
    sponsoredEvents: Number(row?.sponsored_events_count ?? 0),
    streakChallenge: Number(row?.streak_challenge_count ?? 0),
  });
}
