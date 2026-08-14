import { Router } from "express";
import { db } from "../../db/src/index.js";
import {
  profilesTable,
  friendsTable,
  userTitlesTable,
  achievementDefinitionsTable,
} from "../../db/src/schema/index.js";
import { eq, and, sql, inArray } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import { normalizeCountryCode } from "../lib/country.js";
import { getLeaderboardPeriodDates } from "../lib/leaderboardPeriods.js";
import {
  fetchStepLeaderboardRows,
  type StepLeaderboardPeriod,
} from "../lib/stepLeaderboardQuery.js";
import { fetchTotalRaceWinningsCents } from "../lib/raceWinnings.js";

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────
function getStepsBadge(rank: number): string {
  if (rank === 1) return "Global Champion";
  if (rank <= 3) return "Elite Walker";
  if (rank <= 10) return "Daily Champion";
  if (rank <= 20) return "Fast Walker";
  if (rank <= 50) return "Beginner Walker";
  return "Walker";
}

function getRaceBadge(rank: number): string {
  if (rank === 1) return "Race Legend";
  if (rank <= 3) return "Race Champion";
  if (rank <= 10) return "Race Master";
  if (rank <= 25) return "Race Expert";
  if (rank <= 50) return "Race Winner";
  return "Race Participant";
}

function getRewardAmount(rank: number): number {
  const rewards: Record<number, number> = {
    1: 50, 2: 30, 3: 20, 4: 15, 5: 10,
    6: 8,  7: 6,  8: 5,  9: 5,  10: 5,
  };
  return rewards[rank] ?? 0;
}

const AVATAR_COLORS = [
  "#00E676", "#00B4FF", "#06B6D4", "#FFD700", "#FF6B35",
  "#A855F7", "#F472B6", "#34D399", "#60A5FA", "#FBBF24",
];
function rowsFromExecute<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

// ── GET /api/leaderboard ──────────────────────────────────────────────────────
// query: period=today|week|month|all_time  scope=global|regional|friends  countryCode=XX
router.get("/leaderboard", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const requestedPeriod = (req.query.period as string) || "all_time";
  const period: StepLeaderboardPeriod =
    requestedPeriod === "today" || requestedPeriod === "week" || requestedPeriod === "month" || requestedPeriod === "all_time"
      ? requestedPeriod
      : "all_time";
  const scope       = (req.query.scope as string)       || "global";
  const friendsOnly = req.query.friendsOnly === "true";

  const [callerProfile] = await db
    .select({ countryCode: profilesTable.countryCode })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);
  const regionalCountryCode = normalizeCountryCode(callerProfile?.countryCode);

  if (scope === "regional") {
    if (!regionalCountryCode) {
      return res.json({ leaderboard: [], userRank: null, reason: "NO_COUNTRY_SET" });
    }
  }

  let friendIds: string[] | null = null;
  if (scope === "friends" || friendsOnly) {
    // Friends stored bidirectionally; query where userId = me to get all friend IDs
    const friendRows = await db
      .select({ id: friendsTable.friendId })
      .from(friendsTable)
      .where(eq(friendsTable.userId, userId));

    friendIds = [...new Set([...friendRows.map((r) => r.id), userId])];
  }

  // ── Step-based ranking ────────────────────────────────────────────────────
  const periodDates = period === "all_time"
    ? { startDate: undefined, endDate: undefined }
    : getLeaderboardPeriodDates(
      period,
      req.query.localDate,
      req.query.weekStart,
      req.query.monthStart,
    );
  const rankedRows = await fetchStepLeaderboardRows(db, {
    userId,
    period,
    startDate: periodDates.startDate,
    endDate: periodDates.endDate,
    countryCode: scope === "regional" ? regionalCountryCode : null,
    friendIds,
  });
  const rows = rankedRows.filter((r) => r.rank <= 100);

  // ── Batch-fetch active titles for all users in result ────────────────────
  const rowIds = rows.map((r) => r.id);
  const activeTitleMap = new Map<string, string>();
  if (rowIds.length > 0) {
    const titleRows = await db
      .select({
        userId: userTitlesTable.userId,
        title: achievementDefinitionsTable.title,
      })
      .from(userTitlesTable)
      .innerJoin(
        achievementDefinitionsTable,
        eq(userTitlesTable.achievementCode, achievementDefinitionsTable.code),
      )
      .where(and(inArray(userTitlesTable.userId, rowIds), eq(userTitlesTable.isActive, true)));
    for (const t of titleRows) activeTitleMap.set(t.userId, t.title);
  }

  const leaderboard = rows.map((row, i) => {
    const rank = row.rank;
    return {
      id: row.id,
      username: row.username,
      fullName: row.fullName,
      country: row.country ?? "",
      countryCode: row.countryCode ?? "",
      countryFlag: row.countryFlag ?? "🏳️",
      steps: row.steps ?? 0,
      rank,
      // Prefer the user's equipped title; fall back to rank-based badge.
      badge: activeTitleMap.get(row.id) ?? getStepsBadge(rank),
      isVerified: true,
      // Reward amounts are not paid out per period yet — return 0 so the UI
      // falls back to showing the badge instead of a misleading coin pill.
      rewardAmount: 0,
      avatarColor: row.avatarColor ?? AVATAR_COLORS[i % AVATAR_COLORS.length],
      avatarUrl: row.avatarUrl ?? null,
      avatarVersion: row.updatedAt instanceof Date ? row.updatedAt.getTime() : 0,
    };
  });

  // ── Current user's rank ───────────────────────────────────────────────────
  // The ranked CTE already carries the viewer's own row even when it falls outside the
  // top 100, so the personal card can show a real rank AND a real metric instead of
  // falling back to 0 (the visible list is truncated; this row is not).
  const myRankedRow = rankedRows.find((u) => u.id === userId);
  const userRank = myRankedRow?.rank ?? 9999;
  const userMetric = myRankedRow?.steps ?? 0;

  return res.json({ leaderboard, userRank, userMetric });
});

// ── GET /api/leaderboard/races ────────────────────────────────────────────────
// query: entryType=free|paid_1|paid_3|paid_5
// Returns users ranked by race wins. A win is any rewarded placement.
router.get("/leaderboard/races", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const entryType = req.query.entryType as string | undefined;

  const validEntryTypes = ["free", "paid_1", "paid_3", "paid_5"] as const;
  type EntryType = (typeof validEntryTypes)[number];
  const filteredEntryType: EntryType | undefined =
    entryType && validEntryTypes.includes(entryType as EntryType)
      ? (entryType as EntryType)
      : undefined;

  type RaceRow = {
    id: string;
    username: string;
    full_name: string;
    country: string | null;
    country_code: string | null;
    country_flag: string | null;
    avatar_color: string | null;
    avatar_url: string | null;
    updated_at: Date | null;
    wins: number | string;
    total_winning_cents: number | string | null;
  };

  const entryTypeFilter = filteredEntryType
    ? sql`AND rm.entry_type = ${filteredEntryType}`
    : sql``;
  const unlimitedWinsSource = filteredEntryType
    ? sql`SELECT NULL::text AS user_id, 0::int AS wins WHERE false`
    : sql`
      SELECT up.user_id, count(*)::int AS wins
      FROM unlimited_challenge_payouts up
      JOIN unlimited_challenges uc ON uc.id = up.challenge_id
      JOIN profiles p ON p.id = up.user_id
      WHERE up.status = 'credited'
        AND up.payout_cents > 0
        AND uc.settlement_status = 'completed'
        AND p.account_status NOT IN ('banned', 'deleted')
      GROUP BY up.user_id
    `;

  const raceRowsResult = await db.execute(sql`
    WITH classic_wins AS (
      SELECT rr.user_id, count(*)::int AS wins
      FROM race_results rr
      JOIN race_rooms rm ON rr.race_room_id::uuid = rm.id
      JOIN profiles p ON p.id = rr.user_id
      WHERE rr.eligible_for_prize = true
        AND rm.status = 'completed'
        -- A result under ops review or flagged as simulation is never a win. These normally
        -- also carry eligible_for_prize = false, but POST /races/:id/reconcile can rewrite a
        -- settled row's status without touching eligibility, so the status is checked too.
        -- NOTE: 'pending_verification' is deliberately NOT excluded here — it is the column
        -- default, so legacy rows written before the status column was populated carry it,
        -- and excluding it would silently erase historical wins. See the open decision.
        AND rr.status NOT IN ('review_required', 'disqualified_simulation')
        AND p.account_status NOT IN ('banned', 'deleted')
        ${entryTypeFilter}
      GROUP BY rr.user_id
    ),
    unlimited_wins AS (${unlimitedWinsSource}),
    wins_by_user AS (
      SELECT user_id, sum(wins)::int AS wins
      FROM (
        SELECT * FROM classic_wins
        UNION ALL
        SELECT * FROM unlimited_wins
      ) all_wins
      GROUP BY user_id
    ),
    cash_winnings AS (
      SELECT user_id, coalesce(sum(amount_cents), 0)::int AS cents
      FROM wallet_transactions
      WHERE transaction_type = 'race_prize_paid'
        AND status = 'completed'
      GROUP BY user_id
    ),
    unlimited_winnings AS (
      SELECT up.user_id, coalesce(sum(up.payout_cents), 0)::int AS cents
      FROM unlimited_challenge_payouts up
      JOIN unlimited_challenges uc ON uc.id = up.challenge_id
      WHERE up.status = 'credited'
        AND up.payout_cents > 0
        AND uc.settlement_status = 'completed'
        AND NOT EXISTS (
          SELECT 1 FROM wallet_transactions wt
          WHERE wt.user_id = up.user_id
            AND wt.race_room_id::text = up.challenge_id
            AND wt.transaction_type = 'race_prize_paid'
            AND wt.status = 'completed'
        )
      GROUP BY up.user_id
    ),
    total_winnings AS (
      SELECT user_id, sum(cents)::int AS total_winning_cents
      FROM (
        SELECT * FROM cash_winnings
        UNION ALL
        SELECT * FROM unlimited_winnings
      ) all_money
      GROUP BY user_id
    ),
    ranked AS (
      SELECT
        p.id,
        p.username,
        p.full_name,
        p.country,
        p.country_code,
        p.country_flag,
        p.avatar_color,
        p.avatar_url,
        p.updated_at,
        wb.wins,
        coalesce(tw.total_winning_cents, 0)::int AS total_winning_cents,
        row_number() OVER (ORDER BY wb.wins DESC, p.id ASC)::int AS rank
      FROM wins_by_user wb
      JOIN profiles p ON p.id = wb.user_id
      LEFT JOIN total_winnings tw ON tw.user_id = wb.user_id
    )
    SELECT *
    FROM ranked
    WHERE rank <= 100 OR id = ${userId}
    ORDER BY rank
  `);
  const rankedRows = rowsFromExecute<RaceRow & { rank: number | string }>(raceRowsResult);
  const rows = rankedRows.filter((row) => Number(row.rank) <= 100);

  const leaderboard = rows.map((row, i) => {
    const rank = Number(row.rank ?? 0);
    return {
      id: row.id,
      username: row.username,
      fullName: row.full_name,
      country: row.country ?? "",
      countryCode: row.country_code ?? "",
      countryFlag: row.country_flag ?? "🏳️",
      wins: Number(row.wins ?? 0),
      totalWinning: Number(row.total_winning_cents ?? 0) / 100,
      rank,
      badge: getRaceBadge(rank),
      avatarColor: row.avatar_color ?? AVATAR_COLORS[i % AVATAR_COLORS.length],
      avatarUrl: row.avatar_url ?? null,
      avatarVersion: row.updated_at instanceof Date ? row.updated_at.getTime() : 0,
    };
  });

  // ── Current user's race rank ──────────────────────────────────────────────
  const myRankedEntry = rankedRows.find((u) => u.id === userId);
  let userRank = 9999;
  let userWins = 0;
  let userTotalWinning = 0;

  if (myRankedEntry) {
    userRank = Number(myRankedEntry.rank ?? 9999);
    userWins = Number(myRankedEntry.wins ?? 0);
    userTotalWinning = Number(myRankedEntry.total_winning_cents ?? 0) / 100;
  } else {
    userTotalWinning = await fetchTotalRaceWinningsCents(db, userId) / 100;
  }

  return res.json({ leaderboard, userRank, userWins, userTotalWinning });
});

// ── GET /api/leaderboard/coins ─────────────────────────────────────────────────
router.get("/leaderboard/coins", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  type CoinRow = {
    uid: string;
    total_coins: number | string;
    username: string | null;
    full_name: string | null;
    country: string | null;
    country_code: string | null;
    country_flag: string | null;
    avatar_color: string | null;
    avatar_url: string | null;
    updated_at: Date | null;
  };

  const coinsWonCondition = sql`
    (
      left(reward_code, 17) = 'COINS_BATTLE_WIN_'
      OR position('_RACE_WIN_' in reward_code) > 0
      OR reward_code IN ('PUBLIC_ROOM_WIN', 'PRIVATE_ROOM_WIN')
    )
  `;

  // Sign handling for refund/adjustment is DELIBERATELY left as-is pending the production
  // distribution audit (`pnpm audit:leaderboard`, section 2b).
  //
  // Verified 2026-08-14: this branch is currently unreachable in production. The only coin
  // `refund` writer is sponsoredEvents.ts (leaving a sponsored event), and it writes a POSITIVE
  // credit with rewardCode: null — so it cannot satisfy coinsWonCondition. There are no
  // `adjustment` writers at all. Changing the expression today would alter nothing except the
  // test fixture, so the existing semantics stay locked until the audit shows real rows.
  const coinRowsResult = await db.execute(sql`
    WITH totals AS (
      SELECT
        user_id,
        sum(
          CASE
            WHEN transaction_type = 'earn' THEN amount
            ELSE -abs(amount)
          END
        )::int AS total_coins
      FROM coin_transactions
      WHERE transaction_type IN ('earn', 'refund', 'adjustment')
        AND ${coinsWonCondition}
      GROUP BY user_id
      HAVING sum(
        CASE
          WHEN transaction_type = 'earn' THEN amount
          ELSE -abs(amount)
        END
      ) > 0
    )
    , ranked AS (
      SELECT
        totals.user_id AS uid,
        totals.total_coins,
        p.username,
        p.full_name,
        p.country,
        p.country_code,
        p.country_flag,
        p.avatar_color,
        p.avatar_url,
        p.updated_at,
        row_number() OVER (ORDER BY totals.total_coins DESC, totals.user_id ASC)::int AS rank
      FROM totals
      JOIN profiles p ON p.id = totals.user_id
      WHERE p.account_status NOT IN ('banned', 'deleted')
    )
    SELECT *
    FROM ranked
    WHERE rank <= 50 OR uid = ${userId}
    ORDER BY rank
  `);
  const rankedRows = rowsFromExecute<CoinRow & { rank: number | string }>(coinRowsResult);
  const rows = rankedRows.filter((row) => Number(row.rank) <= 50);

  const leaderboard = rows.map((r, i) => {
    const rank = Number(r.rank ?? 0);
    return {
      id: r.uid,
      username: r.username ?? "unknown",
      fullName: r.full_name ?? "",
      country: r.country ?? "",
      countryCode: r.country_code ?? "",
      countryFlag: r.country_flag ?? "🏳️",
      avatarColor: r.avatar_color ?? AVATAR_COLORS[i % AVATAR_COLORS.length],
      avatarUrl: r.avatar_url ?? null,
      avatarVersion: r.updated_at instanceof Date ? r.updated_at.getTime() : 0,
      metric: Number(r.total_coins ?? 0),
      metricLabel: "coins won",
      rank,
      badge: getRaceBadge(rank),
      rewardAmount: 0,
    };
  });

  // Same as the step board: the viewer's row survives the top-50 cut in the CTE, so the
  // personal card gets both a real rank and a real coins-won total.
  const myRankedRow = rankedRows.find((row) => row.uid === userId);
  const userRank = myRankedRow?.rank ?? 9999;
  const userMetric = Number(myRankedRow?.total_coins ?? 0);

  return res.json({ leaderboard, userRank: Number(userRank), userMetric });
});

// ── GET /api/leaderboard/groups ────────────────────────────────────────────────
router.get("/leaderboard/groups", requireAuth, async (req, res) => {
  const period = (req.query.period as string) === "all_time" ? "all_time" : "today";
  const rawLocalDate = req.query.localDate as string | undefined;
  const today = getLeaderboardPeriodDates("today", rawLocalDate).startDate;

  req.log?.info({ period, today }, "[GroupLeaderboard] fetch started");

  type GroupRow = {
    group_id: string;
    group_name: string;
    group_type: string | null;
    custom_group_type: string | null;
    group_image_url: string | null;
    group_updated_at: Date | null;
    total_steps: number | string;
    member_count: number | string;
    rank: number | string;
  };
  const dateFilter = period === "today" ? sql`WHERE wgds.step_date::date = ${today}::date` : sql``;
  const groupRowsResult = await db.execute(sql`
    WITH active_members AS (
      SELECT group_id, count(distinct user_id)::int AS member_count
      FROM walking_group_members
      WHERE status = 'active'
      GROUP BY group_id
    ),
    step_totals AS (
      SELECT
        wgds.group_id,
        coalesce(sum(wgds.daily_steps), 0)::int AS total_steps
      FROM walking_group_daily_steps wgds
      JOIN walking_group_members active_member
        ON active_member.group_id = wgds.group_id
       AND active_member.user_id = wgds.user_id
       AND active_member.status = 'active'
      ${dateFilter}
      GROUP BY wgds.group_id
    ),
    base AS (
      SELECT
        wg.id AS group_id,
        wg.group_name,
        wg.group_type,
        wg.custom_group_type,
        wg.group_image_url,
        wg.updated_at AS group_updated_at,
        coalesce(st.total_steps, 0)::int AS total_steps,
        am.member_count
      FROM walking_groups wg
      JOIN active_members am ON am.group_id = wg.id
      LEFT JOIN step_totals st ON st.group_id = wg.id
      WHERE wg.status = 'active'
    ),
    ranked AS (
      SELECT
        base.*,
        row_number() OVER (ORDER BY base.total_steps DESC, base.group_id ASC)::int AS rank
      FROM base
    )
    SELECT *
    FROM ranked
    WHERE rank <= 50
    ORDER BY rank
  `);
  const rows = rowsFromExecute<GroupRow>(groupRowsResult);

  const label = period === "today"
    ? "Groups ranked by total steps today"
    : "Groups ranked by all-time total steps";
  const periodLabel = period === "today" ? "today steps" : "all-time steps";

  const groups = rows.map((r) => ({
    rank: Number(r.rank ?? 0),
    id: r.group_id,
    name: r.group_name,
    type: r.group_type ?? "custom",
    customGroupType: r.custom_group_type ?? null,
    groupImageUrl: r.group_image_url ?? null,
    imageVersion: r.group_updated_at instanceof Date ? r.group_updated_at.getTime() : 0,
    totalSteps: Number(r.total_steps ?? 0),
    memberCount: Number(r.member_count ?? 0),
    periodLabel,
  }));

  req.log?.info({ period, count: groups.length, topGroup: groups[0]?.name, topSteps: groups[0]?.totalSteps }, "[GroupLeaderboard] returned");
  return res.json({ success: true, period, label, groups, leaderboard: groups });
});

export default router;
