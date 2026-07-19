import { Router } from "express";
import { db } from "../../db/src/index.js";
import {
  profilesTable,
  stepDailyTotalsTable,
  friendsTable,
  raceResultsTable,
  raceRoomsTable,
  userTitlesTable,
  achievementDefinitionsTable,
  coinTransactionsTable,
  walkingGroupsTable,
  walkingGroupMembersTable,
  walkingGroupDailyStepsTable,
} from "../../db/src/schema/index.js";
import { desc, eq, and, gte, lte, gt, ne, sql, inArray, notInArray } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";

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
const RACE_WIN_RANK = 1;

/** Validates a client-supplied YYYY-MM-DD date string. */
function isValidDateStr(s: unknown): s is string {
  if (typeof s !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const dt = new Date(s + "T00:00:00Z");
  return !isNaN(dt.getTime());
}

/**
 * Compute the date range for a leaderboard period.
 *
 * Prefers client-supplied local date parameters (sent by every client since
 * the timezone fix) so the period boundaries match the user's calendar day
 * rather than the server's UTC date.
 *
 * Params (all optional, client-provided):
 *   localDate  — user's local today (YYYY-MM-DD)
 *   weekStart  — first day of the user's local calendar week (YYYY-MM-DD)
 *   monthStart — first day of the user's local calendar month (YYYY-MM-DD)
 *
 * Falls back to server UTC computation when params are absent/invalid.
 */
function getPeriodDates(
  period: string,
  localDate?: unknown,
  weekStart?: unknown,
  monthStart?: unknown,
): { startDate: string; endDate: string } {
  // "today" as seen by the user — prefer client param, fall back to UTC
  const todayStr = isValidDateStr(localDate)
    ? localDate
    : new Date().toISOString().split("T")[0];

  if (period === "today") return { startDate: todayStr, endDate: todayStr };

  if (period === "week") {
    let start: string;
    if (isValidDateStr(weekStart)) {
      start = weekStart;
    } else {
      // UTC fallback: Monday of the server's current UTC week
      const now = new Date();
      const day = now.getUTCDay();
      const monday = new Date(now);
      monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7));
      start = monday.toISOString().split("T")[0];
    }
    return { startDate: start, endDate: todayStr };
  }

  if (period === "month") {
    let start: string;
    if (isValidDateStr(monthStart)) {
      start = monthStart;
    } else {
      // UTC fallback: first of the server's current UTC month
      const now = new Date();
      start = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    }
    return { startDate: start, endDate: todayStr };
  }

  return { startDate: "", endDate: "" }; // all_time
}

// ── GET /api/leaderboard ──────────────────────────────────────────────────────
// query: period=today|week|month|all_time  scope=global|regional|friends  countryCode=XX
router.get("/leaderboard", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const period      = (req.query.period as string)      || "all_time";
  const scope       = (req.query.scope as string)       || "global";
  const countryCode = req.query.countryCode as string | undefined;

  // ── Profile-level filters ─────────────────────────────────────────────────
  const profileFilters = [notInArray(profilesTable.accountStatus, ["banned", "deleted"])];

  if (scope === "regional" && countryCode) {
    profileFilters.push(eq(profilesTable.countryCode, countryCode));
  }

  if (scope === "friends") {
    // Friends stored bidirectionally; query where userId = me to get all friend IDs
    const friendRows = await db
      .select({ id: friendsTable.friendId })
      .from(friendsTable)
      .where(eq(friendsTable.userId, userId));

    const friendIds = [...new Set([...friendRows.map((r) => r.id), userId])];
    profileFilters.push(inArray(profilesTable.id, friendIds));
  }

  // ── Step-based ranking ────────────────────────────────────────────────────
  type Row = {
    id: string; username: string; fullName: string;
    country: string | null; countryCode: string | null; countryFlag: string | null;
    steps: number; avatarColor: string | null; avatarUrl: string | null; updatedAt: Date | null;
  };

  let rows: Row[];

  if (period === "all_time") {
    rows = await db
      .select({
        id: profilesTable.id,
        username: profilesTable.username,
        fullName: profilesTable.fullName,
        country: profilesTable.country,
        countryCode: profilesTable.countryCode,
        countryFlag: profilesTable.countryFlag,
        steps: profilesTable.totalSteps,
        avatarColor: profilesTable.avatarColor,
        avatarUrl: profilesTable.avatarUrl,
        updatedAt: profilesTable.updatedAt,
      })
      .from(profilesTable)
      .where(and(...profileFilters, gt(profilesTable.totalSteps, 0)))
      .orderBy(desc(profilesTable.totalSteps))
      .limit(100);
  } else {
    const { startDate, endDate } = getPeriodDates(
      period,
      req.query.localDate,
      req.query.weekStart,
      req.query.monthStart,
    );
    rows = await db
      .select({
        id: profilesTable.id,
        username: profilesTable.username,
        fullName: profilesTable.fullName,
        country: profilesTable.country,
        countryCode: profilesTable.countryCode,
        countryFlag: profilesTable.countryFlag,
        avatarColor: profilesTable.avatarColor,
        avatarUrl: profilesTable.avatarUrl,
        updatedAt: profilesTable.updatedAt,
        steps: sql<number>`CAST(COALESCE(sum(${stepDailyTotalsTable.steps}), 0) AS INTEGER)`,
      })
      .from(stepDailyTotalsTable)
      .innerJoin(profilesTable, eq(stepDailyTotalsTable.userId, profilesTable.id))
      .where(and(
        gte(stepDailyTotalsTable.date, startDate),
        lte(stepDailyTotalsTable.date, endDate),
        ...profileFilters,
      ))
      .groupBy(
        profilesTable.id, profilesTable.username, profilesTable.fullName,
        profilesTable.country, profilesTable.countryCode, profilesTable.countryFlag,
        profilesTable.avatarColor, profilesTable.avatarUrl, profilesTable.updatedAt,
      )
      .orderBy(desc(sql`sum(${stepDailyTotalsTable.steps})`))
      .limit(100);
  }

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
    const rank = i + 1;
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
      avatarVersion: row.updatedAt?.getTime() ?? 0,
    };
  });

  // ── Current user's rank ───────────────────────────────────────────────────
  let userRank = 9999;
  const myEntry = leaderboard.find((u) => u.id === userId);
  if (myEntry) {
    userRank = myEntry.rank;
  } else if (period === "all_time") {
    const [myProfile] = await db
      .select({ totalSteps: profilesTable.totalSteps })
      .from(profilesTable)
      .where(eq(profilesTable.id, userId))
      .limit(1);
    if (myProfile) {
      const countAbove = await db.$count(
        profilesTable,
        and(
          ne(profilesTable.id, userId),
          gte(profilesTable.totalSteps, (myProfile.totalSteps ?? 0) + 1),
          notInArray(profilesTable.accountStatus, ["banned", "deleted"]),
        ),
      );
      userRank = Number(countAbove) + 1;
    }
  }

  return res.json({ leaderboard, userRank });
});

// ── GET /api/leaderboard/races ────────────────────────────────────────────────
// query: entryType=free|paid_1|paid_3|paid_5
// Returns users ranked by race wins. A win is an actual 1st-place finish.
router.get("/leaderboard/races", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const entryType = req.query.entryType as string | undefined;

  const validEntryTypes = ["free", "paid_1", "paid_3", "paid_5"] as const;
  type EntryType = (typeof validEntryTypes)[number];
  const filteredEntryType: EntryType | undefined =
    entryType && validEntryTypes.includes(entryType as EntryType)
      ? (entryType as EntryType)
      : undefined;

  // Build where conditions — only eligible 1st place counts toward win totals.
  const whereConditions = [
    eq(raceResultsTable.rank, RACE_WIN_RANK),
    eq(raceResultsTable.eligibleForPrize, true),
    notInArray(profilesTable.accountStatus, ["banned", "deleted"]),
  ];
  if (filteredEntryType) {
    whereConditions.push(eq(raceRoomsTable.entryType, filteredEntryType));
  }

  // ── Win counts per user ───────────────────────────────────────────────────
  const rows = await db
    .select({
      id: profilesTable.id,
      username: profilesTable.username,
      fullName: profilesTable.fullName,
      country: profilesTable.country,
      countryCode: profilesTable.countryCode,
      countryFlag: profilesTable.countryFlag,
      avatarColor: profilesTable.avatarColor,
      avatarUrl: profilesTable.avatarUrl,
      updatedAt: profilesTable.updatedAt,
      wins: sql<number>`count(${raceResultsTable.id})::int`,
    })
    .from(raceResultsTable)
    .innerJoin(raceRoomsTable, sql`${raceResultsTable.raceRoomId}::uuid = ${raceRoomsTable.id}`)
    .innerJoin(profilesTable, eq(raceResultsTable.userId, profilesTable.id))
    .where(and(...whereConditions))
    .groupBy(
      profilesTable.id,
      profilesTable.username,
      profilesTable.fullName,
      profilesTable.country,
      profilesTable.countryCode,
      profilesTable.countryFlag,
      profilesTable.avatarColor,
      profilesTable.avatarUrl,
      profilesTable.updatedAt,
    )
    .orderBy(desc(sql`count(${raceResultsTable.id})`))
    .limit(100);

  const leaderboard = rows.map((row, i) => {
    const rank = i + 1;
    return {
      id: row.id,
      username: row.username,
      fullName: row.fullName,
      country: row.country ?? "",
      countryCode: row.countryCode ?? "",
      countryFlag: row.countryFlag ?? "🏳️",
      wins: row.wins ?? 0,
      rank,
      badge: getRaceBadge(rank),
      avatarColor: row.avatarColor ?? AVATAR_COLORS[i % AVATAR_COLORS.length],
      avatarUrl: row.avatarUrl ?? null,
      avatarVersion: row.updatedAt?.getTime() ?? 0,
    };
  });

  // ── Current user's race rank ──────────────────────────────────────────────
  const myEntry = leaderboard.find((u) => u.id === userId);
  let userRank = 9999;
  let userWins = 0;

  if (myEntry) {
    userRank = myEntry.rank;
    userWins = myEntry.wins;
  } else {
    // Count user's own wins to determine rank
    const myWinConditions = [
      eq(raceResultsTable.userId, userId),
      eq(raceResultsTable.rank, RACE_WIN_RANK),
      eq(raceResultsTable.eligibleForPrize, true),
    ];
    if (filteredEntryType) myWinConditions.push(eq(raceRoomsTable.entryType, filteredEntryType));

    const [myWinRow] = await db
      .select({ wins: sql<number>`count(*)::int` })
      .from(raceResultsTable)
      .innerJoin(raceRoomsTable, sql`${raceResultsTable.raceRoomId}::uuid = ${raceRoomsTable.id}`)
      .where(and(...myWinConditions))
      .limit(1);

    userWins = myWinRow?.wins ?? 0;
    if (userWins > 0) {
      // Count users with more wins than the current user
      const aboveConditions = [
        eq(raceResultsTable.rank, RACE_WIN_RANK),
        eq(raceResultsTable.eligibleForPrize, true),
        notInArray(profilesTable.accountStatus, ["banned", "deleted"]),
        ne(profilesTable.id, userId),
      ];
      if (filteredEntryType) aboveConditions.push(eq(raceRoomsTable.entryType, filteredEntryType));

      const aboveRows = await db
        .select({ uid: profilesTable.id, cnt: sql<number>`count(*)::int` })
        .from(raceResultsTable)
        .innerJoin(raceRoomsTable, sql`${raceResultsTable.raceRoomId}::uuid = ${raceRoomsTable.id}`)
        .innerJoin(profilesTable, eq(raceResultsTable.userId, profilesTable.id))
        .where(and(...aboveConditions))
        .groupBy(profilesTable.id)
        .having(sql`count(*) > ${userWins}`);

      userRank = aboveRows.length + 1;
    }
  }

  return res.json({ leaderboard, userRank, userWins });
});

// ── GET /api/leaderboard/coins ─────────────────────────────────────────────────
router.get("/leaderboard/coins", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const rows = await db
    .select({
      uid: coinTransactionsTable.userId,
      totalCoins: sql<number>`sum(${coinTransactionsTable.amount})::int`,
      username: profilesTable.username,
      fullName: profilesTable.fullName,
      country: profilesTable.country,
      countryCode: profilesTable.countryCode,
      countryFlag: profilesTable.countryFlag,
      avatarColor: profilesTable.avatarColor,
      avatarUrl: profilesTable.avatarUrl,
      updatedAt: profilesTable.updatedAt,
    })
    .from(coinTransactionsTable)
    .innerJoin(profilesTable, eq(coinTransactionsTable.userId, profilesTable.id))
    .where(
      and(
        eq(coinTransactionsTable.transactionType, "earn"),
        notInArray(profilesTable.accountStatus, ["banned", "deleted"]),
      ),
    )
    .groupBy(
      coinTransactionsTable.userId,
      profilesTable.username,
      profilesTable.fullName,
      profilesTable.country,
      profilesTable.countryCode,
      profilesTable.countryFlag,
      profilesTable.avatarColor,
      profilesTable.avatarUrl,
      profilesTable.updatedAt,
    )
    .orderBy(desc(sql`sum(${coinTransactionsTable.amount})`))
    .limit(50);

  let userRank = 9999;
  const leaderboard = rows.map((r, i) => {
    const rank = i + 1;
    if (r.uid === userId) userRank = rank;
    return {
      id: r.uid,
      username: r.username ?? "unknown",
      fullName: r.fullName ?? "",
      country: r.country ?? "",
      countryCode: r.countryCode ?? "",
      countryFlag: r.countryFlag ?? "🏳️",
      avatarColor: r.avatarColor ?? AVATAR_COLORS[i % AVATAR_COLORS.length],
      avatarUrl: r.avatarUrl ?? null,
      avatarVersion: r.updatedAt?.getTime() ?? 0,
      metric: r.totalCoins ?? 0,
      metricLabel: "coins won",
      rank,
      badge: getRaceBadge(rank),
      rewardAmount: 0,
    };
  });

  return res.json({ leaderboard, userRank });
});

// ── GET /api/leaderboard/groups ────────────────────────────────────────────────
router.get("/leaderboard/groups", requireAuth, async (req, res) => {
  const period = (req.query.period as string) === "all_time" ? "all_time" : "today";
  const rawLocalDate = req.query.localDate as string | undefined;
  const isValidDate = rawLocalDate && /^\d{4}-\d{2}-\d{2}$/.test(rawLocalDate);
  const today = isValidDate ? rawLocalDate : (new Date().toISOString().split("T")[0] ?? "");

  req.log.info({ period, today }, "[GroupLeaderboard] fetch started");

  let rows: { groupId: string; groupName: string; groupType: string | null; customGroupType: string | null; groupImageUrl: string | null; groupUpdatedAt: Date | null; totalSteps: number; memberCount: number }[];

  if (period === "today") {
    rows = await db
      .select({
        groupId: walkingGroupsTable.id,
        groupName: walkingGroupsTable.groupName,
        groupType: walkingGroupsTable.groupType,
        customGroupType: walkingGroupsTable.customGroupType,
        groupImageUrl: walkingGroupsTable.groupImageUrl,
        groupUpdatedAt: walkingGroupsTable.updatedAt,
        totalSteps: sql<number>`coalesce((
          select sum(wgds.daily_steps)
          from walking_group_daily_steps wgds
          where wgds.group_id = ${walkingGroupsTable.id}
          and wgds.step_date::date = ${today}::date
        ), 0)::int`,
        memberCount: sql<number>`count(distinct ${walkingGroupMembersTable.userId})::int`,
      })
      .from(walkingGroupsTable)
      .innerJoin(
        walkingGroupMembersTable,
        and(
          eq(walkingGroupMembersTable.groupId, walkingGroupsTable.id),
          eq(walkingGroupMembersTable.status, "active"),
        ),
      )
      .where(eq(walkingGroupsTable.status, "active"))
      .groupBy(walkingGroupsTable.id, walkingGroupsTable.groupName, walkingGroupsTable.groupType, walkingGroupsTable.customGroupType, walkingGroupsTable.groupImageUrl, walkingGroupsTable.updatedAt)
      .orderBy(desc(sql`coalesce((
        select sum(wgds.daily_steps)
        from walking_group_daily_steps wgds
        where wgds.group_id = ${walkingGroupsTable.id}
        and wgds.step_date::date = ${today}::date
      ), 0)`))
      .limit(50);
  } else {
    rows = await db
      .select({
        groupId: walkingGroupsTable.id,
        groupName: walkingGroupsTable.groupName,
        groupType: walkingGroupsTable.groupType,
        customGroupType: walkingGroupsTable.customGroupType,
        groupImageUrl: walkingGroupsTable.groupImageUrl,
        groupUpdatedAt: walkingGroupsTable.updatedAt,
        totalSteps: sql<number>`coalesce((
          select sum(wgds.daily_steps)
          from walking_group_daily_steps wgds
          where wgds.group_id = ${walkingGroupsTable.id}
        ), 0)::int`,
        memberCount: sql<number>`count(distinct ${walkingGroupMembersTable.userId})::int`,
      })
      .from(walkingGroupsTable)
      .innerJoin(
        walkingGroupMembersTable,
        and(
          eq(walkingGroupMembersTable.groupId, walkingGroupsTable.id),
          eq(walkingGroupMembersTable.status, "active"),
        ),
      )
      .where(eq(walkingGroupsTable.status, "active"))
      .groupBy(walkingGroupsTable.id, walkingGroupsTable.groupName, walkingGroupsTable.groupType, walkingGroupsTable.customGroupType, walkingGroupsTable.groupImageUrl, walkingGroupsTable.updatedAt)
      .orderBy(desc(sql`coalesce((
        select sum(wgds.daily_steps)
        from walking_group_daily_steps wgds
        where wgds.group_id = ${walkingGroupsTable.id}
      ), 0)`))
      .limit(50);
  }

  const label = period === "today"
    ? "Groups ranked by total steps today"
    : "Groups ranked by all-time total steps";
  const periodLabel = period === "today" ? "today steps" : "all-time steps";

  const groups = rows.map((r, i) => ({
    rank: i + 1,
    id: r.groupId,
    name: r.groupName,
    type: r.groupType ?? "custom",
    customGroupType: r.customGroupType ?? null,
    groupImageUrl: r.groupImageUrl ?? null,
    imageVersion: r.groupUpdatedAt?.getTime() ?? 0,
    totalSteps: r.totalSteps ?? 0,
    memberCount: r.memberCount ?? 0,
    periodLabel,
  }));

  req.log.info({ period, count: groups.length, topGroup: groups[0]?.name, topSteps: groups[0]?.totalSteps }, "[GroupLeaderboard] returned");
  return res.json({ success: true, period, label, groups, leaderboard: groups });
});

export default router;
