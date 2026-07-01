import { Router } from "express";
import { db } from "../../db/src/index.js";
import {
  achievementDefinitionsTable,
  userAchievementsTable,
  userTitlesTable,
  profilesTable,
} from "../../db/src/schema/index.js";
import { eq, and, inArray, sql } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import { z } from "zod";
import { evaluateUserTitles } from "../lib/titleEvaluation.js";

const router = Router();

// ── Difficulty order ──────────────────────────────────────────────────────────
const DIFFICULTY_ORDER: Record<string, number> = {
  easy: 1, medium: 2, hard: 3, very_hard: 4, legendary: 5,
};

// ── Goal-to-reach text helpers ────────────────────────────────────────────────
function goalToReachText(
  def: { unlockType: string; targetValue: number | null; title: string; leaderboardScope: string | null; timePeriod: string | null },
  progress: number,
  unlocked: boolean,
): string {
  if (unlocked) return "Unlocked ✓";
  const target    = def.targetValue ?? 1;
  const remaining = Math.max(0, target - progress);

  switch (def.unlockType) {
    // Steps
    case "first_walk":
      return "Sync at least one walking session";
    case "lifetime_steps":
    case "daily_steps":
    case "weekly_steps":
    case "monthly_steps":
      return remaining > 0 ? `${remaining.toLocaleString()} steps left` : "Complete!";
    case "active_days_count":
    case "active_days":
      return remaining > 0 ? `${remaining} more active day${remaining !== 1 ? "s" : ""} needed` : "Complete!";
    case "active_days_week":
      return remaining > 0 ? `Walk ${remaining} more day${remaining !== 1 ? "s" : ""} this week` : "Complete!";
    case "walk_before_time":
      return remaining > 0 ? `Complete ${remaining} more morning walk${remaining !== 1 ? "s" : ""} before 9 AM` : "Complete!";
    case "walk_after_time":
      return remaining > 0 ? `Complete ${remaining} more evening walk${remaining !== 1 ? "s" : ""} after 8 PM` : "Complete!";
    case "goal_streak":
      return remaining > 0 ? `${remaining} more day${remaining !== 1 ? "s" : ""} on streak` : "Complete!";
    case "weekday_goal_streak":
      return remaining > 0 ? `${remaining} more weekday goal${remaining !== 1 ? "s" : ""} in a row` : "Complete!";
    case "daily_goal_percent":
      if (target <= 25) return `Reach 25% of daily goal once`;
      if (target <= 50) return `Reach 50% of daily goal once`;
      if (target <= 75) return `Reach 75% of daily goal once`;
      return `Reach 100% of daily goal once`;

    // Race
    case "race_wins":
      return remaining > 0 ? `Win ${remaining} more race${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "race_top_3":
    case "race_podiums":
      return remaining > 0 ? `${remaining} more podium finish${remaining !== 1 ? "es" : ""}` : "Complete!";
    case "races_completed":
      return remaining > 0 ? `Complete ${remaining} more race${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "races_joined":
      return remaining > 0 ? `Join ${remaining} more race${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "fast_race_finish":
      return remaining > 0 ? `${remaining} fast finish${remaining !== 1 ? "es" : ""} needed` : "Complete!";
    case "fast_1k_race":
      return remaining > 0 ? `Win a 1K race with a fast pace` : "Complete!";
    case "race_comeback_top_3":
      return `Stage a comeback — move into the top 3 from the bottom half`;
    case "friend_races_completed":
      return remaining > 0 ? `Complete ${remaining} more private race${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "free_challenge_wins":
      return remaining > 0 ? `Win ${remaining} more Free Challenge${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "coins_battle_wins":
      return remaining > 0 ? `Win ${remaining} more Coins Battle${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "coins_battle_joined":
      return remaining > 0 ? `Join ${remaining} more Coins Battle${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "public_challenge_wins":
      return remaining > 0 ? `Win ${remaining} more Public Challenge${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "private_challenge_wins":
      return remaining > 0 ? `Win ${remaining} more Private Challenge${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "sponsored_joined":
      return remaining > 0 ? `Join ${remaining} more Sponsored Event${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "sponsored_wins":
      return remaining > 0 ? `Win ${remaining} more Sponsored Event${remaining !== 1 ? "s" : ""}` : "Complete!";

    // Coins
    case "coins_earned":
      return remaining > 0 ? `Earn ${remaining.toLocaleString()} more coins` : "Complete!";
    case "coins_leaderboard_rank": {
      const rank = progress > 0 ? progress : 9999;
      return rank <= target ? "Complete!" : `Reach top ${target} on Coins leaderboard (now #${rank})`;
    }

    // Social
    case "friends_added":
      return remaining > 0 ? `Add ${remaining} more friend${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "cheers_sent":
      return remaining > 0 ? `Send ${remaining} more cheer${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "chat_messages":
      return remaining > 0 ? `Send ${remaining} more message${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "spectated_races":
      return remaining > 0 ? `Spectate ${remaining} more race${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "profile_completed":
      return `Complete your profile with a photo, name, and country`;

    // Groups
    case "groups_created":
      return remaining > 0 ? `Create ${remaining} more group${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "groups_joined":
      return remaining > 0 ? `Join ${remaining} more group${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "group_invites_sent":
      return remaining > 0 ? `Invite ${remaining} more group member${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "group_activity_days":
      return remaining > 0 ? `Contribute steps in a group on ${remaining} more day${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "group_top_walker_days":
      return remaining > 0 ? `Finish as top walker in your group on ${remaining} more day${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "group_rank_1_today":
      return `Your group must finish #1 on the daily group leaderboard`;
    case "group_rank_1_all_time":
      return `Your group must reach #1 on the all-time group leaderboard`;
    case "group_steps_contributed":
      return remaining > 0 ? `Contribute ${remaining.toLocaleString()} more steps to groups` : "Complete!";
    case "group_steps_best":
      return `One of your groups needs ${target.toLocaleString()} all-time steps`;
    case "group_members_total":
      return remaining > 0 ? `Your groups need ${remaining} more total member${remaining !== 1 ? "s" : ""}` : "Complete!";

    // Leaderboard ranks
    case "leaderboard_rank": {
      const scope  = def.leaderboardScope === "regional" ? "Regional" : "Global";
      const rank   = progress > 0 ? progress : null;
      if (def.timePeriod === "today")    return rank ? `${scope} rank today: #${rank} → need #${target}` : `Reach ${scope} rank #${target} today`;
      if (def.timePeriod === "week")     return rank ? `${scope} rank this week: #${rank} → need #${target}` : `Reach ${scope} rank #${target} this week`;
      if (def.timePeriod === "month")    return rank ? `${scope} rank this month: #${rank} → need #${target}` : `Reach ${scope} rank #${target} this month`;
      return rank ? `${scope} all-time rank: #${rank} → need #${target}` : `Reach ${scope} all-time rank #${target}`;
    }
    case "global_rank_1_days":
    case "global_rank_1_streak":
      return remaining > 0 ? `Hold global #1 on ${remaining} more day${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "regional_rank_1_days":
    case "regional_rank_1_streak":
      return remaining > 0 ? `Hold regional #1 on ${remaining} more day${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "rank_improvement_streak":
      return remaining > 0 ? `Improve your rank on ${remaining} more consecutive day${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "top_percent_global_months":
      return remaining > 0 ? `Stay in the global top 1% for ${remaining} more month${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "top_percent_all_time":
      return `Reach the all-time top 1% by lifetime steps`;

    // Titles meta
    case "titles_unlocked":
    case "elite_achievements_unlocked":
      return remaining > 0 ? `Unlock ${remaining} more title${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "legendary_titles_unlocked":
    case "elite_tier":
      return remaining > 0 ? `Unlock ${remaining} more Legendary title${remaining !== 1 ? "s" : ""}` : "Complete!";
    case "combined_elite":
    case "ultimate_title":
      return `Need: 1M+ steps, 100 race wins, 100 friends, and a 30-day streak`;

    default:
      return remaining > 0 ? `${remaining} remaining` : "Complete!";
  }
}

// ── GET /api/achievements/titles ──────────────────────────────────────────────
// All achievement definitions enriched with the current user's progress.
router.get("/achievements/titles", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  try {
    const [defs, userAchs, userTitleRows] = await Promise.all([
      db.select().from(achievementDefinitionsTable).where(eq(achievementDefinitionsTable.isActive, true)),
      db.select().from(userAchievementsTable).where(eq(userAchievementsTable.userId, userId)),
      db.select().from(userTitlesTable).where(eq(userTitlesTable.userId, userId)),
    ]);

    const achByCode   = new Map(userAchs.map((a) => [a.achievementCode, a]));
    const titleByCode = new Map(userTitleRows.map((t) => [t.achievementCode, t]));
    const activeTitle = userTitleRows.find((t) => t.isActive);
    const ownedCount  = userTitleRows.length;

    const titles = defs
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((def) => {
        const ach      = achByCode.get(def.code);
        const owned    = titleByCode.has(def.code);
        const unlocked = ach?.unlocked ?? false;
        const progress = ach?.progressValue ?? 0;
        const tRow     = titleByCode.get(def.code);

        return {
          code:           def.code,
          title:          def.title,
          description:    def.description,
          category:       def.category,
          difficulty:     def.difficulty,
          goal_to_reach:  goalToReachText(def, progress, owned),
          progress_value: progress,
          target_value:   def.targetValue,
          unlocked,
          owned,
          is_active:      tRow?.isActive ?? false,
          unlocked_at:    ach?.unlockedAt?.toISOString() ?? null,
          icon:           def.icon,
          badge_color:    def.badgeColor,
          sort_order:     def.sortOrder,
        };
      });

    let activeTitleData = null;
    if (activeTitle) {
      const def = defs.find((d) => d.code === activeTitle.achievementCode);
      if (def) {
        activeTitleData = { code: def.code, title: def.title, difficulty: def.difficulty, icon: def.icon };
      }
    }

    return res.json({ owned_count: ownedCount, active_title: activeTitleData, titles });
  } catch (err) {
    req.log.error({ err }, "GET /achievements/titles error");
    return res.status(500).json({ error: "Failed to load titles" });
  }
});

// ── POST /api/me/titles/evaluate ──────────────────────────────────────────────
// Evaluates all achievement metrics for the current user from real DB data.
// Returns newly-unlocked titles from this evaluation run.
router.post("/me/titles/evaluate", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  try {
    const newlyUnlocked = await evaluateUserTitles(userId);

    // Refresh owned count after evaluation
    const titleRows = await db
      .select({ cnt: sql<number>`COUNT(*)` })
      .from(userTitlesTable)
      .where(eq(userTitlesTable.userId, userId));

    return res.json({
      newly_unlocked:  newlyUnlocked,
      new_count:       newlyUnlocked.length,
      total_owned:     Number(titleRows[0]?.cnt ?? 0),
    });
  } catch (err) {
    req.log.error({ err }, "POST /me/titles/evaluate error");
    return res.status(500).json({ error: "Evaluation failed" });
  }
});

// ── GET /api/titles/me ────────────────────────────────────────────────────────
// Returns owned titles only with full definition.
router.get("/titles/me", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const titleRows = await db
    .select()
    .from(userTitlesTable)
    .where(eq(userTitlesTable.userId, userId));

  if (!titleRows.length) return res.json({ titles: [], active_title: null });

  const codes = titleRows.map((t) => t.achievementCode);
  const defs  = await db
    .select()
    .from(achievementDefinitionsTable)
    .where(inArray(achievementDefinitionsTable.code, codes));

  const defByCode = new Map(defs.map((d) => [d.code, d]));
  const active    = titleRows.find((t) => t.isActive);

  const titles = titleRows.map((t) => {
    const def = defByCode.get(t.achievementCode);
    return {
      code:        t.achievementCode,
      title:       def?.title ?? t.achievementCode,
      description: def?.description ?? "",
      difficulty:  def?.difficulty ?? "easy",
      icon:        def?.icon ?? null,
      badge_color: def?.badgeColor ?? null,
      is_active:   t.isActive,
      equipped_at: t.equippedAt?.toISOString() ?? null,
    };
  });

  return res.json({
    titles,
    active_title: active
      ? { code: active.achievementCode, title: defByCode.get(active.achievementCode)?.title ?? active.achievementCode }
      : null,
  });
});

// ── POST /api/titles/equip ────────────────────────────────────────────────────
// Equips one owned title as the active title. Clears any previously active.
const equipSchema = z.object({ achievement_code: z.string().min(1) });

router.post("/titles/equip", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const parse = equipSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: parse.error.issues[0]?.message ?? "Invalid request" });
  }

  const { achievement_code } = parse.data;

  // Verify user owns this title
  const owned = await db
    .select()
    .from(userTitlesTable)
    .where(and(eq(userTitlesTable.userId, userId), eq(userTitlesTable.achievementCode, achievement_code)))
    .limit(1);

  if (!owned.length) {
    return res.status(403).json({ error: "You do not own this title." });
  }

  await db
    .update(userTitlesTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(userTitlesTable.userId, userId), eq(userTitlesTable.isActive, true)));

  await db
    .update(userTitlesTable)
    .set({ isActive: true, equippedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(userTitlesTable.userId, userId), eq(userTitlesTable.achievementCode, achievement_code)));

  const def = await db
    .select()
    .from(achievementDefinitionsTable)
    .where(eq(achievementDefinitionsTable.code, achievement_code))
    .limit(1);

  return res.json({
    success: true,
    active_title: {
      code:       achievement_code,
      title:      def[0]?.title ?? achievement_code,
      difficulty: def[0]?.difficulty ?? "easy",
      icon:       def[0]?.icon ?? null,
    },
  });
});

// ── POST /api/titles/unequip ──────────────────────────────────────────────────
// Removes the active title.
router.post("/titles/unequip", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  await db
    .update(userTitlesTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(userTitlesTable.userId, userId), eq(userTitlesTable.isActive, true)));

  return res.json({ success: true, active_title: null });
});

// ── POST /api/dev/seed-my-test-titles ─────────────────────────────────────────
// Dev-only: unlocks daily_starter + first_stepper for the current user.
router.post("/dev/seed-my-test-titles", requireAuth, async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({ error: "Not found" });
  }
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const testCodes = ["daily_starter", "first_stepper"] as const;
  const now = new Date();
  try {
    for (const code of testCodes) {
      await db
        .insert(userAchievementsTable)
        .values({ userId, achievementCode: code, unlocked: true, unlockedAt: now, progressValue: 1 })
        .onConflictDoUpdate({
          target: [userAchievementsTable.userId, userAchievementsTable.achievementCode],
          set: { unlocked: true, unlockedAt: now, updatedAt: now },
        });
      await db
        .insert(userTitlesTable)
        .values({ userId, achievementCode: code, isActive: false })
        .onConflictDoNothing();
    }
    await db.update(userTitlesTable).set({ isActive: false, updatedAt: now }).where(eq(userTitlesTable.userId, userId));
    await db.update(userTitlesTable).set({ isActive: true, equippedAt: now, updatedAt: now })
      .where(and(eq(userTitlesTable.userId, userId), eq(userTitlesTable.achievementCode, "daily_starter")));
    return res.json({ success: true, owned_count: testCodes.length, active: "daily_starter" });
  } catch (err) {
    req.log.error({ err }, "dev/seed-my-test-titles error");
    return res.status(500).json({ error: "Seed failed" });
  }
});

// ── Internal helper: directly unlock a title ──────────────────────────────────
export async function unlockAchievement(userId: string, code: string): Promise<boolean> {
  try {
    const def = await db
      .select()
      .from(achievementDefinitionsTable)
      .where(eq(achievementDefinitionsTable.code, code))
      .limit(1);

    if (!def.length) return false;

    const now = new Date();

    await db
      .insert(userAchievementsTable)
      .values({ userId, achievementCode: code, unlocked: true, unlockedAt: now, progressValue: def[0]?.targetValue ?? 1 })
      .onConflictDoUpdate({
        target: [userAchievementsTable.userId, userAchievementsTable.achievementCode],
        set: { unlocked: true, unlockedAt: now, updatedAt: now },
      });

    await db
      .insert(userTitlesTable)
      .values({ userId, achievementCode: code, isActive: false })
      .onConflictDoNothing();

    return true;
  } catch {
    return false;
  }
}

export default router;
