import { db } from "@db";
import { achievementDefinitionsTable } from "@db/schema";
import { sql, inArray } from "drizzle-orm";

// ── 100 active title definitions ─────────────────────────────────────────────
// No country-battle or cash-race titles.
// No two titles share the same (unlockType + targetValue + leaderboardScope + timePeriod).
const DEFINITIONS = [
  // ── EASY (1–20) ───────────────────────────────────────────────────────────
  { code: "first_stepper",       title: "First Stepper",         description: "Completed your first verified step sync.",               category: "walking",     difficulty: "easy",      unlockType: "first_walk",           targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "👣",  badgeColor: "#00E676", sortOrder: 1  },
  { code: "daily_starter",       title: "Daily Starter",         description: "Walked on at least 1 active day.",                      category: "daily",       difficulty: "easy",      unlockType: "active_days_count",    targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "🌅",  badgeColor: "#00E676", sortOrder: 2  },
  { code: "goal_chaser",         title: "Goal Chaser",           description: "Reached 25% of your daily goal at least once.",         category: "daily",       difficulty: "easy",      unlockType: "daily_goal_percent",   targetValue: 25,       leaderboardScope: null, timePeriod: null,       icon: "🎯",  badgeColor: "#00E676", sortOrder: 3  },
  { code: "halfway_hero",        title: "Halfway Hero",          description: "Reached 50% of your daily goal at least once.",         category: "daily",       difficulty: "easy",      unlockType: "daily_goal_percent",   targetValue: 50,       leaderboardScope: null, timePeriod: null,       icon: "⚡",  badgeColor: "#00E676", sortOrder: 4  },
  { code: "almost_there",        title: "Almost There",          description: "Reached 75% of your daily goal at least once.",         category: "daily",       difficulty: "easy",      unlockType: "daily_goal_percent",   targetValue: 75,       leaderboardScope: null, timePeriod: null,       icon: "🔥",  badgeColor: "#00E676", sortOrder: 5  },
  { code: "goal_finisher",       title: "Goal Finisher",         description: "Reached 100% of your daily goal at least once.",        category: "daily",       difficulty: "easy",      unlockType: "daily_goal_percent",   targetValue: 100,      leaderboardScope: null, timePeriod: null,       icon: "✅",  badgeColor: "#00E676", sortOrder: 6  },
  { code: "one_k_walker",        title: "1K Walker",             description: "Completed 1,000 steps in a single day.",               category: "steps",       difficulty: "easy",      unlockType: "daily_steps",          targetValue: 1000,     leaderboardScope: null, timePeriod: null,       icon: "🚶",  badgeColor: "#00E676", sortOrder: 7  },
  { code: "five_k_walker",       title: "5K Walker",             description: "Completed 5,000 steps in a single day.",               category: "steps",       difficulty: "easy",      unlockType: "daily_steps",          targetValue: 5000,     leaderboardScope: null, timePeriod: null,       icon: "🏃",  badgeColor: "#00E676", sortOrder: 8  },
  { code: "morning_walker",      title: "Morning Walker",        description: "Completed a walk before 9 AM.",                         category: "walking",     difficulty: "easy",      unlockType: "walk_before_time",     targetValue: 9,        leaderboardScope: null, timePeriod: null,       icon: "🌄",  badgeColor: "#00E676", sortOrder: 9  },
  { code: "night_walker",        title: "Night Walker",          description: "Completed a walk after 8 PM.",                          category: "walking",     difficulty: "easy",      unlockType: "walk_after_time",      targetValue: 20,       leaderboardScope: null, timePeriod: null,       icon: "🌙",  badgeColor: "#00E676", sortOrder: 10 },
  { code: "first_race_finisher", title: "First Race Finisher",   description: "Completed your first race.",                            category: "race",        difficulty: "easy",      unlockType: "races_completed",      targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "🏁",  badgeColor: "#00E676", sortOrder: 11 },
  { code: "rookie_racer",        title: "Rookie Racer",          description: "Joined your first live race.",                          category: "race",        difficulty: "easy",      unlockType: "races_joined",         targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "🎽",  badgeColor: "#00E676", sortOrder: 12 },
  { code: "friendly_walker",     title: "Friendly Walker",       description: "Added your first friend.",                              category: "social",      difficulty: "easy",      unlockType: "friends_added",        targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "🤝",  badgeColor: "#00E676", sortOrder: 13 },
  { code: "cheer_giver",         title: "Cheer Giver",           description: "Sent a live race cheer.",                              category: "social",      difficulty: "easy",      unlockType: "cheers_sent",          targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "📣",  badgeColor: "#00E676", sortOrder: 14 },
  { code: "spectator",           title: "Spectator",             description: "Spectated or cheered in a live race.",                 category: "social",      difficulty: "easy",      unlockType: "spectated_races",      targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "👀",  badgeColor: "#00E676", sortOrder: 15 },
  { code: "group_starter",       title: "Group Starter",         description: "Created your first walking group.",                    category: "groups",      difficulty: "easy",      unlockType: "groups_created",       targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "🏕️",  badgeColor: "#00E676", sortOrder: 16 },
  { code: "group_joiner",        title: "Group Joiner",          description: "Joined your first walking group.",                     category: "groups",      difficulty: "easy",      unlockType: "groups_joined",        targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "🚪",  badgeColor: "#00E676", sortOrder: 17 },
  { code: "first_invite",        title: "First Invite",          description: "Invited a member to a walking group.",                 category: "groups",      difficulty: "easy",      unlockType: "group_invites_sent",   targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "✉️",  badgeColor: "#00E676", sortOrder: 18 },
  { code: "coin_starter",        title: "Coin Starter",          description: "Earned 50 coins from races or tasks.",                 category: "coins",       difficulty: "easy",      unlockType: "coins_earned",         targetValue: 50,       leaderboardScope: null, timePeriod: null,       icon: "🪙",  badgeColor: "#00E676", sortOrder: 19 },
  { code: "profile_ready",       title: "Profile Ready",         description: "Completed your profile photo, name, and country.",     category: "social",      difficulty: "easy",      unlockType: "profile_completed",    targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "👤",  badgeColor: "#00E676", sortOrder: 20 },
  // ── MEDIUM (21–45) ────────────────────────────────────────────────────────
  { code: "bronze_walker",       title: "Bronze Walker",         description: "Walked on 7 active days.",                             category: "consistency", difficulty: "medium",    unlockType: "active_days_count",    targetValue: 7,        leaderboardScope: null, timePeriod: null,       icon: "🥉",  badgeColor: "#FFD700", sortOrder: 21 },
  { code: "weekly_warrior",      title: "Weekly Warrior",        description: "Walked at least 5 days in a single week.",            category: "consistency", difficulty: "medium",    unlockType: "active_days_week",     targetValue: 5,        leaderboardScope: null, timePeriod: null,       icon: "⭐",  badgeColor: "#FFD700", sortOrder: 22 },
  { code: "ten_k_club",          title: "10K Club",              description: "Completed 10,000 steps in a single day.",             category: "steps",       difficulty: "medium",    unlockType: "daily_steps",          targetValue: 10000,    leaderboardScope: null, timePeriod: null,       icon: "💪",  badgeColor: "#FFD700", sortOrder: 23 },
  { code: "consistent_walker",   title: "Consistent Walker",     description: "Hit your daily goal 3 days in a row.",                category: "streak",      difficulty: "medium",    unlockType: "goal_streak",          targetValue: 3,        leaderboardScope: null, timePeriod: null,       icon: "📆",  badgeColor: "#FFD700", sortOrder: 24 },
  { code: "streak_builder",      title: "Streak Builder",        description: "Hit your daily goal 7 days in a row.",                category: "streak",      difficulty: "medium",    unlockType: "goal_streak",          targetValue: 7,        leaderboardScope: null, timePeriod: null,       icon: "🔥",  badgeColor: "#FFD700", sortOrder: 25 },
  { code: "race_contender",      title: "Race Contender",        description: "Finished in the top 3 of a race.",                   category: "race",        difficulty: "medium",    unlockType: "race_top_3",           targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "🥇",  badgeColor: "#FFD700", sortOrder: 26 },
  { code: "race_winner",         title: "Race Winner",           description: "Won your first live race.",                           category: "race",        difficulty: "medium",    unlockType: "race_wins",            targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "🏆",  badgeColor: "#FFD700", sortOrder: 27 },
  { code: "fast_finisher",       title: "Fast Finisher",         description: "Finished a race before your opponents completed 1K.",  category: "race",        difficulty: "medium",    unlockType: "fast_race_finish",     targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "⚡",  badgeColor: "#FFD700", sortOrder: 28 },
  { code: "friend_challenger",   title: "Friend Challenger",     description: "Completed 5 private or friend challenges.",           category: "social",      difficulty: "medium",    unlockType: "friend_races_completed",targetValue: 5,        leaderboardScope: null, timePeriod: null,       icon: "👥",  badgeColor: "#FFD700", sortOrder: 29 },
  { code: "regional_top_10",     title: "Regional Top 10 Today", description: "Finished top 10 in your regional today leaderboard.", category: "leaderboard", difficulty: "medium",    unlockType: "leaderboard_rank",     targetValue: 10,       leaderboardScope: "regional", timePeriod: "today",   icon: "🗺️",  badgeColor: "#FFD700", sortOrder: 30 },
  { code: "regional_top10_weekly",title: "Regional Top 10 Weekly",description: "Finished top 10 in your regional weekly leaderboard.",category: "leaderboard", difficulty: "medium",    unlockType: "leaderboard_rank",     targetValue: 10,       leaderboardScope: "regional", timePeriod: "week",    icon: "📅",  badgeColor: "#FFD700", sortOrder: 31 },
  { code: "global_top100_today", title: "Global Top 100 Today",  description: "Entered the global top 100 today.",                  category: "leaderboard", difficulty: "medium",    unlockType: "leaderboard_rank",     targetValue: 100,      leaderboardScope: "global", timePeriod: "today",     icon: "🌍",  badgeColor: "#FFD700", sortOrder: 32 },
  { code: "global_top100_weekly",title: "Global Top 100 Weekly", description: "Entered the global top 100 this week.",              category: "leaderboard", difficulty: "medium",    unlockType: "leaderboard_rank",     targetValue: 100,      leaderboardScope: "global", timePeriod: "week",      icon: "📊",  badgeColor: "#FFD700", sortOrder: 33 },
  { code: "rising_walker",       title: "Rising Walker",         description: "Improved your global rank 3 days in a row.",         category: "leaderboard", difficulty: "medium",    unlockType: "rank_improvement_streak",targetValue: 3,       leaderboardScope: null, timePeriod: null,       icon: "📈",  badgeColor: "#FFD700", sortOrder: 34 },
  { code: "coins_earner",        title: "Coins Earner",          description: "Earned 500 coins from races and tasks.",             category: "coins",       difficulty: "medium",    unlockType: "coins_earned",         targetValue: 500,      leaderboardScope: null, timePeriod: null,       icon: "💰",  badgeColor: "#FFD700", sortOrder: 35 },
  { code: "coins_battle_rookie", title: "Coins Battle Rookie",   description: "Joined your first Coins Battle.",                    category: "coins",       difficulty: "medium",    unlockType: "coins_battle_joined",  targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "🎮",  badgeColor: "#FFD700", sortOrder: 36 },
  { code: "coins_battle_winner", title: "Coins Battle Winner",   description: "Won your first Coins Battle.",                       category: "coins",       difficulty: "medium",    unlockType: "coins_battle_wins",    targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "🏅",  badgeColor: "#FFD700", sortOrder: 37 },
  { code: "free_challenge_winner",title: "Free Challenge Winner", description: "Won a Free Challenge race.",                         category: "race",        difficulty: "medium",    unlockType: "free_challenge_wins",  targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "🏁",  badgeColor: "#FFD700", sortOrder: 38 },
  { code: "public_room_winner",  title: "Public Room Winner",    description: "Won a Public Challenge room.",                       category: "race",        difficulty: "medium",    unlockType: "public_challenge_wins",targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "🌐",  badgeColor: "#FFD700", sortOrder: 39 },
  { code: "private_room_winner", title: "Private Room Winner",   description: "Won a Private Challenge room.",                      category: "race",        difficulty: "medium",    unlockType: "private_challenge_wins",targetValue: 1,       leaderboardScope: null, timePeriod: null,       icon: "🔒",  badgeColor: "#FFD700", sortOrder: 40 },
  { code: "group_pacer",         title: "Group Pacer",           description: "Finished as the top walker in a group for a day.",  category: "groups",      difficulty: "medium",    unlockType: "group_top_walker_days",targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "🏃",  badgeColor: "#FFD700", sortOrder: 41 },
  { code: "team_player",         title: "Team Player",           description: "Contributed steps to a group on 5 different days.", category: "groups",      difficulty: "medium",    unlockType: "group_activity_days",  targetValue: 5,        leaderboardScope: null, timePeriod: null,       icon: "🤜",  badgeColor: "#FFD700", sortOrder: 42 },
  { code: "friend_collector",    title: "Friend Collector",      description: "Made 10 friends.",                                   category: "social",      difficulty: "medium",    unlockType: "friends_added",        targetValue: 10,       leaderboardScope: null, timePeriod: null,       icon: "👫",  badgeColor: "#FFD700", sortOrder: 43 },
  { code: "social_walker",       title: "Social Walker",         description: "Sent 25 chat or cheer messages.",                   category: "social",      difficulty: "medium",    unlockType: "chat_messages",        targetValue: 25,       leaderboardScope: null, timePeriod: null,       icon: "💬",  badgeColor: "#FFD700", sortOrder: 44 },
  { code: "sponsored_runner",    title: "Sponsored Runner",      description: "Joined a Sponsored Event.",                         category: "events",      difficulty: "medium",    unlockType: "sponsored_joined",     targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "🎪",  badgeColor: "#FFD700", sortOrder: 45 },
  // ── HARD (46–70) ─────────────────────────────────────────────────────────
  { code: "weekly_champion",     title: "Weekly Champion",       description: "Finished global #1 for the week.",                  category: "leaderboard", difficulty: "hard",      unlockType: "leaderboard_rank",     targetValue: 1,        leaderboardScope: "global", timePeriod: "week",      icon: "👑",  badgeColor: "#FF6B00", sortOrder: 46 },
  { code: "monthly_top_10",      title: "Monthly Top 10",        description: "Finished global top 10 for the month.",             category: "leaderboard", difficulty: "hard",      unlockType: "leaderboard_rank",     targetValue: 10,       leaderboardScope: "global", timePeriod: "month",     icon: "📆",  badgeColor: "#FF6B00", sortOrder: 47 },
  { code: "regional_champion",   title: "Regional Champion Today",description: "Finished #1 in your region today.",                category: "leaderboard", difficulty: "hard",      unlockType: "leaderboard_rank",     targetValue: 1,        leaderboardScope: "regional", timePeriod: "today",   icon: "🗺️",  badgeColor: "#FF6B00", sortOrder: 48 },
  { code: "regional_champion_weekly",title: "Regional Champion Weekly",description: "Finished #1 in your region this week.",       category: "leaderboard", difficulty: "hard",      unlockType: "leaderboard_rank",     targetValue: 1,        leaderboardScope: "regional", timePeriod: "week",    icon: "📅",  badgeColor: "#FF6B00", sortOrder: 49 },
  { code: "regional_champion_monthly",title:"Regional Champion Monthly",description:"Finished #1 in your region this month.",      category: "leaderboard", difficulty: "hard",      unlockType: "leaderboard_rank",     targetValue: 1,        leaderboardScope: "regional", timePeriod: "month",   icon: "🏆",  badgeColor: "#FF6B00", sortOrder: 50 },
  { code: "regional_all_time_elite",title: "Regional All-Time Elite",description: "Reached regional all-time top 10.",             category: "leaderboard", difficulty: "hard",      unlockType: "leaderboard_rank",     targetValue: 10,       leaderboardScope: "regional", timePeriod: "all_time",icon: "🌟",  badgeColor: "#FF6B00", sortOrder: 51 },
  { code: "global_top_50",       title: "Global Top 50",         description: "Reached global all-time top 50.",                  category: "leaderboard", difficulty: "hard",      unlockType: "leaderboard_rank",     targetValue: 50,       leaderboardScope: "global", timePeriod: "all_time",  icon: "🌍",  badgeColor: "#FF6B00", sortOrder: 52 },
  { code: "global_top_25",       title: "Global Top 25",         description: "Reached global all-time top 25.",                  category: "leaderboard", difficulty: "hard",      unlockType: "leaderboard_rank",     targetValue: 25,       leaderboardScope: "global", timePeriod: "all_time",  icon: "🌍",  badgeColor: "#FF6B00", sortOrder: 53 },
  { code: "twenty_k_beast",      title: "20K Beast",             description: "Completed 20,000 steps in a single day.",          category: "steps",       difficulty: "hard",      unlockType: "daily_steps",          targetValue: 20000,    leaderboardScope: null, timePeriod: null,       icon: "💥",  badgeColor: "#FF6B00", sortOrder: 54 },
  { code: "marathon_walker",     title: "Marathon Walker",       description: "Completed 42,000 steps in a single day.",          category: "steps",       difficulty: "hard",      unlockType: "daily_steps",          targetValue: 42000,    leaderboardScope: null, timePeriod: null,       icon: "🏃",  badgeColor: "#FF6B00", sortOrder: 55 },
  { code: "endurance_walker",    title: "Endurance Walker",      description: "Walked 70,000 steps in a single week.",            category: "steps",       difficulty: "hard",      unlockType: "weekly_steps",         targetValue: 70000,    leaderboardScope: null, timePeriod: null,       icon: "🏋️",  badgeColor: "#FF6B00", sortOrder: 56 },
  { code: "streak_master",       title: "Streak Master",         description: "Hit your daily goal 30 days in a row.",            category: "streak",      difficulty: "hard",      unlockType: "goal_streak",          targetValue: 30,       leaderboardScope: null, timePeriod: null,       icon: "🔥",  badgeColor: "#FF6B00", sortOrder: 57 },
  { code: "race_dominator",      title: "Race Dominator",        description: "Won 10 races.",                                     category: "race",        difficulty: "hard",      unlockType: "race_wins",            targetValue: 10,       leaderboardScope: null, timePeriod: null,       icon: "🏆",  badgeColor: "#FF6B00", sortOrder: 58 },
  { code: "podium_king",         title: "Podium King",           description: "Finished top 3 in 25 races.",                      category: "race",        difficulty: "hard",      unlockType: "race_podiums",         targetValue: 25,       leaderboardScope: null, timePeriod: null,       icon: "👑",  badgeColor: "#FF6B00", sortOrder: 59 },
  { code: "elite_walker",        title: "Elite Walker",          description: "Reached 100,000 lifetime steps.",                  category: "steps",       difficulty: "hard",      unlockType: "lifetime_steps",       targetValue: 100000,   leaderboardScope: null, timePeriod: null,       icon: "👟",  badgeColor: "#FF6B00", sortOrder: 60 },
  { code: "speed_strider",       title: "Speed Strider",         description: "Finished a 1K race with exceptional pace.",        category: "race",        difficulty: "hard",      unlockType: "fast_1k_race",         targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "⚡",  badgeColor: "#FF6B00", sortOrder: 61 },
  { code: "comeback_walker",     title: "Comeback Walker",       description: "Moved from the bottom half into the top 3 in a race.", category: "race",   difficulty: "hard",      unlockType: "race_comeback_top_3",  targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "🔄",  badgeColor: "#FF6B00", sortOrder: 62 },
  { code: "group_captain",       title: "Group Captain",         description: "Created 5 walking groups.",                        category: "groups",      difficulty: "hard",      unlockType: "groups_created",       targetValue: 5,        leaderboardScope: null, timePeriod: null,       icon: "🚩",  badgeColor: "#FF6B00", sortOrder: 63 },
  { code: "group_champion_today",title: "Group Champion Today",  description: "Your group finished #1 on the group today leaderboard.", category: "groups",difficulty: "hard",      unlockType: "group_rank_1_today",   targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "🥇",  badgeColor: "#FF6B00", sortOrder: 64 },
  { code: "group_million_builder",title: "Group Million Builder",description: "Contributed 1,000,000 steps to your groups total.", category: "groups",    difficulty: "hard",      unlockType: "group_steps_contributed",targetValue: 1000000,  leaderboardScope: null, timePeriod: null,       icon: "🌱",  badgeColor: "#FF6B00", sortOrder: 65 },
  { code: "sponsored_winner",    title: "Sponsored Winner",      description: "Won a prize slot in a Sponsored Event.",           category: "events",      difficulty: "hard",      unlockType: "sponsored_wins",       targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "🎖️",  badgeColor: "#FF6B00", sortOrder: 66 },
  { code: "coins_champion",      title: "Coins Champion",        description: "Reached top 10 on the Coins leaderboard.",         category: "coins",       difficulty: "hard",      unlockType: "coins_leaderboard_rank",targetValue: 10,       leaderboardScope: null, timePeriod: null,       icon: "💎",  badgeColor: "#FF6B00", sortOrder: 67 },
  { code: "coins_battle_veteran",title: "Coins Battle Veteran",  description: "Won 10 Coins Battles.",                            category: "coins",       difficulty: "hard",      unlockType: "coins_battle_wins",    targetValue: 10,       leaderboardScope: null, timePeriod: null,       icon: "🎖️",  badgeColor: "#FF6B00", sortOrder: 68 },
  { code: "friends_hero_100",    title: "100 Friends Hero",      description: "Made 100 friends.",                                 category: "social",      difficulty: "hard",      unlockType: "friends_added",        targetValue: 100,      leaderboardScope: null, timePeriod: null,       icon: "🌐",  badgeColor: "#FF6B00", sortOrder: 69 },
  { code: "titles_hero_50",      title: "50 Titles Hero",        description: "Unlocked 50 titles.",                              category: "legendary",   difficulty: "hard",      unlockType: "titles_unlocked",      targetValue: 50,       leaderboardScope: null, timePeriod: null,       icon: "🎗️",  badgeColor: "#FF6B00", sortOrder: 70 },
  // ── VERY HARD (71–85) ─────────────────────────────────────────────────────
  { code: "daily_champion",      title: "Global Champion Today", description: "Finished #1 globally today.",                       category: "leaderboard", difficulty: "very_hard", unlockType: "leaderboard_rank",     targetValue: 1,        leaderboardScope: "global", timePeriod: "today",     icon: "🌐",  badgeColor: "#FF0057", sortOrder: 71 },
  { code: "monthly_champion",    title: "Global Champion Monthly",description: "Finished #1 globally for the month.",              category: "leaderboard", difficulty: "very_hard", unlockType: "leaderboard_rank",     targetValue: 1,        leaderboardScope: "global", timePeriod: "month",     icon: "👑",  badgeColor: "#FF0057", sortOrder: 72 },
  { code: "global_top_10",       title: "Global Top 10 All-Time",description: "Reached global all-time top 10.",                  category: "leaderboard", difficulty: "very_hard", unlockType: "leaderboard_rank",     targetValue: 10,       leaderboardScope: "global", timePeriod: "all_time",  icon: "🌍",  badgeColor: "#FF0057", sortOrder: 73 },
  { code: "global_crown_holder", title: "Global Crown Holder",   description: "Held the global #1 spot on 7 different days.",     category: "leaderboard", difficulty: "very_hard", unlockType: "global_rank_1_days",   targetValue: 7,        leaderboardScope: "global", timePeriod: null,       icon: "👑",  badgeColor: "#FF0057", sortOrder: 74 },
  { code: "regional_legend",     title: "Regional Legend",        description: "Held regional #1 on 7 different days.",            category: "leaderboard", difficulty: "very_hard", unlockType: "regional_rank_1_days", targetValue: 7,        leaderboardScope: "regional", timePeriod: null,      icon: "🗺️",  badgeColor: "#FF0057", sortOrder: 75 },
  { code: "race_legend",         title: "Race Legend",            description: "Won 50 races.",                                    category: "race",        difficulty: "very_hard", unlockType: "race_wins",            targetValue: 50,       leaderboardScope: null, timePeriod: null,       icon: "🏆",  badgeColor: "#FF0057", sortOrder: 76 },
  { code: "hundred_k_week_club", title: "100K Week Club",         description: "Walked 100,000+ steps in a single week.",         category: "steps",       difficulty: "very_hard", unlockType: "weekly_steps",         targetValue: 100000,   leaderboardScope: null, timePeriod: null,       icon: "💪",  badgeColor: "#FF0057", sortOrder: 77 },
  { code: "five_hundred_k_month_club",title:"500K Month Club",   description: "Walked 500,000+ steps in a single month.",        category: "steps",       difficulty: "very_hard", unlockType: "monthly_steps",        targetValue: 500000,   leaderboardScope: null, timePeriod: null,       icon: "🔥",  badgeColor: "#FF0057", sortOrder: 78 },
  { code: "iron_streak",         title: "Iron Streak",            description: "Hit your daily goal 60 days in a row.",           category: "streak",      difficulty: "very_hard", unlockType: "goal_streak",          targetValue: 60,       leaderboardScope: null, timePeriod: null,       icon: "⚙️",  badgeColor: "#FF0057", sortOrder: 79 },
  { code: "no_excuses",          title: "No Excuses",             description: "Hit your daily goal every weekday in a full week.",category: "consistency", difficulty: "very_hard", unlockType: "weekday_goal_streak",  targetValue: 5,        leaderboardScope: null, timePeriod: null,       icon: "💯",  badgeColor: "#FF0057", sortOrder: 80 },
  { code: "group_empire_builder",title: "Group Empire Builder",   description: "Created 25 walking groups.",                       category: "groups",      difficulty: "very_hard", unlockType: "groups_created",       targetValue: 25,       leaderboardScope: null, timePeriod: null,       icon: "🏰",  badgeColor: "#FF0057", sortOrder: 81 },
  { code: "group_all_time_champion",title:"Group All-Time Champion",description:"Your group ranked #1 on the all-time group leaderboard.", category: "groups",difficulty:"very_hard",unlockType:"group_rank_1_all_time",targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "🥇",  badgeColor: "#FF0057", sortOrder: 82 },
  { code: "million_step_group",  title: "Million-Step Group",     description: "Your group reached 1,000,000 all-time steps.",    category: "groups",      difficulty: "very_hard", unlockType: "group_steps_best",     targetValue: 1000000,  leaderboardScope: null, timePeriod: null,       icon: "🏔️",  badgeColor: "#FF0057", sortOrder: 83 },
  { code: "sponsored_champion",  title: "Sponsored Champion",     description: "Won 5 Sponsored Event prize slots.",               category: "events",      difficulty: "very_hard", unlockType: "sponsored_wins",       targetValue: 5,        leaderboardScope: null, timePeriod: null,       icon: "🎗️",  badgeColor: "#FF0057", sortOrder: 84 },
  { code: "titles_legend_100",   title: "100 Titles Legend",      description: "Unlocked all 100 titles.",                         category: "legendary",   difficulty: "very_hard", unlockType: "titles_unlocked",      targetValue: 100,      leaderboardScope: null, timePeriod: null,       icon: "💯",  badgeColor: "#FF0057", sortOrder: 85 },
  // ── LEGENDARY (86–100) ────────────────────────────────────────────────────
  { code: "walkchamp_legend",         title: "WalkChamp Legend",           description: "Reached global all-time rank #1.",                    category: "legendary", difficulty: "legendary", unlockType: "leaderboard_rank",         targetValue: 1,        leaderboardScope: "global", timePeriod: "all_time",  icon: "🌟",  badgeColor: "#9B59B6", sortOrder: 86 },
  { code: "world_class_walker",       title: "World Class Walker",         description: "Reached global all-time top 3.",                     category: "legendary", difficulty: "legendary", unlockType: "leaderboard_rank",         targetValue: 3,        leaderboardScope: "global", timePeriod: "all_time",  icon: "🌏",  badgeColor: "#9B59B6", sortOrder: 87 },
  { code: "hall_of_fame_walker",      title: "Hall of Fame Walker",        description: "Reached global all-time top 5.",                     category: "legendary", difficulty: "legendary", unlockType: "leaderboard_rank",         targetValue: 5,        leaderboardScope: "global", timePeriod: "all_time",  icon: "🏛️",  badgeColor: "#9B59B6", sortOrder: 88 },
  { code: "one_million_steps_club",   title: "1 Million Steps Club",       description: "Reached 1,000,000 lifetime steps.",                  category: "steps",     difficulty: "legendary", unlockType: "lifetime_steps",           targetValue: 1000000,  leaderboardScope: null, timePeriod: null,       icon: "💎",  badgeColor: "#9B59B6", sortOrder: 89 },
  { code: "five_million_steps_club",  title: "5 Million Steps Club",       description: "Reached 5,000,000 lifetime steps.",                  category: "steps",     difficulty: "legendary", unlockType: "lifetime_steps",           targetValue: 5000000,  leaderboardScope: null, timePeriod: null,       icon: "💠",  badgeColor: "#9B59B6", sortOrder: 90 },
  { code: "ten_million_steps_legend", title: "10 Million Steps Legend",    description: "Reached 10,000,000 lifetime steps.",                 category: "steps",     difficulty: "legendary", unlockType: "lifetime_steps",           targetValue: 10000000, leaderboardScope: null, timePeriod: null,       icon: "🌌",  badgeColor: "#9B59B6", sortOrder: 91 },
  { code: "hundred_race_champion",    title: "100 Race Champion",          description: "Won 100 races.",                                     category: "race",      difficulty: "legendary", unlockType: "race_wins",               targetValue: 100,      leaderboardScope: null, timePeriod: null,       icon: "🏆",  badgeColor: "#9B59B6", sortOrder: 92 },
  { code: "eternal_streak",           title: "Eternal Streak",             description: "Hit your daily goal 365 days in a row.",             category: "streak",    difficulty: "legendary", unlockType: "goal_streak",             targetValue: 365,      leaderboardScope: null, timePeriod: null,       icon: "♾️",  badgeColor: "#9B59B6", sortOrder: 93 },
  { code: "grandmaster_walker",       title: "Grandmaster Walker",         description: "Unlocked 75 titles.",                                category: "legendary", difficulty: "legendary", unlockType: "titles_unlocked",         targetValue: 75,       leaderboardScope: null, timePeriod: null,       icon: "🎖️",  badgeColor: "#9B59B6", sortOrder: 94 },
  { code: "supreme_strider",          title: "Supreme Strider",            description: "Stayed in the global top 1% for 3 months.",          category: "leaderboard",difficulty:"legendary",  unlockType: "top_percent_global_months",targetValue: 3,        leaderboardScope: "global", timePeriod: null,       icon: "🌠",  badgeColor: "#9B59B6", sortOrder: 95 },
  { code: "walking_titan",            title: "Walking Titan",              description: "Reached all-time top 1% by lifetime steps.",         category: "leaderboard",difficulty:"legendary",  unlockType: "top_percent_all_time",    targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "🗿",  badgeColor: "#9B59B6", sortOrder: 96 },
  { code: "immortal_walker",          title: "Immortal Walker",            description: "Unlocked 10 Legendary titles.",                      category: "legendary", difficulty: "legendary", unlockType: "legendary_titles_unlocked",targetValue: 10,       leaderboardScope: null, timePeriod: null,       icon: "⚡",  badgeColor: "#9B59B6", sortOrder: 97 },
  { code: "the_walkchamp",            title: "The WalkChamp",              description: "1M steps + 100 race wins + 100 friends + 30-day streak.", category: "legendary",difficulty:"legendary",unlockType: "combined_elite",          targetValue: 1,        leaderboardScope: null, timePeriod: null,       icon: "🏅",  badgeColor: "#FFD700", sortOrder: 98 },
  { code: "sponsored_star",           title: "Sponsored Star",             description: "Won 10 Sponsored Event prize slots.",                category: "events",    difficulty: "legendary", unlockType: "sponsored_wins",          targetValue: 10,       leaderboardScope: null, timePeriod: null,       icon: "⭐",  badgeColor: "#9B59B6", sortOrder: 99 },
  { code: "ultimate_circle_builder",  title: "Ultimate Circle Builder",    description: "Built groups with 500 total accepted members.",       category: "groups",    difficulty: "legendary", unlockType: "group_members_total",     targetValue: 500,      leaderboardScope: null, timePeriod: null,       icon: "🌐",  badgeColor: "#9B59B6", sortOrder: 100 },
];

// ── Extra definitions for codes present in TitleBadge.tsx BADGE_MAP ──────────
// These were previously in DEACTIVATE_CODES but must stay active so users can
// see and equip them from My Titles.
const EXTRA_DEFS = [
  { code: "daily_top_10",   title: "Daily Top 10",    description: "Reach the global top 10 on the daily leaderboard.",     category: "leaderboard", difficulty: "medium",    unlockType: "leaderboard_rank", targetValue: 10,     leaderboardScope: "global",   timePeriod: "today",    icon: "📊",  badgeColor: "#FFD740", sortOrder: 115 },
  { code: "daily_top_3",    title: "Daily Top 3",     description: "Reach the global top 3 on the daily leaderboard.",      category: "leaderboard", difficulty: "medium",    unlockType: "leaderboard_rank", targetValue: 3,      leaderboardScope: "global",   timePeriod: "today",    icon: "🥉",  badgeColor: "#FFD700", sortOrder: 116 },
  { code: "weekly_top_10",  title: "Weekly Top 10",   description: "Reach the global top 10 on the weekly leaderboard.",    category: "leaderboard", difficulty: "medium",    unlockType: "leaderboard_rank", targetValue: 10,     leaderboardScope: "global",   timePeriod: "week",     icon: "📅",  badgeColor: "#FFA726", sortOrder: 117 },
  { code: "global_top_100", title: "Global Top 100",  description: "Reach the global top 100 on the all-time leaderboard.", category: "leaderboard", difficulty: "medium",    unlockType: "leaderboard_rank", targetValue: 100,    leaderboardScope: "global",   timePeriod: "all_time", icon: "🌍",  badgeColor: "#FFB300", sortOrder: 118 },
  { code: "country_warrior",title: "Country Warrior", description: "Reach the regional top 3 on the daily leaderboard.",   category: "leaderboard", difficulty: "hard",      unlockType: "leaderboard_rank", targetValue: 3,      leaderboardScope: "regional", timePeriod: "today",    icon: "🚩",  badgeColor: "#FF7043", sortOrder: 119 },
  { code: "country_hero",   title: "Country Hero",    description: "Hold the regional #1 spot for 30 days.",               category: "leaderboard", difficulty: "legendary", unlockType: "regional_rank_1_days", targetValue: 30, leaderboardScope: null,       timePeriod: null,       icon: "🏅",  badgeColor: "#9B59B6", sortOrder: 120 },
  { code: "global_champion",title: "Global Champion", description: "Reach global #1 on the all-time leaderboard.",         category: "leaderboard", difficulty: "very_hard", unlockType: "leaderboard_rank", targetValue: 1,      leaderboardScope: "global",   timePeriod: "all_time", icon: "🏆",  badgeColor: "#FF0057", sortOrder: 121 },
  { code: "unstoppable",    title: "Unstoppable",     description: "Walk 500,000 lifetime steps.",                          category: "steps",       difficulty: "very_hard", unlockType: "lifetime_steps",   targetValue: 500000, leaderboardScope: null,       timePeriod: null,       icon: "♾️",  badgeColor: "#FF0057", sortOrder: 122 },
];

// No codes to deactivate — all previously listed codes are now kept active.
const DEACTIVATE_CODES: string[] = [];

async function main() {
  console.log(`Seeding ${DEFINITIONS.length} achievement definitions...`);

  for (const def of DEFINITIONS) {
    await db
      .insert(achievementDefinitionsTable)
      .values({
        code:             def.code,
        title:            def.title,
        description:      def.description,
        category:         def.category,
        difficulty:       def.difficulty,
        unlockType:       def.unlockType,
        targetValue:      def.targetValue ?? null,
        leaderboardScope: def.leaderboardScope ?? null,
        timePeriod:       def.timePeriod ?? null,
        icon:             def.icon ?? null,
        badgeColor:       def.badgeColor ?? null,
        xpReward:         0,
        sortOrder:        def.sortOrder,
        isActive:         true,
      })
      .onConflictDoUpdate({
        target: achievementDefinitionsTable.code,
        set: {
          title:            sql`EXCLUDED.title`,
          description:      sql`EXCLUDED.description`,
          category:         sql`EXCLUDED.category`,
          difficulty:       sql`EXCLUDED.difficulty`,
          unlockType:       sql`EXCLUDED.unlock_type`,
          targetValue:      sql`EXCLUDED.target_value`,
          leaderboardScope: sql`EXCLUDED.leaderboard_scope`,
          timePeriod:       sql`EXCLUDED.time_period`,
          icon:             sql`EXCLUDED.icon`,
          badgeColor:       sql`EXCLUDED.badge_color`,
          sortOrder:        sql`EXCLUDED.sort_order`,
          isActive:         sql`TRUE`,
          updatedAt:        sql`now()`,
        },
      });
    process.stdout.write(".");
  }

  console.log(`\n✓ Upserted ${DEFINITIONS.length} definitions.`);

  // Also upsert EXTRA_DEFS — codes present in TitleBadge BADGE_MAP that need active DB entries
  for (const def of EXTRA_DEFS) {
    await db
      .insert(achievementDefinitionsTable)
      .values({
        code:             def.code,
        title:            def.title,
        description:      def.description,
        category:         def.category,
        difficulty:       def.difficulty,
        unlockType:       def.unlockType,
        targetValue:      def.targetValue ?? null,
        leaderboardScope: def.leaderboardScope ?? null,
        timePeriod:       def.timePeriod ?? null,
        icon:             def.icon ?? null,
        badgeColor:       def.badgeColor ?? null,
        xpReward:         0,
        sortOrder:        def.sortOrder,
        isActive:         true,
      })
      .onConflictDoUpdate({
        target: achievementDefinitionsTable.code,
        set: {
          title:            sql`EXCLUDED.title`,
          description:      sql`EXCLUDED.description`,
          category:         sql`EXCLUDED.category`,
          difficulty:       sql`EXCLUDED.difficulty`,
          unlockType:       sql`EXCLUDED.unlock_type`,
          targetValue:      sql`EXCLUDED.target_value`,
          leaderboardScope: sql`EXCLUDED.leaderboard_scope`,
          timePeriod:       sql`EXCLUDED.time_period`,
          icon:             sql`EXCLUDED.icon`,
          badgeColor:       sql`EXCLUDED.badge_color`,
          sortOrder:        sql`EXCLUDED.sort_order`,
          isActive:         sql`TRUE`,
          updatedAt:        sql`now()`,
        },
      });
    process.stdout.write(".");
  }
  console.log(`\n✓ Upserted ${EXTRA_DEFS.length} extra definitions.`);

  console.log("\n✅ Done. Total active titles:", DEFINITIONS.length + EXTRA_DEFS.length);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
