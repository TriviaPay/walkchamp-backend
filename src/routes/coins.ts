import { Router } from "express";
import { db } from "@db";
import {
  coinBalancesTable,
  coinTransactionsTable,
  dailyCoinRewardsTable,
  coinRewardGrantsTable,
  stepDailyTotalsTable,
  raceParticipantsTable,
  walkingGroupDailyStepsTable,
  profilesTable,
} from "@db/schema";
import { eq, and, desc, sql, gte, lte } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth";
import { requireActiveAccount } from "../middleware/requireActiveAccount";
import {
  getCoinBalance,
  awardCoins,
  evaluateStepMilestones,
  getDailyAdRewardStatus,
  awardAdReward,
  MAX_DAILY_AD_REWARDS,
} from "../lib/coinsService";
import { z } from "zod";

const EARNING_RULES = [
  { id: "walk_any_steps",      icon: "🚶", title: "Walk any steps today",         rewardText: "+1"                             },
  { id: "reach_25pct_goal",    icon: "🎯", title: "Reach 25% daily goal",         rewardText: "+2"                             },
  { id: "reach_50pct_goal",    icon: "🎯", title: "Reach 50% daily goal",         rewardText: "+3"                             },
  { id: "reach_75pct_goal",    icon: "🎯", title: "Reach 75% daily goal",         rewardText: "+5"                             },
  { id: "reach_100pct_goal",   icon: "✅", title: "Reach 100% daily goal",        rewardText: "+15"                            },
  { id: "spectate_60s",        icon: "👀", title: "Spectate a match 60s+",        rewardText: "+2"                             },
  { id: "add_friend",          icon: "🤝", title: "Add or accept a friend",        rewardText: "+5"                             },
  { id: "join_challenge",      icon: "🏁", title: "Join any challenge today",      rewardText: "+5"                             },
  { id: "group_activity",      icon: "👥", title: "Complete group activity today", rewardText: "+5"                             },
  { id: "walk_20k",            icon: "👟", title: "Walk 20,000 steps",            rewardText: "+40"                            },
  { id: "streak_7",            icon: "🔥", title: "7-day goal streak",            rewardText: "+50"                            },
  { id: "win_free_challenge",  icon: "🏁", title: "Win a Free Challenge",         rewardText: "1st +50 • 2nd +30 • 3rd +20"   },
  { id: "win_public_challenge", icon: "🌍", title: "Win a Public Challenge",      rewardText: "+50"                            },
  { id: "win_private_challenge",icon: "🔒", title: "Win a Private Challenge",     rewardText: "+50"                            },
] as const;

const router = Router();

// ── GET /api/coins/balance ────────────────────────────────────────────────────
router.get("/coins/balance", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  try {
    const balance = await getCoinBalance(userId);

    const rawLD = typeof req.query.localDate === "string" ? req.query.localDate : "";
    const localDate = /^\d{4}-\d{2}-\d{2}$/.test(rawLD) ? rawLD : new Date().toISOString().split("T")[0]!;
    const todayStart = new Date(`${localDate}T00:00:00.000Z`);
    const todayEnd = new Date(`${localDate}T23:59:59.999Z`);

    const todayRows = await db
      .select({ total: sql<number>`coalesce(sum(${coinTransactionsTable.amount}), 0)` })
      .from(coinTransactionsTable)
      .where(
        and(
          eq(coinTransactionsTable.userId, userId),
          eq(coinTransactionsTable.transactionType, "earn"),
          gte(coinTransactionsTable.createdAt, todayStart),
          lte(coinTransactionsTable.createdAt, todayEnd),
        ),
      );

    const earnedToday = Number(todayRows[0]?.total ?? 0);
    const adStatus = await getDailyAdRewardStatus(userId, localDate);

    return res.json({
      currentBalance: balance.currentBalance,
      lifetimeEarned: balance.lifetimeEarned,
      lifetimeSpent: balance.lifetimeSpent,
      earnedToday,
      adsToday: adStatus.adsToday,
      adsRemaining: adStatus.adsRemaining,
      maxDailyAdRewards: adStatus.maxDailyAdRewards,
    });
  } catch (err) {
    req.log.error({ err }, "coins/balance error");
    return res.status(500).json({ error: "Failed to fetch coin balance" });
  }
});

// ── GET /api/coins/transactions ───────────────────────────────────────────────
router.get("/coins/transactions", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  try {
    const limitParam = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 50;
    const limit = Math.min(Math.max(1, isNaN(limitParam) ? 50 : limitParam), 100);

    const transactions = await db
      .select()
      .from(coinTransactionsTable)
      .where(eq(coinTransactionsTable.userId, userId))
      .orderBy(desc(coinTransactionsTable.createdAt))
      .limit(limit);

    return res.json({ transactions });
  } catch (err) {
    req.log.error({ err }, "coins/transactions error");
    return res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

// ── GET /api/coins/summary ────────────────────────────────────────────────────
// Returns balance stats + static earning rules in a single call.
router.get("/coins/summary", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  try {
    const balance = await getCoinBalance(userId);

    const rawLD2 = typeof req.query.localDate === "string" ? req.query.localDate : "";
    const localDate2 = /^\d{4}-\d{2}-\d{2}$/.test(rawLD2) ? rawLD2 : new Date().toISOString().split("T")[0]!;
    const todayStart = new Date(`${localDate2}T00:00:00.000Z`);
    const todayEnd = new Date(`${localDate2}T23:59:59.999Z`);

    const todayRows = await db
      .select({ total: sql<number>`coalesce(sum(${coinTransactionsTable.amount}), 0)` })
      .from(coinTransactionsTable)
      .where(
        and(
          eq(coinTransactionsTable.userId, userId),
          eq(coinTransactionsTable.transactionType, "earn"),
          gte(coinTransactionsTable.createdAt, todayStart),
          lte(coinTransactionsTable.createdAt, todayEnd),
        ),
      );

    return res.json({
      success: true,
      balance: balance.currentBalance,
      todayEarned: Number(todayRows[0]?.total ?? 0),
      lifetimeEarned: balance.lifetimeEarned,
      lifetimeSpent: balance.lifetimeSpent,
      earningRules: EARNING_RULES,
    });
  } catch (err) {
    req.log.error({ err }, "coins/summary error");
    return res.status(500).json({ error: "Failed to fetch coin summary" });
  }
});

// ── GET /api/coins/earn-tasks ─────────────────────────────────────────────────
// Returns difficulty-grouped earning tasks with live progress/status per user.
// Auto-awards any newly-completed non-step tasks on each call (idempotent).
// query: localDate=YYYY-MM-DD (user's local calendar day)
router.get("/coins/earn-tasks", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const rawDate = typeof req.query.localDate === "string" ? req.query.localDate : "";
  const localDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
    ? rawDate
    : new Date().toISOString().split("T")[0]!;

  try {
    const todayStart = new Date(`${localDate}T00:00:00.000Z`);

    // Fetch all data in parallel for maximum efficiency
    const [stepsRows, dailyRows, grantRows, profileRows, raceJoinRows, groupStepRows, balance] = await Promise.all([
      db.select({ steps: stepDailyTotalsTable.steps, goal: stepDailyTotalsTable.goal })
        .from(stepDailyTotalsTable)
        .where(and(eq(stepDailyTotalsTable.userId, userId), eq(stepDailyTotalsTable.date, localDate)))
        .limit(1),
      db.select({ rewardCode: dailyCoinRewardsTable.rewardCode })
        .from(dailyCoinRewardsTable)
        .where(and(eq(dailyCoinRewardsTable.userId, userId), eq(dailyCoinRewardsTable.rewardDate, localDate))),
      db.select({ rewardCode: coinRewardGrantsTable.rewardCode })
        .from(coinRewardGrantsTable)
        .where(and(
          eq(coinRewardGrantsTable.userId, userId),
          gte(coinRewardGrantsTable.createdAt, todayStart),
        )),
      db.select({ currentStreak: profilesTable.currentStreak })
        .from(profilesTable)
        .where(eq(profilesTable.id, userId))
        .limit(1),
      db.select({ id: raceParticipantsTable.id })
        .from(raceParticipantsTable)
        .where(and(
          eq(raceParticipantsTable.userId, userId),
          sql`${raceParticipantsTable.joinedAt}::date = ${localDate}::date`,
        ))
        .limit(1),
      db.select({ id: walkingGroupDailyStepsTable.id })
        .from(walkingGroupDailyStepsTable)
        .where(and(
          eq(walkingGroupDailyStepsTable.userId, userId),
          sql`${walkingGroupDailyStepsTable.stepDate}::date = ${localDate}::date`,
          sql`${walkingGroupDailyStepsTable.dailySteps} > 0`,
        ))
        .limit(1),
      getCoinBalance(userId),
    ]);

    const todaySteps = stepsRows[0]?.steps ?? 0;
    const dailyGoal  = Math.max(stepsRows[0]?.goal ?? 10000, 1);
    const claimedDailySet  = new Set(dailyRows.map(r => r.rewardCode));
    const claimedGrantsSet = new Set(grantRows.map(g => g.rewardCode));
    const currentStreak    = profileRows[0]?.currentStreak ?? 0;
    const joinedRaceToday  = !!raceJoinRows[0];
    const hasGroupSteps    = !!groupStepRows[0];

    req.log.info({ userId, todaySteps, dailyGoal, localDate }, "[CoinTasks] fetch tasks");

    // ── Auto-award non-step tasks that have just become eligible (fire-and-forget) ─
    // awardCoins is idempotent — duplicate calls are no-ops via unique constraint.
    void (async () => {
      try {
        if (joinedRaceToday) {
          const n = await awardCoins({ userId, amount: 5, source: "coin_task", rewardCode: `join_challenge_${localDate}`, description: "Joined a challenge today", date: localDate });
          if (n > 0) req.log.info({ userId, task: "join_challenge" }, "[CoinTasks] task completed");
          else       req.log.info({ userId, task: "join_challenge" }, "[CoinTasks] reward already claimed");
        }
        if (hasGroupSteps) {
          const n = await awardCoins({ userId, amount: 5, source: "coin_task", rewardCode: `group_activity_${localDate}`, description: "Completed group activity today", date: localDate });
          if (n > 0) req.log.info({ userId, task: "group_activity" }, "[CoinTasks] task completed");
          else       req.log.info({ userId, task: "group_activity" }, "[CoinTasks] reward already claimed");
        }
        if (currentStreak >= 7) {
          const n = await awardCoins({ userId, amount: 50, source: "coin_task", rewardCode: `streak_7d_${localDate}`, description: "Maintained a 7-day goal streak", date: localDate });
          if (n > 0) req.log.info({ userId, task: "streak_7", coins: 50 }, "[CoinTasks] task completed");
          else       req.log.info({ userId, task: "streak_7" }, "[CoinTasks] reward already claimed");
        }
      } catch (_) {}
    })();

    // ── Task status helpers ────────────────────────────────────────────────────
    type TaskStatus = "available" | "in_progress" | "claimed";
    interface Task {
      task_id: string; icon: string; title: string; description: string;
      reward_coins: number | null; reward_text: string | null;
      status: TaskStatus; progress: string | null; progress_pct: number | null;
    }

    // Check daily reward table (step milestones + task-based rewards)
    const dailyClaimed = (prefix: string) => claimedDailySet.has(`${prefix}_${localDate}`);

    // Check grant-based rewards (race wins, spectate, friend accept)
    const grantsClaimed = (...codes: string[]) => codes.some(c => claimedGrantsSet.has(c));

    // Check if any grant code matches a prefix (for dynamic race IDs like COINS_BATTLE_WIN_*)
    const grantsClaimedPrefix = (prefix: string) =>
      [...claimedGrantsSet].some(c => c.startsWith(prefix));

    // ── Dynamic step counts from user's real goal ──────────────────────────────
    const pct25Steps = Math.ceil(0.25 * dailyGoal);
    const pct50Steps = Math.ceil(0.50 * dailyGoal);
    const pct75Steps = Math.ceil(0.75 * dailyGoal);
    const goalFmt    = dailyGoal.toLocaleString();

    // Step-threshold task (absolute count)
    const stepTask = (
      id: string, icon: string, title: string, desc: string,
      threshold: number, prefix: string, coins: number,
    ): Task => {
      const done         = dailyClaimed(prefix) || todaySteps >= threshold;
      const status: TaskStatus = done ? "claimed" : todaySteps > 0 ? "in_progress" : "available";
      const pct          = Math.min(100, Math.round(todaySteps / threshold * 100));
      const progress     = status === "in_progress"
        ? `${todaySteps.toLocaleString()} / ${threshold.toLocaleString()} steps` : null;
      const progress_pct = status === "in_progress" ? pct : null;
      return { task_id: id, icon, title, description: desc, reward_coins: coins, reward_text: null, status, progress, progress_pct };
    };

    // Percentage-of-goal task with dynamic description
    const pctTask = (
      id: string, icon: string, title: string,
      neededSteps: number, prefix: string, coins: number,
    ): Task => {
      const desc         = `${neededSteps.toLocaleString()} steps toward your ${goalFmt} daily goal`;
      const done         = dailyClaimed(prefix) || todaySteps >= neededSteps;
      const status: TaskStatus = done ? "claimed" : todaySteps > 0 ? "in_progress" : "available";
      const pct          = Math.min(100, Math.round(todaySteps / neededSteps * 100));
      const progress     = status === "in_progress"
        ? `${todaySteps.toLocaleString()} / ${neededSteps.toLocaleString()} steps (${pct}%)` : null;
      const progress_pct = status === "in_progress" ? pct : null;
      return { task_id: id, icon, title, description: desc, reward_coins: coins, reward_text: null, status, progress, progress_pct };
    };

    // Grant-based task (race win, friend accept, spectate) — coins awarded by the event system
    const grantTask = (
      id: string, icon: string, title: string, desc: string,
      coins: number | null, text: string | null, ...codes: string[]
    ): Task => ({
      task_id: id, icon, title, description: desc, reward_coins: coins, reward_text: text,
      status: grantsClaimed(...codes) ? "claimed" : "available", progress: null, progress_pct: null,
    });

    // Boolean task — status driven by a pre-computed condition
    const boolTask = (
      id: string, icon: string, title: string, desc: string,
      coins: number, done: boolean,
    ): Task => ({
      task_id: id, icon, title, description: desc, reward_coins: coins, reward_text: null,
      status: done ? "claimed" : "available", progress: null, progress_pct: null,
    });

    // Informational task — shows race/system reward text, no separate task coin payout
    const infoTask = (
      id: string, icon: string, title: string, desc: string,
      text: string, claimed: boolean,
    ): Task => ({
      task_id: id, icon, title, description: desc, reward_coins: null, reward_text: text,
      status: claimed ? "claimed" : "available", progress: null, progress_pct: null,
    });

    // ── Status for boolean tasks ───────────────────────────────────────────────
    // These mirror the auto-award logic above so the UI reflects immediate state.
    const joinChallengeDone  = dailyClaimed("join_challenge") || joinedRaceToday;
    const groupActivityDone  = dailyClaimed("group_activity") || hasGroupSteps;
    const streak7Done        = dailyClaimed("streak_7d")      || currentStreak >= 7;

    // ── Build task groups ──────────────────────────────────────────────────────
    const groups = [
      {
        difficulty: "easy",
        title: "Simple Tasks",
        badge: "EASY",
        description: "Quick daily actions to get you started",
        tasks: [
          stepTask("walk_any_steps_today", "🚶", "Walk any steps today",    "Start your day with movement",        1,         "daily_walk",    1),
          pctTask( "reach_25pct_goal",     "🎯", "Reach 25% daily goal",    pct25Steps, "daily_goal_25",  2),
          grantTask("spectate_60s",        "👀", "Spectate a match 60s+",   "Watch any live race for 60 seconds",  2, null, "SPECTATE_MATCH"),
          grantTask("add_friend",          "🤝", "Add or accept a friend",   "Accept a friend request",             5, null, "FRIEND_ACCEPT"),
        ],
      },
      {
        difficulty: "medium",
        title: "Medium Tasks",
        badge: "MEDIUM",
        description: "Requires more walking or race participation",
        tasks: [
          pctTask( "reach_50pct_goal",             "🎯", "Reach 50% daily goal",          pct50Steps, "daily_goal_50", 3),
          pctTask( "reach_75pct_goal",             "🎯", "Reach 75% daily goal",          pct75Steps, "daily_goal_75", 5),
          boolTask("join_any_challenge_today",     "🏁", "Join any challenge today",      "Enter any race or challenge today",        5, joinChallengeDone),
          boolTask("complete_group_activity_today","👥", "Complete group activity today", "Walk steps as part of a group today",      5, groupActivityDone),
        ],
      },
      {
        difficulty: "hard",
        title: "Hard Tasks",
        badge: "HARD",
        description: "Rewards strong activity and race wins",
        tasks: [
          pctTask(   "reach_100pct_goal",    "✅", "Reach 100% daily goal",   dailyGoal,                                               "daily_goal_100", 15),
          infoTask(  "win_free_challenge",   "🏁", "Win a Free Challenge",    "Finish in the top 3 of a free race",                    "1st +50 • 2nd +30 • 3rd +20", grantsClaimed("FREE_RACE_WIN_1", "FREE_RACE_WIN_2", "FREE_RACE_WIN_3")),
          grantTask( "win_private_challenge","🔒", "Win a Private Challenge", "Beat everyone in a private match", 50, null, "PRIVATE_ROOM_WIN"),
        ],
      },
      {
        difficulty: "very_hard",
        title: "Very Hard Tasks",
        badge: "VERY HARD",
        description: "Premium challenges for serious walkers",
        tasks: [
          stepTask("walk_20k",   "👟", "Walk 20,000 steps",               "Double your standard daily goal",              20000, "steps_20k", 40),
          boolTask("streak_7",   "🔥", "7-day goal streak",               "Complete your goal 7 days in a row",           50, streak7Done),
          infoTask("win_coins_battle",    "💰", "Win a Coins Battle",     "Top the prize pool leaderboard",               "Prize pool payout", grantsClaimedPrefix("COINS_BATTLE_WIN_")),
          infoTask("country_vs_win",      "🌎", "Win a Country VS",       "Lead your country to victory",                 "+100", false),
          infoTask("leaderboard_d1",      "👑", "Finish #1 daily",        "Top the global steps board today",             "+100", false),
          infoTask("leaderboard_w1",      "🥇", "Finish #1 weekly",       "Lead the global weekly rankings",              "+250", false),
        ],
      },
    ];

    return res.json({ success: true, coin_balance: balance.currentBalance, groups });
  } catch (err) {
    req.log.error({ err }, "[CoinTasks] earn-tasks error");
    return res.status(500).json({ error: "Failed to fetch earn tasks" });
  }
});

// ── POST /api/coins/tasks/refresh ─────────────────────────────────────────────
// Recalculates task progress from real backend data and auto-awards completions.
// Fully idempotent — safe to call multiple times.
router.post("/coins/tasks/refresh", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const rawDate = typeof req.body?.localDate === "string" ? req.body.localDate : "";
  const localDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
    ? rawDate
    : new Date().toISOString().split("T")[0]!;

  try {
    const [stepsRow, profileRow, raceJoinRow, groupStepRow] = await Promise.all([
      db.select({ steps: stepDailyTotalsTable.steps, goal: stepDailyTotalsTable.goal })
        .from(stepDailyTotalsTable)
        .where(and(eq(stepDailyTotalsTable.userId, userId), eq(stepDailyTotalsTable.date, localDate)))
        .limit(1),
      db.select({ currentStreak: profilesTable.currentStreak })
        .from(profilesTable)
        .where(eq(profilesTable.id, userId))
        .limit(1),
      db.select({ id: raceParticipantsTable.id })
        .from(raceParticipantsTable)
        .where(and(
          eq(raceParticipantsTable.userId, userId),
          sql`${raceParticipantsTable.joinedAt}::date = ${localDate}::date`,
        ))
        .limit(1),
      db.select({ id: walkingGroupDailyStepsTable.id })
        .from(walkingGroupDailyStepsTable)
        .where(and(
          eq(walkingGroupDailyStepsTable.userId, userId),
          sql`${walkingGroupDailyStepsTable.stepDate}::date = ${localDate}::date`,
          sql`${walkingGroupDailyStepsTable.dailySteps} > 0`,
        ))
        .limit(1),
    ]);

    const todaySteps    = stepsRow[0]?.steps ?? 0;
    const dailyGoal     = Math.max(stepsRow[0]?.goal ?? 10000, 1);
    const currentStreak = profileRow[0]?.currentStreak ?? 0;

    req.log.info({ userId, todaySteps, dailyGoal, localDate }, "[CoinTasks] refresh started");

    // Re-evaluate step milestones (idempotent)
    const stepAwarded = await evaluateStepMilestones(userId, todaySteps, localDate, dailyGoal);
    const updatedTasks: { task_key: string; completed: boolean; reward_coins: number }[] =
      stepAwarded.map(a => ({ task_key: a.rewardCode, completed: true, reward_coins: a.coins }));

    // Evaluate non-step tasks sequentially (awardCoins is idempotent)
    if (raceJoinRow[0]) {
      const n = await awardCoins({ userId, amount: 5, source: "coin_task", rewardCode: `join_challenge_${localDate}`, description: "Joined a challenge today", date: localDate });
      if (n > 0) updatedTasks.push({ task_key: "join_any_challenge_today", completed: true, reward_coins: 5 });
    }
    if (groupStepRow[0]) {
      const n = await awardCoins({ userId, amount: 5, source: "coin_task", rewardCode: `group_activity_${localDate}`, description: "Completed group activity today", date: localDate });
      if (n > 0) updatedTasks.push({ task_key: "complete_group_activity_today", completed: true, reward_coins: 5 });
    }
    if (currentStreak >= 7) {
      const n = await awardCoins({ userId, amount: 50, source: "coin_task", rewardCode: `streak_7d_${localDate}`, description: "Maintained a 7-day goal streak", date: localDate });
      if (n > 0) updatedTasks.push({ task_key: "streak_7", completed: true, reward_coins: 50 });
    }

    const balance = await getCoinBalance(userId);
    req.log.info({ userId, newlyAwarded: updatedTasks.length, localDate }, "[CoinTasks] refresh completed");

    return res.json({ success: true, coin_balance: balance.currentBalance, updated_tasks: updatedTasks });
  } catch (err) {
    req.log.error({ err }, "[CoinTasks] refresh error");
    return res.status(500).json({ error: "Failed to refresh coin tasks" });
  }
});

// ── POST /api/coins/ad-reward ─────────────────────────────────────────────────
// Called after the user watches a full rewarded ad in the Shop screen.
const adRewardSchema = z.object({
  localDate: z.string().optional(),
  claim_id: z.string().min(8).max(200).optional(),
  network: z.string().max(50).optional(),
  placement: z.string().max(100).optional(),
});

router.post("/coins/ad-reward", requireAuth, requireActiveAccount, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  try {
    const parsed = adRewardSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid ad reward payload" });
    }

    const rawLD = typeof parsed.data.localDate === "string" ? parsed.data.localDate : "";
    const today = /^\d{4}-\d{2}-\d{2}$/.test(rawLD) ? rawLD : new Date().toISOString().split("T")[0]!;

    const result = await awardAdReward(userId, today, {
      claimId: parsed.data.claim_id,
      network: parsed.data.network,
      placement: parsed.data.placement,
    });

    return res.json({
      success: true,
      duplicate: result.duplicate ?? false,
      coins_awarded: result.awarded,
      new_balance: result.newBalance,
      ads_today: result.adsToday,
      ads_remaining: result.adsRemaining,
      limit: MAX_DAILY_AD_REWARDS,
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "AD_REWARD_LIMIT") {
      const rawLD = typeof req.body?.localDate === "string" ? req.body.localDate : "";
      const today = /^\d{4}-\d{2}-\d{2}$/.test(rawLD) ? rawLD : new Date().toISOString().split("T")[0]!;
      const status = await getDailyAdRewardStatus(userId, today);
      return res.status(429).json({
        error: "You've reached today's ad reward limit. Come back tomorrow!",
        code: "AD_REWARD_LIMIT",
        ads_today: status.adsToday,
        ads_remaining: status.adsRemaining,
        limit: MAX_DAILY_AD_REWARDS,
      });
    }
    req.log.error({ err }, "coins/ad-reward error");
    return res.status(500).json({ error: "Failed to award coins. Please try again." });
  }
});

export default router;
