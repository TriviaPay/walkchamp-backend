/**
 * Title evaluation service.
 * Computes all user achievement metrics from real NeonDB data and updates
 * user_achievements + user_titles. Idempotent — safe to call multiple times.
 */
import { pool, db } from "../../db/src/index.js";
import {
  achievementDefinitionsTable,
  userAchievementsTable,
  userTitlesTable,
} from "../../db/src/schema/index.js";
import { eq, and, sql, inArray } from "drizzle-orm";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Metrics {
  // Steps
  hasAnySteps:          boolean;
  lifetimeSteps:        number;
  maxSingleDay:         number;
  maxWeeklySteps:       number;
  maxMonthlySteps:      number;
  activeDaysCount:      number;
  bestWeekActiveDays:   number;
  goalStreakMax:         number;
  weekdayGoalStreak:    number;
  pct25Days:            number;
  pct50Days:            number;
  pct75Days:            number;
  pct100Days:           number;
  morningWalkDays:      number;
  nightWalkDays:        number;
  // Races
  joinedRaces:          number;
  completedRaces:       number;
  raceWins:             number;
  racePodiums:          number;
  freeWins:             number;
  coinsBattleWins:      number;
  coinsBattleJoined:    number;
  publicWins:           number;
  privateWins:          number;
  privateCompleted:     number;
  sponsoredJoined:      number;
  sponsoredWins:        number;
  fastFinishes:         number;
  fast1kFinishes:       number;
  comebackTop3:         number;
  coinsEarned:          number;
  // Social
  friendsCount:         number;
  chatMessages:         number;
  liveCheers:           number;
  spectatedRaces:       number;
  profileCompleted:     boolean;
  // Groups
  groupsCreated:        number;
  groupsJoined:         number;
  groupInvitesSent:     number;
  groupActivityDays:    number;
  groupStepsContributed:number;
  groupMembersTotal:    number;
  groupBestAllTime:     number;
  // Leaderboard ranks (lower = better; 0 = never computed)
  globalTodayRank:      number;
  globalWeeklyRank:     number;
  globalMonthlyRank:    number;
  globalAllTimeRank:    number;
  regionalTodayRank:    number;
  regionalWeeklyRank:   number;
  regionalMonthlyRank:  number;
  regionalAllTimeRank:  number;
  coinsLeaderboardRank: number;
  // Titles meta
  titlesUnlocked:       number;
  legendaryTitlesUnlocked: number;
}

interface UnlockedTitle {
  code:       string;
  title:      string;
  difficulty: string;
  icon:       string | null;
}

// ── Metric computation ────────────────────────────────────────────────────────
async function computeMetrics(userId: string): Promise<Metrics> {
  const client = await pool.connect();
  try {
    // ── Step metrics ──────────────────────────────────────────────────────────
    const stepRes = await client.query<{
      has_any:       string;
      lifetime:      string;
      max_day:       string;
      active_days:   string;
      pct25_days:    string;
      pct50_days:    string;
      pct75_days:    string;
      pct100_days:   string;
    }>(`
      SELECT
        (COUNT(*) > 0)::text                                                           AS has_any,
        COALESCE(SUM(steps), 0)::text                                                  AS lifetime,
        COALESCE(MAX(steps), 0)::text                                                  AS max_day,
        COUNT(*) FILTER (WHERE steps > 0)::text                                        AS active_days,
        COUNT(*) FILTER (WHERE steps >= goal * 0.25)::text                             AS pct25_days,
        COUNT(*) FILTER (WHERE steps >= goal * 0.50)::text                             AS pct50_days,
        COUNT(*) FILTER (WHERE steps >= goal * 0.75)::text                             AS pct75_days,
        COUNT(*) FILTER (WHERE steps >= goal)::text                                    AS pct100_days
      FROM step_daily_totals
      WHERE user_id = $1
    `, [userId]);

    const sr = stepRes.rows[0] ?? {};

    // Weekly/monthly rolling max
    const weekRes = await client.query<{ max_week: string }>(`
      SELECT COALESCE(MAX(weekly_sum), 0)::text AS max_week FROM (
        SELECT SUM(steps) AS weekly_sum
        FROM step_daily_totals
        WHERE user_id = $1
        GROUP BY date_trunc('week', date::timestamp)
      ) w
    `, [userId]);

    const monthRes = await client.query<{ max_month: string }>(`
      SELECT COALESCE(MAX(monthly_sum), 0)::text AS max_month FROM (
        SELECT SUM(steps) AS monthly_sum
        FROM step_daily_totals
        WHERE user_id = $1
        GROUP BY date_trunc('month', date::timestamp)
      ) m
    `, [userId]);

    // Best week active days
    const bestWeekRes = await client.query<{ best_week: string }>(`
      SELECT COALESCE(MAX(day_count), 0)::text AS best_week FROM (
        SELECT COUNT(*) FILTER (WHERE steps > 0) AS day_count
        FROM step_daily_totals
        WHERE user_id = $1
        GROUP BY date_trunc('week', date::timestamp)
      ) w
    `, [userId]);

    // Longest goal streak (consecutive days where steps >= goal)
    const streakRes = await client.query<{ max_streak: string }>(`
      WITH ranked AS (
        SELECT
          date::date,
          steps >= goal AS hit,
          ROW_NUMBER() OVER (ORDER BY date) -
          ROW_NUMBER() OVER (PARTITION BY (steps >= goal) ORDER BY date) AS grp
        FROM step_daily_totals
        WHERE user_id = $1
      )
      SELECT COALESCE(MAX(cnt), 0)::text AS max_streak FROM (
        SELECT COUNT(*) AS cnt FROM ranked WHERE hit GROUP BY grp
      ) s
    `, [userId]);

    // Weekday goal streak (consecutive Mon–Fri where steps >= goal)
    const weekdayStreakRes = await client.query<{ max_streak: string }>(`
      WITH wd AS (
        SELECT
          date::date,
          steps >= goal AS hit,
          ROW_NUMBER() OVER (ORDER BY date) -
          ROW_NUMBER() OVER (PARTITION BY (steps >= goal) ORDER BY date) AS grp
        FROM step_daily_totals
        WHERE user_id = $1
          AND EXTRACT(dow FROM date::timestamp) BETWEEN 1 AND 5
      )
      SELECT COALESCE(MAX(cnt), 0)::text AS max_streak FROM (
        SELECT COUNT(*) AS cnt FROM wd WHERE hit GROUP BY grp
      ) s
    `, [userId]);

    // Morning / night walk sessions
    const sessionRes = await client.query<{ morning: string; night: string }>(`
      SELECT
        COUNT(DISTINCT started_at::date) FILTER (WHERE EXTRACT(hour FROM started_at AT TIME ZONE 'UTC') < 9)::text AS morning,
        COUNT(DISTINCT started_at::date) FILTER (WHERE EXTRACT(hour FROM started_at AT TIME ZONE 'UTC') >= 20)::text AS night
      FROM step_sessions
      WHERE user_id = $1
    `, [userId]);

    // ── Race metrics ──────────────────────────────────────────────────────────
    const raceRes = await client.query<{
      joined:            string;
      completed:         string;
      wins:              string;
      podiums:           string;
      free_wins:         string;
      cb_wins:           string;
      cb_joined:         string;
      pub_wins:          string;
      priv_wins:         string;
      priv_completed:    string;
      sponsored_joined:  string;
      sponsored_wins:    string;
      fast_finishes:     string;
      coins_earned:      string;
      comeback_top3:     string;
    }>(`
      SELECT
        COUNT(DISTINCT rp.race_room_id)::text                                           AS joined,
        COUNT(rr2.id) FILTER (WHERE rr2.rank IS NOT NULL)::text                        AS completed,
        COUNT(rr2.id) FILTER (WHERE rr2.rank <= 3)::text                               AS wins,
        COUNT(rr2.id) FILTER (WHERE rr2.rank <= 3)::text                               AS podiums,
        COUNT(rr2.id) FILTER (WHERE rr2.rank <= 3 AND rm.entry_type = 'free')::text    AS free_wins,
        COUNT(rr2.id) FILTER (WHERE rr2.rank <= 3 AND rm.entry_type = 'coins_battle')::text AS cb_wins,
        COUNT(DISTINCT rp.race_room_id) FILTER (WHERE rm.entry_type = 'coins_battle')::text AS cb_joined,
        COUNT(rr2.id) FILTER (WHERE rr2.rank <= 3 AND rm.is_private = false AND rm.type NOT IN ('country_battle','friends'))::text AS pub_wins,
        COUNT(rr2.id) FILTER (WHERE rr2.rank <= 3 AND rm.is_private = true)::text     AS priv_wins,
        COUNT(rr2.id) FILTER (WHERE rm.is_private = true)::text                        AS priv_completed,
        COUNT(DISTINCT rp.race_room_id) FILTER (WHERE rm.type = 'sponsored')::text    AS sponsored_joined,
        COUNT(rr2.id) FILTER (WHERE rm.type = 'sponsored' AND rr2.rank <= rm.winner_count)::text AS sponsored_wins,
        COUNT(rr2.id) FILTER (WHERE rr2.rank = 1 AND rp.finished_goal = true)::text   AS fast_finishes,
        COALESCE(SUM(rr2.prize_coins), 0)::text                                        AS coins_earned,
        0::text                                                                         AS comeback_top3
      FROM race_participants rp
      JOIN race_rooms rm ON rp.race_room_id = rm.id
      LEFT JOIN race_results rr2 ON rr2.race_room_id = rm.id::text AND rr2.user_id = rp.user_id
      WHERE rp.user_id = $1
    `, [userId]);

    // Fast 1K finishes (finished goal in quick race)
    const fast1kRes = await client.query<{ cnt: string }>(`
      SELECT COUNT(rr.id)::text AS cnt
      FROM race_results rr
      JOIN race_rooms rm ON rr.race_room_id = rm.id::text
      WHERE rr.user_id = $1
        AND rm.target_steps <= 1000
        AND rr.rank = 1
    `, [userId]);

    // Additional coin transactions
    const coinTxRes = await client.query<{ total: string }>(`
      SELECT COALESCE(SUM(amount), 0)::text AS total
      FROM coin_transactions
      WHERE user_id = $1 AND transaction_type = 'earn'
    `, [userId]);

    // ── Social metrics ────────────────────────────────────────────────────────
    const friendsRes = await client.query<{ cnt: string }>(`
      SELECT COUNT(*)::text AS cnt FROM friends WHERE user_id = $1
    `, [userId]);

    const chatRes = await client.query<{ global_cnt: string; cheer_cnt: string; spectated: string }>(`
      SELECT
        (SELECT COUNT(*)::text FROM global_chat_messages WHERE user_id = $1)     AS global_cnt,
        (SELECT COUNT(*)::text FROM live_race_comments WHERE user_id = $1)       AS cheer_cnt,
        (SELECT COUNT(DISTINCT lrc.race_room_id)::text
         FROM live_race_comments lrc
         WHERE lrc.user_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM race_participants rp
             WHERE rp.race_room_id::text = lrc.race_room_id
               AND rp.user_id = $1
           )
        )                                                                         AS spectated
    `, [userId]);

    const profileRes = await client.query<{ completed: string; country_code: string | null }>(`
      SELECT profile_completed::text AS completed, country_code
      FROM profiles WHERE id = $1
    `, [userId]);

    // ── Group metrics ─────────────────────────────────────────────────────────
    const groupRes = await client.query<{
      created:            string;
      joined:             string;
      invites_sent:       string;
      activity_days:      string;
      steps_contributed:  string;
      members_total:      string;
    }>(`
      SELECT
        (SELECT COUNT(*)::text FROM walking_groups WHERE admin_user_id = $1 AND status = 'active') AS created,
        (SELECT COUNT(*)::text FROM walking_group_members WHERE user_id = $1 AND status = 'active') AS joined,
        (SELECT COUNT(*)::text FROM walking_group_invites WHERE invited_by_user_id = $1) AS invites_sent,
        (SELECT COUNT(DISTINCT step_date)::text FROM walking_group_daily_steps WHERE user_id = $1) AS activity_days,
        (SELECT COALESCE(SUM(daily_steps), 0)::text FROM walking_group_daily_steps WHERE user_id = $1) AS steps_contributed,
        (SELECT COUNT(wgm.id)::text
         FROM walking_group_members wgm
         WHERE wgm.group_id IN (SELECT id FROM walking_groups WHERE admin_user_id = $1)
           AND wgm.status = 'active'
           AND wgm.user_id != $1
        ) AS members_total
    `, [userId]);

    // Best group all-time steps (for groups user is a member of)
    const groupBestRes = await client.query<{ best: string }>(`
      SELECT COALESCE(MAX(group_total), 0)::text AS best FROM (
        SELECT SUM(gdr.group_total_steps) AS group_total
        FROM walking_group_daily_results gdr
        WHERE gdr.group_id IN (
          SELECT group_id FROM walking_group_members WHERE user_id = $1 AND status = 'active'
        )
        GROUP BY gdr.group_id
      ) t
    `, [userId]);

    // ── Leaderboard ranks ────────────────────────────────────────────────────
    const countryCode = profileRes.rows[0]?.country_code ?? null;

    // Global today rank = how many users have MORE steps today + 1
    const globalTodayRes = await client.query<{ rank: string }>(`
      SELECT (COUNT(*) + 1)::text AS rank
      FROM step_daily_totals
      WHERE date = CURRENT_DATE
        AND steps > COALESCE(
          (SELECT steps FROM step_daily_totals WHERE user_id = $1 AND date = CURRENT_DATE),
          -1
        )
    `, [userId]);

    // Global weekly rank
    const globalWeeklyRes = await client.query<{ rank: string }>(`
      WITH totals AS (
        SELECT user_id, SUM(steps) AS weekly_steps
        FROM step_daily_totals
        WHERE date >= CURRENT_DATE - INTERVAL '6 days'
        GROUP BY user_id
      )
      SELECT (COUNT(*) + 1)::text AS rank
      FROM totals
      WHERE weekly_steps > COALESCE(
        (SELECT weekly_steps FROM totals WHERE user_id = $1),
        -1
      )
    `, [userId]);

    // Global monthly rank
    const globalMonthlyRes = await client.query<{ rank: string }>(`
      WITH totals AS (
        SELECT user_id, SUM(steps) AS monthly_steps
        FROM step_daily_totals
        WHERE date >= CURRENT_DATE - INTERVAL '29 days'
        GROUP BY user_id
      )
      SELECT (COUNT(*) + 1)::text AS rank
      FROM totals
      WHERE monthly_steps > COALESCE(
        (SELECT monthly_steps FROM totals WHERE user_id = $1),
        -1
      )
    `, [userId]);

    // Global all-time rank (from profiles.total_steps)
    const globalAllTimeRes = await client.query<{ rank: string }>(`
      SELECT (COUNT(*) + 1)::text AS rank
      FROM profiles
      WHERE total_steps > COALESCE(
        (SELECT total_steps FROM profiles WHERE id = $1),
        -1
      )
    `, [userId]);

    // Regional ranks (only if country_code exists)
    let regTodayRank = 9999, regWeeklyRank = 9999, regMonthlyRank = 9999, regAllTimeRank = 9999;
    if (countryCode) {
      const regTodayRes = await client.query<{ rank: string }>(`
        SELECT (COUNT(*) + 1)::text AS rank
        FROM step_daily_totals sdt
        JOIN profiles p ON p.id = sdt.user_id
        WHERE sdt.date = CURRENT_DATE
          AND p.country_code = $2
          AND sdt.steps > COALESCE(
            (SELECT steps FROM step_daily_totals WHERE user_id = $1 AND date = CURRENT_DATE),
            -1
          )
      `, [userId, countryCode]);

      const regWeeklyRes = await client.query<{ rank: string }>(`
        WITH totals AS (
          SELECT sdt.user_id, SUM(sdt.steps) AS ws
          FROM step_daily_totals sdt
          JOIN profiles p ON p.id = sdt.user_id
          WHERE sdt.date >= CURRENT_DATE - INTERVAL '6 days' AND p.country_code = $2
          GROUP BY sdt.user_id
        )
        SELECT (COUNT(*) + 1)::text AS rank FROM totals
        WHERE ws > COALESCE((SELECT ws FROM totals WHERE user_id = $1), -1)
      `, [userId, countryCode]);

      const regMonthlyRes = await client.query<{ rank: string }>(`
        WITH totals AS (
          SELECT sdt.user_id, SUM(sdt.steps) AS ms
          FROM step_daily_totals sdt
          JOIN profiles p ON p.id = sdt.user_id
          WHERE sdt.date >= CURRENT_DATE - INTERVAL '29 days' AND p.country_code = $2
          GROUP BY sdt.user_id
        )
        SELECT (COUNT(*) + 1)::text AS rank FROM totals
        WHERE ms > COALESCE((SELECT ms FROM totals WHERE user_id = $1), -1)
      `, [userId, countryCode]);

      const regAllTimeRes = await client.query<{ rank: string }>(`
        SELECT (COUNT(*) + 1)::text AS rank
        FROM profiles
        WHERE country_code = $2
          AND total_steps > COALESCE(
            (SELECT total_steps FROM profiles WHERE id = $1),
            -1
          )
      `, [userId, countryCode]);

      regTodayRank   = parseInt(regTodayRes.rows[0]?.rank   ?? "9999");
      regWeeklyRank  = parseInt(regWeeklyRes.rows[0]?.rank   ?? "9999");
      regMonthlyRank = parseInt(regMonthlyRes.rows[0]?.rank  ?? "9999");
      regAllTimeRank = parseInt(regAllTimeRes.rows[0]?.rank  ?? "9999");
    }

    // Coins leaderboard rank
    const coinsRankRes = await client.query<{ rank: string }>(`
      SELECT (COUNT(*) + 1)::text AS rank
      FROM coin_balances
      WHERE current_balance > COALESCE(
        (SELECT current_balance FROM coin_balances WHERE user_id = $1),
        -1
      )
    `, [userId]);

    // ── Title counts (from existing user_titles + achievement_definitions) ────
    const titleCountRes = await client.query<{ total: string; legendary: string }>(`
      SELECT
        COUNT(ut.id)::text AS total,
        COUNT(ut.id) FILTER (WHERE ad.difficulty = 'legendary')::text AS legendary
      FROM user_titles ut
      JOIN achievement_definitions ad ON ad.code = ut.achievement_code
      WHERE ut.user_id = $1
    `, [userId]);

    // ── Assemble metrics ─────────────────────────────────────────────────────
    const sr0     = stepRes.rows[0]    ?? {};
    const raceR   = raceRes.rows[0]    ?? {};
    const sessR   = sessionRes.rows[0] ?? {};
    const chatR   = chatRes.rows[0]    ?? {};
    const profR   = profileRes.rows[0] ?? {};
    const groupR  = groupRes.rows[0]   ?? {};
    const titleR  = titleCountRes.rows[0] ?? {};

    return {
      hasAnySteps:           sr0.has_any === "true",
      lifetimeSteps:         parseInt(sr0.lifetime ?? "0"),
      maxSingleDay:          parseInt(sr0.max_day ?? "0"),
      maxWeeklySteps:        parseInt(weekRes.rows[0]?.max_week ?? "0"),
      maxMonthlySteps:       parseInt(monthRes.rows[0]?.max_month ?? "0"),
      activeDaysCount:       parseInt(sr0.active_days ?? "0"),
      bestWeekActiveDays:    parseInt(bestWeekRes.rows[0]?.best_week ?? "0"),
      goalStreakMax:          parseInt(streakRes.rows[0]?.max_streak ?? "0"),
      weekdayGoalStreak:     parseInt(weekdayStreakRes.rows[0]?.max_streak ?? "0"),
      pct25Days:             parseInt(sr0.pct25_days ?? "0"),
      pct50Days:             parseInt(sr0.pct50_days ?? "0"),
      pct75Days:             parseInt(sr0.pct75_days ?? "0"),
      pct100Days:            parseInt(sr0.pct100_days ?? "0"),
      morningWalkDays:       parseInt(sessR.morning ?? "0"),
      nightWalkDays:         parseInt(sessR.night ?? "0"),
      joinedRaces:           parseInt(raceR.joined ?? "0"),
      completedRaces:        parseInt(raceR.completed ?? "0"),
      raceWins:              parseInt(raceR.wins ?? "0"),
      racePodiums:           parseInt(raceR.podiums ?? "0"),
      freeWins:              parseInt(raceR.free_wins ?? "0"),
      coinsBattleWins:       parseInt(raceR.cb_wins ?? "0"),
      coinsBattleJoined:     parseInt(raceR.cb_joined ?? "0"),
      publicWins:            parseInt(raceR.pub_wins ?? "0"),
      privateWins:           parseInt(raceR.priv_wins ?? "0"),
      privateCompleted:      parseInt(raceR.priv_completed ?? "0"),
      sponsoredJoined:       parseInt(raceR.sponsored_joined ?? "0"),
      sponsoredWins:         parseInt(raceR.sponsored_wins ?? "0"),
      fastFinishes:          parseInt(raceR.fast_finishes ?? "0"),
      fast1kFinishes:        parseInt(fast1kRes.rows[0]?.cnt ?? "0"),
      comebackTop3:          0, // event-driven, not recomputable from stored data
      coinsEarned:           Math.max(
                               parseInt(raceR.coins_earned ?? "0"),
                               parseInt(coinTxRes.rows[0]?.total ?? "0"),
                             ),
      friendsCount:          parseInt(friendsRes.rows[0]?.cnt ?? "0"),
      chatMessages:          parseInt(chatR.global_cnt ?? "0") + parseInt(chatR.cheer_cnt ?? "0"),
      liveCheers:            parseInt(chatR.cheer_cnt ?? "0"),
      spectatedRaces:        parseInt(chatR.spectated ?? "0"),
      profileCompleted:      profR.completed === "true",
      groupsCreated:         parseInt(groupR.created ?? "0"),
      groupsJoined:          parseInt(groupR.joined ?? "0"),
      groupInvitesSent:      parseInt(groupR.invites_sent ?? "0"),
      groupActivityDays:     parseInt(groupR.activity_days ?? "0"),
      groupStepsContributed: parseInt(groupR.steps_contributed ?? "0"),
      groupMembersTotal:     parseInt(groupR.members_total ?? "0"),
      groupBestAllTime:      parseInt(groupBestRes.rows[0]?.best ?? "0"),
      globalTodayRank:       parseInt(globalTodayRes.rows[0]?.rank    ?? "9999"),
      globalWeeklyRank:      parseInt(globalWeeklyRes.rows[0]?.rank   ?? "9999"),
      globalMonthlyRank:     parseInt(globalMonthlyRes.rows[0]?.rank  ?? "9999"),
      globalAllTimeRank:     parseInt(globalAllTimeRes.rows[0]?.rank  ?? "9999"),
      regionalTodayRank:     regTodayRank,
      regionalWeeklyRank:    regWeeklyRank,
      regionalMonthlyRank:   regMonthlyRank,
      regionalAllTimeRank:   regAllTimeRank,
      coinsLeaderboardRank:  parseInt(coinsRankRes.rows[0]?.rank ?? "9999"),
      titlesUnlocked:        parseInt(titleR.total    ?? "0"),
      legendaryTitlesUnlocked: parseInt(titleR.legendary ?? "0"),
    };
  } finally {
    client.release();
  }
}

// ── Progress for a single achievement ────────────────────────────────────────
function computeProgress(
  def: {
    code: string;
    unlockType: string;
    targetValue: number | null;
    leaderboardScope: string | null;
    timePeriod: string | null;
  },
  m: Metrics,
): { progressValue: number; unlocked: boolean } {
  const target = def.targetValue ?? 1;

  function simpleCheck(value: number): { progressValue: number; unlocked: boolean } {
    return { progressValue: value, unlocked: value >= target };
  }

  function rankCheck(currentRank: number, storedBest: number): { progressValue: number; unlocked: boolean } {
    // For ranks: lower is better. Store BEST (lowest) rank ever achieved.
    const bestRank = storedBest === 0 ? currentRank : Math.min(currentRank, storedBest);
    return { progressValue: bestRank, unlocked: bestRank <= target };
  }

  switch (def.unlockType) {
    // Step metrics
    case "first_walk":
      return { progressValue: m.hasAnySteps ? 1 : 0, unlocked: m.hasAnySteps };
    case "active_days_count":
    case "active_days":
      return simpleCheck(m.activeDaysCount);
    case "daily_steps":
      return simpleCheck(m.maxSingleDay);
    case "lifetime_steps":
      return simpleCheck(m.lifetimeSteps);
    case "weekly_steps":
      return simpleCheck(m.maxWeeklySteps);
    case "monthly_steps":
      return simpleCheck(m.maxMonthlySteps);
    case "active_days_week":
      return simpleCheck(m.bestWeekActiveDays);
    case "goal_streak":
      return simpleCheck(m.goalStreakMax);
    case "weekday_goal_streak":
      return simpleCheck(m.weekdayGoalStreak);
    case "daily_goal_percent":
      // targetValue is the percentage threshold (25/50/75/100)
      if (target <= 25) return simpleCheck(m.pct25Days);
      if (target <= 50) return simpleCheck(m.pct50Days);
      if (target <= 75) return simpleCheck(m.pct75Days);
      return simpleCheck(m.pct100Days);
    case "walk_before_time":
      return simpleCheck(m.morningWalkDays);
    case "walk_after_time":
      return simpleCheck(m.nightWalkDays);

    // Race metrics
    case "races_joined":
      return simpleCheck(m.joinedRaces);
    case "races_completed":
      return simpleCheck(m.completedRaces);
    case "race_wins":
      return simpleCheck(m.raceWins);
    case "race_top_3":
    case "race_podiums":
      return simpleCheck(m.racePodiums);
    case "fast_race_finish":
      return simpleCheck(m.fastFinishes);
    case "fast_1k_race":
      return simpleCheck(m.fast1kFinishes);
    case "race_comeback_top_3":
      return simpleCheck(m.comebackTop3);
    case "friend_races_completed":
      return simpleCheck(m.privateCompleted);
    case "free_challenge_wins":
      return simpleCheck(m.freeWins);
    case "coins_battle_wins":
      return simpleCheck(m.coinsBattleWins);
    case "coins_battle_joined":
      return simpleCheck(m.coinsBattleJoined);
    case "public_challenge_wins":
      return simpleCheck(m.publicWins);
    case "private_challenge_wins":
      return simpleCheck(m.privateWins);
    case "sponsored_joined":
      return simpleCheck(m.sponsoredJoined);
    case "sponsored_wins":
      return simpleCheck(m.sponsoredWins);
    case "coins_earned":
      return simpleCheck(m.coinsEarned);

    // Social
    case "friends_added":
      return simpleCheck(m.friendsCount);
    case "cheers_sent":
      return simpleCheck(m.liveCheers);
    case "chat_messages":
      return simpleCheck(m.chatMessages);
    case "spectated_races":
      return simpleCheck(m.spectatedRaces);
    case "profile_completed":
      return { progressValue: m.profileCompleted ? 1 : 0, unlocked: m.profileCompleted };

    // Groups
    case "groups_created":
      return simpleCheck(m.groupsCreated);
    case "groups_joined":
      return simpleCheck(m.groupsJoined);
    case "group_invites_sent":
      return simpleCheck(m.groupInvitesSent);
    case "group_activity_days":
      return simpleCheck(m.groupActivityDays);
    case "group_steps_contributed":
      return simpleCheck(m.groupStepsContributed);
    case "group_steps_best":
      return simpleCheck(m.groupBestAllTime);
    case "group_members_total":
      return simpleCheck(m.groupMembersTotal);

    // Titles
    case "titles_unlocked":
    case "elite_achievements_unlocked":
      return simpleCheck(m.titlesUnlocked);
    case "legendary_titles_unlocked":
    case "elite_tier":
      return simpleCheck(m.legendaryTitlesUnlocked);

    // Combined elite (1M steps + 100 race wins + 100 friends + 30-day streak)
    case "combined_elite":
    case "ultimate_title": {
      const done = m.lifetimeSteps >= 1_000_000
        && m.raceWins >= 100
        && m.friendsCount >= 100
        && m.goalStreakMax >= 30;
      return { progressValue: done ? 1 : 0, unlocked: done };
    }

    // Leaderboard ranks — stored as best (lowest) rank
    case "leaderboard_rank": {
      let currentRank = 9999;
      const scope  = def.leaderboardScope;
      const period = def.timePeriod;
      if (scope === "global") {
        if      (period === "today")    currentRank = m.globalTodayRank;
        else if (period === "week")     currentRank = m.globalWeeklyRank;
        else if (period === "month")    currentRank = m.globalMonthlyRank;
        else if (period === "all_time") currentRank = m.globalAllTimeRank;
      } else if (scope === "regional") {
        if      (period === "today")    currentRank = m.regionalTodayRank;
        else if (period === "week")     currentRank = m.regionalWeeklyRank;
        else if (period === "month")    currentRank = m.regionalMonthlyRank;
        else if (period === "all_time") currentRank = m.regionalAllTimeRank;
      }
      // Note: storedBest is handled in the main loop below
      return { progressValue: currentRank, unlocked: currentRank <= target };
    }

    // Rank 1 day counts — accumulated in user_achievements.progressValue
    case "global_rank_1_days":
    case "global_rank_1_streak": {
      const isRank1Today = m.globalTodayRank === 1;
      // Return signal; actual accumulation handled below
      return { progressValue: isRank1Today ? 1 : 0, unlocked: false }; // handled separately
    }
    case "regional_rank_1_days":
    case "regional_rank_1_streak": {
      const isRank1Today = m.regionalTodayRank === 1;
      return { progressValue: isRank1Today ? 1 : 0, unlocked: false }; // handled separately
    }

    // Rank improvement streak — event-driven, keep current
    case "rank_improvement_streak":
      return { progressValue: 0, unlocked: false };

    // Top 1% — approximate
    case "top_percent_all_time":
      // If globalAllTimeRank <= 1% of all users, consider done
      // We can't easily compute total users here; approximation via rank < 100
      return { progressValue: m.globalAllTimeRank <= 100 ? 1 : 0, unlocked: m.globalAllTimeRank <= 100 };

    case "top_percent_global_months":
      return { progressValue: 0, unlocked: false };

    // Coins leaderboard rank
    case "coins_leaderboard_rank": {
      return { progressValue: m.coinsLeaderboardRank, unlocked: m.coinsLeaderboardRank <= target };
    }

    // Group top walker / rank events — event-driven
    case "group_top_walker_days":
    case "group_rank_1_today":
    case "group_rank_1_all_time":
      return { progressValue: 0, unlocked: false };

    default:
      return { progressValue: 0, unlocked: false };
  }
}

// ── Main evaluation function ──────────────────────────────────────────────────
export async function evaluateUserTitles(userId: string): Promise<UnlockedTitle[]> {
  const [metrics, defs, existingAchs, existingTitles] = await Promise.all([
    computeMetrics(userId),
    db.select().from(achievementDefinitionsTable).where(
      eq(achievementDefinitionsTable.isActive, true),
    ),
    db.select().from(userAchievementsTable).where(
      eq(userAchievementsTable.userId, userId),
    ),
    db.select().from(userTitlesTable).where(
      eq(userTitlesTable.userId, userId),
    ),
  ]);

  const achByCode   = new Map(existingAchs.map((a) => [a.achievementCode, a]));
  const titledCodes = new Set(existingTitles.map((t) => t.achievementCode));
  const now         = new Date();
  const newlyUnlocked: UnlockedTitle[] = [];

  for (const def of defs) {
    const existing = achByCode.get(def.code);
    let { progressValue, unlocked } = computeProgress(def, metrics);

    // For rank metrics: preserve best (lowest) rank ever stored
    if (def.unlockType === "leaderboard_rank" || def.unlockType === "coins_leaderboard_rank") {
      const storedBest = existing?.progressValue ?? 0;
      if (storedBest > 0 && storedBest < progressValue) {
        progressValue = storedBest; // keep the better (lower) historical rank
      }
      unlocked = progressValue <= (def.targetValue ?? 1) && progressValue > 0;
    }

    // For accumulated day counts (global/regional rank 1 days) — only increment
    if (def.unlockType === "global_rank_1_days" || def.unlockType === "global_rank_1_streak") {
      const storedCount = existing?.progressValue ?? 0;
      // progressValue=1 signals user has rank 1 today; increment stored count
      const increment = progressValue === 1 ? 1 : 0;
      const dateKey = now.toISOString().slice(0, 10); // YYYY-MM-DD
      // Only increment once per day (use metadata to track last increment date)
      const lastDate = (existing?.metadata as { lastRank1Date?: string } | null)?.lastRank1Date;
      if (increment === 1 && lastDate !== dateKey) {
        progressValue = storedCount + 1;
      } else {
        progressValue = storedCount;
      }
      unlocked = progressValue >= (def.targetValue ?? 1);
    }

    if (def.unlockType === "regional_rank_1_days" || def.unlockType === "regional_rank_1_streak") {
      const storedCount = existing?.progressValue ?? 0;
      const increment = progressValue === 1 ? 1 : 0;
      const dateKey = now.toISOString().slice(0, 10);
      const lastDate = (existing?.metadata as { lastRank1Date?: string } | null)?.lastRank1Date;
      if (increment === 1 && lastDate !== dateKey) {
        progressValue = storedCount + 1;
      } else {
        progressValue = storedCount;
      }
      unlocked = progressValue >= (def.targetValue ?? 1);
    }

    // Skip event-driven metrics that can't be computed here
    if ([
      "rank_improvement_streak",
      "top_percent_global_months",
      "group_top_walker_days",
      "group_rank_1_today",
      "group_rank_1_all_time",
    ].includes(def.unlockType)) {
      // Don't overwrite existing progress
      progressValue = existing?.progressValue ?? 0;
      unlocked = (existing?.unlocked ?? false) || unlocked;
    }

    // Preserve already-unlocked state (never un-unlock)
    const wasUnlocked = existing?.unlocked ?? false;
    const finalUnlocked = wasUnlocked || unlocked;

    // Build metadata for rank-1-day titles
    const metadata = (def.unlockType === "global_rank_1_days" || def.unlockType === "global_rank_1_streak"
      || def.unlockType === "regional_rank_1_days" || def.unlockType === "regional_rank_1_streak")
      ? { lastRank1Date: metrics.globalTodayRank === 1 || metrics.regionalTodayRank === 1
            ? now.toISOString().slice(0, 10) : (existing?.metadata as Record<string, string> | null)?.lastRank1Date }
      : null;

    // Upsert user_achievements
    await db
      .insert(userAchievementsTable)
      .values({
        userId,
        achievementCode: def.code,
        progressValue,
        unlocked:        finalUnlocked,
        unlockedAt:      finalUnlocked && !wasUnlocked ? now : (existing?.unlockedAt ?? undefined),
        metadata:        metadata ?? undefined,
      })
      .onConflictDoUpdate({
        target: [userAchievementsTable.userId, userAchievementsTable.achievementCode],
        set: {
          progressValue: sql`EXCLUDED.progress_value`,
          unlocked:      sql`EXCLUDED.unlocked`,
          unlockedAt:    finalUnlocked && !wasUnlocked ? sql`${now.toISOString()}` : sql`user_achievements.unlocked_at`,
          metadata:      metadata ? sql`EXCLUDED.metadata` : sql`user_achievements.metadata`,
          updatedAt:     sql`now()`,
        },
      });

    // If newly unlocked, grant title (user_titles row)
    if (finalUnlocked && !wasUnlocked && !titledCodes.has(def.code)) {
      await db
        .insert(userTitlesTable)
        .values({ userId, achievementCode: def.code, isActive: false })
        .onConflictDoNothing();

      newlyUnlocked.push({ code: def.code, title: def.title, difficulty: def.difficulty, icon: def.icon ?? null });
      titledCodes.add(def.code);
    }
  }

  return newlyUnlocked;
}

// ── Single-title progress update (lightweight, used by event hooks) ───────────
export async function incrementEventMetric(
  userId: string,
  code: string,
  incrementBy = 1,
): Promise<boolean> {
  try {
    const def = await db
      .select()
      .from(achievementDefinitionsTable)
      .where(and(eq(achievementDefinitionsTable.code, code), eq(achievementDefinitionsTable.isActive, true)))
      .limit(1);

    if (!def.length) return false;

    const existing = await db
      .select()
      .from(userAchievementsTable)
      .where(and(eq(userAchievementsTable.userId, userId), eq(userAchievementsTable.achievementCode, code)))
      .limit(1);

    const current    = existing[0]?.progressValue ?? 0;
    const target     = def[0]!.targetValue ?? 1;
    const newVal     = current + incrementBy;
    const wasUnlocked = existing[0]?.unlocked ?? false;
    const nowUnlocked = newVal >= target;
    const now         = new Date();

    await db
      .insert(userAchievementsTable)
      .values({
        userId,
        achievementCode: code,
        progressValue:   newVal,
        unlocked:        nowUnlocked,
        unlockedAt:      nowUnlocked && !wasUnlocked ? now : undefined,
      })
      .onConflictDoUpdate({
        target: [userAchievementsTable.userId, userAchievementsTable.achievementCode],
        set: {
          progressValue: sql`EXCLUDED.progress_value`,
          unlocked:      sql`EXCLUDED.unlocked`,
          unlockedAt:    nowUnlocked && !wasUnlocked ? sql`${now.toISOString()}` : sql`user_achievements.unlocked_at`,
          updatedAt:     sql`now()`,
        },
      });

    if (nowUnlocked && !wasUnlocked) {
      await db
        .insert(userTitlesTable)
        .values({ userId, achievementCode: code, isActive: false })
        .onConflictDoNothing();
      return true; // newly unlocked
    }
    return false;
  } catch {
    return false;
  }
}
