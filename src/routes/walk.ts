import { Router } from "express";
import { db } from "@db";
import {
  stepDailyTotalsTable, stepSessionsTable, profilesTable, userPresenceTable, userPreferencesTable,
  walkingGroupMembersTable, walkingGroupDailyStepsTable, walkingGroupsTable,
} from "@db/schema";
import { eq, and, sql, desc, gte, lte, asc, count, inArray } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth";
import { z } from "zod";
import { evaluateStepMilestones } from "../lib/coinsService";
import { evaluateAndNotify } from "./achievementHooks";
import { notifyFriendsOnDailyGoal } from "../lib/friendActivityService";

const router = Router();

const DAILY_GOAL = 10000;

async function getUserGoalAndUnit(userId: string): Promise<{ goal: number; unit: string; timezone: string; notifyFriendsOnGoal: boolean }> {
  const [prefs] = await db
    .select({
      dailyStepGoal: userPreferencesTable.dailyStepGoal,
      distanceUnit: userPreferencesTable.distanceUnit,
      timezone: userPreferencesTable.timezone,
      notifyFriendsOnDailyGoal: userPreferencesTable.notifyFriendsOnDailyGoal,
    })
    .from(userPreferencesTable)
    .where(eq(userPreferencesTable.userId, userId))
    .limit(1);
  return {
    goal: prefs?.dailyStepGoal ?? DAILY_GOAL,
    unit: prefs?.distanceUnit ?? "km",
    timezone: prefs?.timezone ?? "UTC",
    notifyFriendsOnGoal: prefs?.notifyFriendsOnDailyGoal ?? true,
  };
}

function formatDistance(meters: number, unit: string): string {
  if (unit === "mi") {
    const miles = meters / 1609.344;
    return `${miles.toFixed(2)} mi`;
  }
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${meters} m`;
}

/**
 * Return a YYYY-MM-DD date string for "today".
 *
 * Prefers the client-supplied local date (`localDate` query/body param) so the
 * server uses the user's calendar day rather than the server's UTC date.
 * Falls back to UTC only when no valid value is provided.
 *
 * Accepted format: "YYYY-M-D" or "YYYY-MM-DD" (getTodayKey() on the client
 * returns "YYYY-M-D" with un-padded month/day — that is fine).
 */
function localDateStr(raw: unknown): string {
  if (typeof raw === "string" && /^\d{4}-\d{1,2}-\d{1,2}$/.test(raw)) {
    const [y, m, d] = raw.split("-");
    const padded = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    // Verify it is a real calendar date
    const dt = new Date(padded + "T00:00:00Z");
    if (!isNaN(dt.getTime())) return padded;
  }
  // Fallback: server UTC date
  return new Date().toISOString().split("T")[0];
}

// ── GET /api/walk/today ───────────────────────────────────────────────────────
// Returns today's step total, goal progress, distance, calories, and profile summary.
router.get("/walk/today", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const today = localDateStr(req.query.localDate);

  const [row] = await db
    .select()
    .from(stepDailyTotalsTable)
    .where(and(eq(stepDailyTotalsTable.userId, userId), eq(stepDailyTotalsTable.date, today)))
    .limit(1);

  const [profile] = await db
    .select({
      username: profilesTable.username,
      totalSteps: profilesTable.totalSteps,
      currentRank: profilesTable.currentRank,
      currentStreak: profilesTable.currentStreak,
      avatarColor: profilesTable.avatarColor,
      level: profilesTable.level,
      countryFlag: profilesTable.countryFlag,
    })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);

  const steps = row?.steps ?? 0;

  // Always use the user's saved preference goal so Walk tab and Walking History stay in sync.
  const { goal: userGoal } = await getUserGoalAndUnit(userId);
  const goal = userGoal;

  // Guard against stale/tiny stored distances (e.g. 6 m for 330 steps).
  // Require stored value to be at least 10% of step-derived estimate, and not absurdly large.
  const expectedDist = Math.round(steps * 0.762);
  const storedDist = row?.distanceMeters ?? 0;
  const distanceMeters = storedDist > 0
    && storedDist >= expectedDist * 0.1
    && storedDist < expectedDist * 100
    ? storedDist
    : expectedDist;

  const calories = row?.caloriesBurned ?? Math.round(steps * 0.04);

  // Active minutes: use stored value, or derive from steps as fallback.
  const activeMinutes = row?.activeMinutes && row.activeMinutes > 0
    ? Math.max(row.activeMinutes, Math.ceil(steps / 120))
    : Math.ceil(steps / 120);

  // Daily rank: count users with more steps today, +1 = my rank.
  const [rankRow] = await db
    .select({ countAbove: sql<number>`COUNT(*)::int` })
    .from(stepDailyTotalsTable)
    .where(and(
      eq(stepDailyTotalsTable.date, today),
      sql`${stepDailyTotalsTable.steps} > ${steps}`,
    ));
  const dailyRank = steps > 0 ? (rankRow?.countAbove ?? 0) + 1 : null;

  return res.json({
    today: {
      steps,
      goal,
      progress: Math.min(1, steps / goal),
      distanceKm: parseFloat((distanceMeters / 1000).toFixed(2)),
      calories,
      activeMinutes,
      dailyRank,
    },
    profile: profile ?? null,
  });
});

// ── POST /api/walk/steps ──────────────────────────────────────────────────────
// Submit a completed walk session.
const VALID_SOURCES = [
  "ios_healthkit",
  "android_health_connect",
  "android_step_counter",
] as const;
type StepSource = (typeof VALID_SOURCES)[number];

const submitStepsSchema = z.object({
  steps: z.number().int().min(1).max(200000),
  // Absolute daily total from Health app — used for GREATEST upsert so restarts never double-count.
  // When present, the daily total is set to max(existing, totalSteps) instead of += steps.
  totalSteps: z.number().int().min(0).max(200000).optional(),
  distanceMeters: z.number().int().min(0).optional(),
  caloriesBurned: z.number().int().min(0).optional(),
  durationSeconds: z.number().int().min(0).optional(),
  activeMinutes: z.number().int().min(0).optional(),
  /** Step data source — must be a known real source; fake/mock/random sources are rejected. */
  source: z
    .enum(VALID_SOURCES as unknown as [StepSource, ...StepSource[]])
    .optional(),
  /** Client's local calendar date (YYYY-M-D). Avoids UTC midnight boundary issues. */
  localDate: z.string().regex(/^\d{4}-\d{1,2}-\d{1,2}$/).optional(),
});

router.post("/walk/steps", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = submitStepsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid step data", details: parsed.error.issues });
  }

  const { steps, durationSeconds = 0, source } = parsed.data;
  const today = localDateStr(parsed.data.localDate);

  // Read previous step total BEFORE the upsert — needed for goal-crossing detection.
  // If the row does not yet exist for today, previousSteps = 0.
  const [prevStepRow] = await db
    .select({ steps: stepDailyTotalsTable.steps })
    .from(stepDailyTotalsTable)
    .where(and(eq(stepDailyTotalsTable.userId, userId), eq(stepDailyTotalsTable.date, today)))
    .limit(1);
  const previousSteps = prevStepRow?.steps ?? 0;

  // `totalSteps` is the absolute HealthKit/Health Connect total for today.
  // When present we use GREATEST(existing, totalSteps) so app restarts never
  // double-count already-synced steps. Fall back to additive delta when absent.
  const usingAbsolute = typeof parsed.data.totalSteps === "number";
  const totalSteps = parsed.data.totalSteps ?? steps; // absolute total, or delta as fallback

  // For distance/calories we derive from the absolute total when available so
  // these values also stay consistent with the authoritative step count.
  const totalDistMeters = usingAbsolute
    ? (parsed.data.distanceMeters ?? Math.round(totalSteps * 0.762))
    : (parsed.data.distanceMeters ?? Math.round(steps * 0.762));
  const totalCals = usingAbsolute
    ? (parsed.data.caloriesBurned ?? Math.round(totalSteps * 0.04))
    : (parsed.data.caloriesBurned ?? Math.round(steps * 0.04));
  // activeMinutes is always absolute (total today) — use GREATEST to only ever move up.
  const activeMinutes = parsed.data.activeMinutes ?? Math.ceil(totalSteps / 120);

  // Delta values for the session log (always the session delta regardless of absolute mode)
  const deltaDistMeters = parsed.data.distanceMeters ?? Math.round(steps * 0.762);
  const deltaCals = parsed.data.caloriesBurned ?? Math.round(steps * 0.04);

  await db.transaction(async (tx) => {
    // Upsert daily total — always use GREATEST so the row is monotonically increasing.
    // When the client sends an absolute total we set the row to max(existing, total).
    // When only a delta is sent (legacy/fallback) we add it to the existing value.
    await tx
      .insert(stepDailyTotalsTable)
      .values({
        userId,
        date: today,
        steps: totalSteps,
        distanceMeters: totalDistMeters,
        caloriesBurned: totalCals,
        activeMinutes,
        goal: DAILY_GOAL,
      })
      .onConflictDoUpdate({
        target: [stepDailyTotalsTable.userId, stepDailyTotalsTable.date],
        set: usingAbsolute
          ? {
              // Absolute mode: GREATEST so daily steps are monotonically increasing.
              // If Android/iOS sends a stale lower total (e.g. subscription restart, race
              // flow resumption, or background sync race), the row is never downgraded.
              steps: sql`GREATEST(${stepDailyTotalsTable.steps}, ${totalSteps})`,
              distanceMeters: sql`GREATEST(${stepDailyTotalsTable.distanceMeters}, ${totalDistMeters})`,
              caloriesBurned: sql`GREATEST(${stepDailyTotalsTable.caloriesBurned}, ${totalCals})`,
              activeMinutes: sql`GREATEST(${stepDailyTotalsTable.activeMinutes}, ${activeMinutes})`,
              updatedAt: new Date(),
            }
          : {
              // Delta mode (fallback): additive, same as before.
              steps: sql`${stepDailyTotalsTable.steps} + ${steps}`,
              distanceMeters: sql`${stepDailyTotalsTable.distanceMeters} + ${totalDistMeters}`,
              caloriesBurned: sql`${stepDailyTotalsTable.caloriesBurned} + ${totalCals}`,
              activeMinutes: sql`GREATEST(${stepDailyTotalsTable.activeMinutes}, ${activeMinutes})`,
              updatedAt: new Date(),
            },
      });

    // Log session — always records the delta for historical session analysis.
    await tx.insert(stepSessionsTable).values({
      userId,
      steps,
      distanceMeters: deltaDistMeters,
      caloriesBurned: deltaCals,
      durationSeconds,
      endedAt: new Date(),
      isSynced: true,
      source: source ?? null,
    });

    // Recompute lifetime total from daily totals — prevents double-counting across
    // multiple syncs of the same session (absolute-mode GREATEST keeps the row accurate).
    const [lifeRow] = await tx
      .select({ total: sql<number>`COALESCE(SUM(${stepDailyTotalsTable.steps}), 0)::int` })
      .from(stepDailyTotalsTable)
      .where(eq(stepDailyTotalsTable.userId, userId));
    const lifetimeTotal = lifeRow?.total ?? 0;

    await tx
      .update(profilesTable)
      .set({
        totalSteps: lifetimeTotal,
        updatedAt: new Date(),
      })
      .where(eq(profilesTable.id, userId));
  });

  // ── Streak calculation ── (fire-and-forget so step sync never fails on this)
  (async () => {
    try {
      const allDates = await db
        .select({ date: stepDailyTotalsTable.date })
        .from(stepDailyTotalsTable)
        .where(and(
          eq(stepDailyTotalsTable.userId, userId),
          sql`${stepDailyTotalsTable.steps} > 0`,
        ))
        .orderBy(desc(stepDailyTotalsTable.date));

      let streak = 0;
      let expected = today;
      for (const { date } of allDates) {
        if (date === expected) {
          streak++;
          const d = new Date(expected + "T00:00:00Z");
          d.setUTCDate(d.getUTCDate() - 1);
          expected = d.toISOString().slice(0, 10);
        } else {
          break;
        }
      }

      await db
        .update(profilesTable)
        .set({ currentStreak: streak, updatedAt: new Date() })
        .where(eq(profilesTable.id, userId));
    } catch (_) {}
  })();

  // Sync steps to all active walking groups — fire-and-forget
  (() => {
    const syncToGroups = async () => {
      try {
        const memberships = await db
          .select({ groupId: walkingGroupMembersTable.groupId })
          .from(walkingGroupMembersTable)
          .where(and(eq(walkingGroupMembersTable.userId, userId), eq(walkingGroupMembersTable.status, "active")));
        if (!memberships.length) return;
        const gIds = memberships.map((m) => m.groupId);
        const activeGroups = await db
          .select({ id: walkingGroupsTable.id })
          .from(walkingGroupsTable)
          .where(and(inArray(walkingGroupsTable.id, gIds), eq(walkingGroupsTable.status, "active")));
        if (!activeGroups.length) return;
        const [committed] = await db
          .select({ steps: stepDailyTotalsTable.steps, distanceMeters: stepDailyTotalsTable.distanceMeters, caloriesBurned: stepDailyTotalsTable.caloriesBurned })
          .from(stepDailyTotalsTable)
          .where(and(eq(stepDailyTotalsTable.userId, userId), eq(stepDailyTotalsTable.date, today)))
          .limit(1);
        if (!committed) return;
        const syncNow = new Date();
        for (const g of activeGroups) {
          await db.insert(walkingGroupDailyStepsTable)
            .values({
              groupId: g.id, userId, stepDate: today,
              dailySteps: committed.steps, verifiedSteps: committed.steps,
              calories: committed.caloriesBurned?.toString() ?? null,
              distanceMeters: committed.distanceMeters?.toString() ?? null,
              lastSyncedAt: syncNow,
            })
            .onConflictDoUpdate({
              target: [walkingGroupDailyStepsTable.groupId, walkingGroupDailyStepsTable.userId, walkingGroupDailyStepsTable.stepDate],
              set: {
                dailySteps: sql`GREATEST(${walkingGroupDailyStepsTable.dailySteps}, ${committed.steps})`,
                verifiedSteps: sql`GREATEST(${walkingGroupDailyStepsTable.verifiedSteps}, ${committed.steps})`,
                calories: committed.caloriesBurned?.toString() ?? null,
                distanceMeters: committed.distanceMeters?.toString() ?? null,
                lastSyncedAt: syncNow, updatedAt: syncNow,
              },
            });
        }
      } catch (_) {}
    };
    syncToGroups();
  })();

  // Update walking presence — fire-and-forget so step sync never fails due to presence
  const now = new Date();
  db.insert(userPresenceTable)
    .values({ userId, status: "walking", lastSeenAt: now, lastWalkActivityAt: now })
    .onConflictDoUpdate({
      target: [userPresenceTable.userId],
      set: { status: "walking", lastSeenAt: now, lastWalkActivityAt: now },
    })
    .catch(() => {});

  req.log.info({ userId, steps, source: source ?? "unknown" }, "steps submitted");

  // Evaluate step milestone coin awards — fire-and-forget so step sync never fails
  const [updatedForCoins] = await db
    .select({ steps: stepDailyTotalsTable.steps })
    .from(stepDailyTotalsTable)
    .where(and(eq(stepDailyTotalsTable.userId, userId), eq(stepDailyTotalsTable.date, today)))
    .limit(1);

  if (updatedForCoins) {
    evaluateStepMilestones(userId, updatedForCoins.steps ?? 0, today).catch(() => {});
  }

  // Evaluate achievement titles — fire-and-forget so step sync never fails on this
  evaluateAndNotify(userId).catch(() => {});

  // Daily goal completion notification — fire-and-forget, never blocks step sync.
  // Triggered only when the user crosses the goal for the first time today.
  if (updatedForCoins) {
    (async () => {
      const currentSteps = updatedForCoins.steps ?? 0;
      const { goal: userGoal, notifyFriendsOnGoal } = await getUserGoalAndUnit(userId);

      req.log.info(
        { userId, localDate: today, previousSteps, newSteps: currentSteps, goalSteps: userGoal },
        "[DailyGoalNotify] step sync checked",
      );

      const goalCrossed = previousSteps < userGoal && currentSteps >= userGoal;
      req.log.info({ userId, goalCrossed }, "[DailyGoalNotify] goal crossed");

      if (!goalCrossed) return;

      if (!notifyFriendsOnGoal) {
        req.log.info({ userId }, "[DailyGoalNotify] sender disabled goal notifications — skipping");
        return;
      }

      notifyFriendsOnDailyGoal(userId, currentSteps, userGoal, today).catch(() => {});
    })().catch(() => {});
  }

  // Return updated today total
  const [row] = await db
    .select()
    .from(stepDailyTotalsTable)
    .where(and(eq(stepDailyTotalsTable.userId, userId), eq(stepDailyTotalsTable.date, today)))
    .limit(1);

  const rowSteps = row?.steps ?? totalSteps;
  const storedDistSync = row?.distanceMeters ?? 0;
  const expectedDistSync = Math.round(rowSteps * 0.762);
  const finalDist = storedDistSync > 0
    && storedDistSync >= expectedDistSync * 0.1
    && storedDistSync < expectedDistSync * 100
    ? storedDistSync : expectedDistSync;
  const finalActiveMinutes = Math.max(row?.activeMinutes ?? 0, Math.ceil(rowSteps / 120));

  // Rank after sync
  const [syncRankRow] = await db
    .select({ countAbove: sql<number>`COUNT(*)::int` })
    .from(stepDailyTotalsTable)
    .where(and(
      eq(stepDailyTotalsTable.date, today),
      sql`${stepDailyTotalsTable.steps} > ${rowSteps}`,
    ));
  const syncDailyRank = rowSteps > 0 ? (syncRankRow?.countAbove ?? 0) + 1 : null;

  return res.json({
    submitted: steps,
    today: {
      steps: rowSteps,
      goal: (await getUserGoalAndUnit(userId)).goal,
      distanceKm: parseFloat((finalDist / 1000).toFixed(2)),
      calories: row?.caloriesBurned ?? totalCals,
      activeMinutes: finalActiveMinutes,
      dailyRank: syncDailyRank,
    },
  });
});

// ── GET /api/walk/history ─────────────────────────────────────────────────────
// Returns daily step history for a given range. Gaps (days with no DB row) are
// filled in with zero-step entries so the chart always covers the full range.
// Always returns the full year of data so the client chart can scroll back.
router.get("/walk/history", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const { goal: userGoal, unit: distanceUnit } = await getUserGoalAndUnit(userId);

  // Use the client's local calendar date as "today" to avoid UTC boundary issues.
  const todayStr = localDateStr(req.query.localDate);
  // Parse at UTC midnight so cursor arithmetic stays in UTC and date strings stay correct.
  const today = new Date(todayStr + "T00:00:00Z");

  // Optional date-range params let the client fetch a smaller window (7d, 30d)
  // instead of always loading 365 rows. Falls back to full year for backward compat.
  //   range=7d | 30d | 365d (default)
  //   startDate=YYYY-MM-DD (overrides range)
  //   endDate=YYYY-MM-DD   (overrides todayStr as the upper bound)
  const rangeParam   = typeof req.query.range     === "string" ? req.query.range     : null;
  const startDParam  = typeof req.query.startDate === "string" ? req.query.startDate : null;
  const endDParam    = typeof req.query.endDate   === "string" ? req.query.endDate   : null;

  const ISO_DATE_RE  = /^\d{4}-\d{2}-\d{2}$/;
  const endStr       = endDParam && ISO_DATE_RE.test(endDParam) ? endDParam : todayStr;

  let startStr: string;
  if (startDParam && ISO_DATE_RE.test(startDParam)) {
    startStr = startDParam;
  } else {
    const rangeDays = rangeParam === "7d" ? 7 : rangeParam === "30d" ? 30 : 365;
    const startDate = new Date(today);
    startDate.setUTCDate(today.getUTCDate() - (rangeDays - 1));
    startStr = startDate.toISOString().split("T")[0];
  }

  // Fetch all rows in range + profile for joined_at
  const [rows, profileRows] = await Promise.all([
    db
      .select()
      .from(stepDailyTotalsTable)
      .where(
        and(
          eq(stepDailyTotalsTable.userId, userId),
          gte(stepDailyTotalsTable.date, startStr),
          lte(stepDailyTotalsTable.date, endStr),
        ),
      )
      .orderBy(asc(stepDailyTotalsTable.date)),
    db
      .select({ createdAt: profilesTable.createdAt })
      .from(profilesTable)
      .where(eq(profilesTable.id, userId))
      .limit(1),
  ]);

  const joinedAt = profileRows[0]?.createdAt ?? null;

  const rowMap = new Map(rows.map((r) => [r.date as string, r]));

  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  type DayEntry = {
    date: string; dayLabel: string; dateLabel: string;
    steps: number; distanceMeters: number; distanceDisplay: string;
    caloriesBurned: number; activeMinutes: number;
    goalSteps: number; goalCompleted: boolean; progressPercent: number;
    status: "goal" | "above_50" | "below_50" | "rest";
  };

  const endDateObj = new Date(endStr + "T00:00:00Z");

  const days: DayEntry[] = [];
  const cursor = new Date(startStr + "T00:00:00Z");

  while (cursor <= endDateObj) {
    // Use UTC accessors: cursor is always at UTC midnight so UTC date == intended date.
    const dateStr = cursor.toISOString().split("T")[0];
    const row = rowMap.get(dateStr);
    const steps = row?.steps ?? 0;
    // Always use the user's current saved preference as the goal for all days.
    // This ensures the goal displayed everywhere matches whatever the user last set.
    const goal = userGoal;
    const expDist = Math.round(steps * 0.762);
    const rawDist = row?.distanceMeters ?? 0;
    const distanceMeters = rawDist > 0
      && rawDist >= expDist * 0.1
      && rawDist < expDist * 100
      ? rawDist : expDist;
    // Use stored calories only when > 0; otherwise derive from steps (DB default is 0, not null).
    const caloriesBurned = (row?.caloriesBurned && row.caloriesBurned > 0)
      ? row.caloriesBurned
      : Math.round(steps * 0.04);
    const activeMinutes = row?.activeMinutes && row.activeMinutes > 0
      ? Math.max(row.activeMinutes, Math.ceil(steps / 120))
      : Math.ceil(steps / 120);
    const goalCompleted = steps >= goal;
    const progressPercent = goal > 0 ? Math.min(100, Math.round((steps / goal) * 100)) : 0;
    const status: DayEntry["status"] = steps === 0
      ? "rest"
      : goalCompleted
        ? "goal"
        : progressPercent >= 50
          ? "above_50"
          : "below_50";

    days.push({
      date: dateStr,
      dayLabel: DAY_NAMES[cursor.getUTCDay()],
      dateLabel: `${MONTH_NAMES[cursor.getUTCMonth()]} ${cursor.getUTCDate()}`,
      steps,
      distanceMeters,
      distanceDisplay: formatDistance(distanceMeters, distanceUnit),
      caloriesBurned,
      activeMinutes,
      goalSteps: goal,
      goalCompleted,
      progressPercent,
      status,
    });

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const totalSteps = days.reduce((s, d) => s + d.steps, 0);
  const activeDays = days.filter((d) => d.steps > 0).length;
  const goalDays = days.filter((d) => d.goalCompleted).length;
  const bestDay = days.reduce(
    (best, d) => (d.steps > best.steps ? d : best),
    days[0] ?? { steps: 0, date: null as string | null },
  );
  const avgSteps = activeDays > 0 ? Math.round(totalSteps / activeDays) : 0;

  // Lifetime stats — all history ever for this user
  const lifetimeRows = await db
    .select()
    .from(stepDailyTotalsTable)
    .where(eq(stepDailyTotalsTable.userId, userId))
    .orderBy(desc(stepDailyTotalsTable.steps));

  const lifetimeTotalSteps = lifetimeRows.reduce((s, r) => s + (r.steps ?? 0), 0);
  const lifetimeActiveDays = lifetimeRows.filter((r) => (r.steps ?? 0) > 0).length;
  const lifetimeBestDay = lifetimeRows[0] ?? null;
  const lifetimeTotalCals = lifetimeRows.reduce((s, r) => {
    const cal = (r.caloriesBurned && r.caloriesBurned > 0)
      ? r.caloriesBurned
      : Math.round((r.steps ?? 0) * 0.04);
    return s + cal;
  }, 0);
  const lifetimeTotalMins = lifetimeRows.reduce((s, r) => s + (r.activeMinutes ?? 0), 0);
  const lifetimeTotalDist = lifetimeRows.reduce((s, r) => {
    const steps = r.steps ?? 0;
    const exp = Math.round(steps * 0.762);
    const raw = r.distanceMeters ?? 0;
    // Same sanity check as per-day: raw must be >= 10% of expected to be trusted.
    const dist = raw > 0 && raw >= exp * 0.1 && raw < exp * 100 ? raw : exp;
    return s + dist;
  }, 0);

  // Format joined_at label
  let joinedLabel: string | null = null;
  if (joinedAt) {
    const d = new Date(joinedAt);
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    joinedLabel = `Joined on ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  return res.json({
    range: "year",
    goalSteps: userGoal,
    distanceUnit,
    joinedAt,
    days,
    summary: {
      totalSteps,
      totalDistanceMeters: Math.round(totalSteps * 0.762),
      totalCalories: Math.round(totalSteps * 0.04),
      activeDays,
      goalDays,
      bestDaySteps: bestDay.steps,
      bestDayDate: (bestDay as DayEntry).date ?? null,
      avgSteps,
    },
    lifetime: {
      totalSteps: lifetimeTotalSteps,
      totalDistanceMeters: lifetimeTotalDist,
      distanceDisplay: formatDistance(lifetimeTotalDist, distanceUnit),
      caloriesBurned: lifetimeTotalCals,
      activeMinutes: lifetimeTotalMins,
      activeDays: lifetimeActiveDays,
      bestDaySteps: lifetimeBestDay?.steps ?? 0,
      joinedAt,
      joinedLabel,
    },
  });
});

export default router;
