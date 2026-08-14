import { inArray, sql, type SQL } from "drizzle-orm";
import {
  profilesTable,
  stepDailyTotalsTable,
} from "../../db/src/schema/index.js";
import { countryCodeMatchSet } from "./country.js";

export type StepLeaderboardPeriod = "today" | "week" | "month" | "all_time";

export type StepLeaderboardRow = {
  id: string;
  username: string;
  fullName: string;
  country: string | null;
  countryCode: string | null;
  countryFlag: string | null;
  steps: number;
  rank: number;
  avatarColor: string | null;
  avatarUrl: string | null;
  updatedAt: Date | null;
};

type RawStepLeaderboardRow = {
  id: string;
  username: string;
  full_name: string;
  country: string | null;
  country_code: string | null;
  country_flag: string | null;
  steps: number | string;
  rank: number | string;
  avatar_color: string | null;
  avatar_url: string | null;
  updated_at: Date | null;
};

type SqlExecutor = {
  execute(query: SQL): Promise<unknown>;
};

function rowsFromExecute<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

function activeProfileFilters(params: {
  countryCode?: string | null;
  friendIds?: string[] | null;
}): SQL[] {
  const filters: SQL[] = [sql`${profilesTable.accountStatus} NOT IN ('banned', 'deleted')`];

  if (params.countryCode) {
    // Expand to every stored spelling of the same country (US / USA / UNITED STATES) so one
    // region is never split across two leaderboards. Still an equality-style predicate on
    // upper(trim(country_code)), so profiles_country_code_norm_idx remains usable.
    const matches = countryCodeMatchSet(params.countryCode);
    filters.push(
      matches.length === 1
        ? sql`upper(trim(${profilesTable.countryCode})) = ${matches[0]}`
        : sql`upper(trim(${profilesTable.countryCode})) IN (${sql.join(matches.map((m) => sql`${m}`), sql`, `)})`,
    );
  }

  if (params.friendIds && params.friendIds.length > 0) {
    filters.push(inArray(profilesTable.id, params.friendIds));
  }

  return filters;
}

export async function fetchStepLeaderboardRows(
  db: SqlExecutor,
  params: {
    userId: string;
    period: StepLeaderboardPeriod;
    startDate?: string;
    endDate?: string;
    countryCode?: string | null;
    friendIds?: string[] | null;
  },
): Promise<StepLeaderboardRow[]> {
  const profileFilters = sql.join(activeProfileFilters(params), sql` AND `);
  const baseQuery = params.period === "all_time"
    ? sql`
      SELECT
        ${profilesTable.id} AS id,
        ${profilesTable.username} AS username,
        ${profilesTable.fullName} AS full_name,
        ${profilesTable.country} AS country,
        ${profilesTable.countryCode} AS country_code,
        ${profilesTable.countryFlag} AS country_flag,
        ${profilesTable.avatarColor} AS avatar_color,
        ${profilesTable.avatarUrl} AS avatar_url,
        ${profilesTable.updatedAt} AS updated_at,
        ${profilesTable.totalSteps}::int AS steps
      FROM ${profilesTable}
      WHERE ${profileFilters}
        AND ${profilesTable.totalSteps} > 0
    `
    : sql`
      SELECT
        ${profilesTable.id} AS id,
        ${profilesTable.username} AS username,
        ${profilesTable.fullName} AS full_name,
        ${profilesTable.country} AS country,
        ${profilesTable.countryCode} AS country_code,
        ${profilesTable.countryFlag} AS country_flag,
        ${profilesTable.avatarColor} AS avatar_color,
        ${profilesTable.avatarUrl} AS avatar_url,
        ${profilesTable.updatedAt} AS updated_at,
        coalesce(sum(${stepDailyTotalsTable.steps}), 0)::int AS steps
      FROM ${stepDailyTotalsTable}
      INNER JOIN ${profilesTable} ON ${stepDailyTotalsTable.userId} = ${profilesTable.id}
      WHERE ${stepDailyTotalsTable.date} >= ${params.startDate}::date
        AND ${stepDailyTotalsTable.date} <= ${params.endDate}::date
        AND ${profileFilters}
      GROUP BY
        ${profilesTable.id},
        ${profilesTable.username},
        ${profilesTable.fullName},
        ${profilesTable.country},
        ${profilesTable.countryCode},
        ${profilesTable.countryFlag},
        ${profilesTable.avatarColor},
        ${profilesTable.avatarUrl},
        ${profilesTable.updatedAt}
      HAVING coalesce(sum(${stepDailyTotalsTable.steps}), 0) > 0
    `;

  const result = await db.execute(sql`
    WITH base AS (${baseQuery}),
    ranked AS (
      SELECT
        base.*,
        -- Stable secondary key: profiles.updated_at is bumped on every step sync, so it
        -- churns and cannot order ties reproducibly. The primary key is immutable.
        row_number() OVER (ORDER BY base.steps DESC, base.id ASC)::int AS rank
      FROM base
    )
    SELECT
      id,
      username,
      full_name,
      country,
      country_code,
      country_flag,
      avatar_color,
      avatar_url,
      updated_at,
      steps,
      rank
    FROM ranked
    WHERE rank <= 100 OR id = ${params.userId}
    ORDER BY rank
  `);

  return rowsFromExecute<RawStepLeaderboardRow>(result).map((row) => ({
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    country: row.country,
    countryCode: row.country_code,
    countryFlag: row.country_flag,
    avatarColor: row.avatar_color,
    avatarUrl: row.avatar_url,
    updatedAt: row.updated_at,
    steps: Number(row.steps ?? 0),
    rank: Number(row.rank ?? 0),
  }));
}
