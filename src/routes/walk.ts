import { Router } from "express";
import { db } from "../../db/src/index.js";
import {
  stepDailyTotalsTable, stepDailyDeviceTotalsTable, stepSessionsTable, profilesTable, userPresenceTable, userPreferencesTable,
  walkingGroupMembersTable, walkingGroupDailyStepsTable, walkingGroupsTable,
} from "../../db/src/schema/index.js";
import { eq, and, sql, desc, gte, lte, asc, count, inArray } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import { z } from "zod";
import { evaluateStepMilestones } from "../lib/coinsService.js";
import { evaluateAndNotify } from "./achievementHooks.js";
import { notifyFriendsOnDailyGoal } from "../lib/friendActivityService.js";
import { notifyGroupsOnDailyGoalCompletion } from "../lib/pushNotificationService.js";
import { getChallengeCardsForUser, getRoomCountsSummary } from "./races.js";
import { getSponsoredEventsForUser } from "./sponsoredEvents.js";
import { getTrackThemeSummaryForUser } from "./trackThemes.js";
import { localDateInTimeZone, validateRecentLocalDate } from "../lib/localDate.js";
import {
  normalizeSource,
  isVerifiedDailySource,
  isProvisionalLiveSource,
  isRejectedForDailyTotals,
  classifyDailySource,
} from "../lib/stepSources.js";
import { triggerEvent } from "../lib/pusher.js";

const router = Router();

const DAILY_GOAL = 10000;
const IANA_TZ_REGEX = /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/;
const ROLLOVER_REPLACE_HOURS = 6;

function isRecognizedTimeZone(timezone: string): boolean {
  if (!IANA_TZ_REGEX.test(timezone)) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function localHourInTimeZone(timezone: string, now: Date): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    return Number.isFinite(hour) ? hour % 24 : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

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

async function buildWalkTodayPayload(userId: string, today: string) {
  const [[row], [profile], goalData] = await Promise.all([
    db
      .select()
      .from(stepDailyTotalsTable)
      .where(and(eq(stepDailyTotalsTable.userId, userId), eq(stepDailyTotalsTable.date, today)))
      .limit(1),
    db
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
      .limit(1),
    getUserGoalAndUnit(userId),
  ]);

  const steps = row?.steps ?? 0;
  const goal = goalData.goal;

  // Guard against stale/tiny stored distances (e.g. 6 m for 330 steps).
  const expectedDist = Math.round(steps * 0.762);
  const storedDist = row?.distanceMeters ?? 0;
  const distanceMeters = storedDist > 0
    && storedDist >= expectedDist * 0.1
    && storedDist < expectedDist * 100
    ? storedDist
    : expectedDist;

  const calories = row?.caloriesBurned ?? Math.round(steps * 0.04);
  const activeMinutes = row?.activeMinutes && row.activeMinutes > 0
    ? Math.max(row.activeMinutes, Math.ceil(steps / 120))
    : Math.ceil(steps / 120);

  const [rankRow] = await db
    .select({ countAbove: sql<number>`COUNT(*)::int` })
    .from(stepDailyTotalsTable)
    .where(and(
      eq(stepDailyTotalsTable.date, today),
      sql`${stepDailyTotalsTable.steps} > ${steps}`,
    ));
  const dailyRank = steps > 0 ? (rankRow?.countAbove ?? 0) + 1 : null;

  return {
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
  };
}

// ── GET /api/walk/bootstrap ──────────────────────────────────────────────────
// Aggregated Walk-screen read: today/rank, challenge cards, room counts,
// sponsored card, and theme summary in one authenticated request.
router.get("/walk/bootstrap", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const today = localDateStr(req.query.localDate);

  const [walk, challenges, roomCounts, sponsored, themeSummary] = await Promise.all([
    buildWalkTodayPayload(userId, today),
    getChallengeCardsForUser(userId),
    getRoomCountsSummary(),
    getSponsoredEventsForUser(userId, "card", { includeCoinBalance: false }),
    getTrackThemeSummaryForUser(userId),
  ]);

  return res.json({
    success: true,
    ...walk,
    challenges,
    roomCounts,
    sponsoredEvent: "card" in sponsored ? sponsored.card : null,
    sponsoredCoinBalance: themeSummary.coinBalance,
    themeSummary: {
      coinBalance: themeSummary.coinBalance,
      selectedThemeCode: themeSummary.selectedThemeCode,
      defaultThemeCode: themeSummary.defaultThemeCode,
      ownedCount: themeSummary.ownedCount,
      totalCount: themeSummary.totalCount,
      equippedTheme: themeSummary.equippedTheme,
    },
  });
});

// ── GET /api/walk/today ───────────────────────────────────────────────────────
// Returns today's step total, goal progress, distance, calories, and profile summary.
router.get("/walk/today", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const today = localDateStr(req.query.localDate);

  return res.json(await buildWalkTodayPayload(userId, today));
});

// ── POST /api/walk/steps ──────────────────────────────────────────────────────
// Submit a completed walk session.
//
// Source handling (§5 verified-daily separation): the raw `source` string is normalized via the
// central step-source contract. Verified health sources (health_connect/healthkit, plus their
// legacy aliases ios_healthkit/android_health_connect) mark the session/day as verified.
// Provisional sensor sources (android_step_counter/ios_pedometer) are IGNORED here — they must
// use POST /api/unlimited-challenges/:id/live-progress (Unlimited) or classic race progress.
// Clearly-fake sources are safely ignored (200 no-op), never a hard error that would break sync.
const submitStepsSchema = z.object({
  steps: z.number().int().min(1).max(200000),
  // Absolute daily total from Health app — used for GREATEST upsert so restarts never double-count.
  // When present, the daily total is set to max(existing, totalSteps) instead of += steps.
  totalSteps: z.number().int().min(0).max(200000).optional(),
  distanceMeters: z.number().int().min(0).optional(),
  caloriesBurned: z.number().int().min(0).optional(),
  durationSeconds: z.number().int().min(0).optional(),
  activeMinutes: z.number().int().min(0).optional(),
  /** Step data source (canonical or legacy). Classified by the step-source contract, not an enum. */
  source: z.string().max(50).optional(),
  /** Client's local calendar date (YYYY-M-D). Avoids UTC midnight boundary issues. */
  localDate: z.string().regex(/^\d{4}-\d{1,2}-\d{1,2}$/).optional(),
  /** Device IANA timezone used to key Health Connect / HealthKit daily totals. */
  timezone: z.string().trim().max(64).optional(),
  /** Opt-in cheaper response when absolute total has not increased. */
  shortUnchanged: z.boolean().optional(),
});

/** Combine a day's existing source_class with a newly-submitted session's class. */
function combineDaySourceClass(
  prev: string | null | undefined,
  incoming: "verified" | "unverified",
): "verified" | "mixed" | "unverified" {
  if (!prev) return incoming;
  if (prev === "mixed") return "mixed";
  return prev === incoming ? (prev as "verified" | "unverified") : "mixed";
}

router.post("/walk/steps", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  // Informational only (never trusted for auth) — lets us attribute today's steps
  // per physical device so a second device's real walking is additive, not dropped
  // by a same-account GREATEST comparison against a bigger first device.
  const deviceId = (req as AuthenticatedRequest).deviceInfo?.deviceId || null;
  const parsed = submitStepsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid step data", details: parsed.error.issues });
  }

  const { steps, durationSeconds = 0, source: rawSource } = parsed.data;
  const receivedAt = new Date();
  const [existingPrefs] = await db
    .select({ timezone: userPreferencesTable.timezone })
    .from(userPreferencesTable)
    .where(eq(userPreferencesTable.userId, userId))
    .limit(1);

  const submittedTimezone = parsed.data.timezone?.trim();
  if (submittedTimezone && !isRecognizedTimeZone(submittedTimezone)) {
    return res.status(400).json({ error: "Invalid timezone.", code: "invalid_timezone" });
  }
  // True only when the zone is the user's real one. When both are absent we fall back to UTC,
  // which is a GUESS — and for any positive-offset user it is a whole day behind their local
  // date during their evening/night.
  const hasTrustedTimezone = !!(submittedTimezone || existingPrefs?.timezone);
  const effectiveTimezone = submittedTimezone || existingPrefs?.timezone || "UTC";
  if (submittedTimezone && submittedTimezone !== existingPrefs?.timezone) {
    await db
      .insert(userPreferencesTable)
      .values({ userId, timezone: submittedTimezone, updatedAt: receivedAt })
      .onConflictDoUpdate({
        target: [userPreferencesTable.userId],
        set: { timezone: submittedTimezone, updatedAt: receivedAt },
      });
  }

  const localToday = localDateInTimeZone(effectiveTimezone, receivedAt);
  const dv = validateRecentLocalDate(parsed.data.localDate ?? localToday, {
    pastDays: 1,
    // With the user's real zone, localToday IS their today, so a future date is impossible and
    // futureDays: 0 is right. On the UTC guess it is not: a client in any positive offset sends
    // a localDate one day AHEAD of the UTC date every evening/night, and futureDays: 0 would
    // 400 it — silently stopping step sync for that user until their local morning. Keep the
    // previous ±1 tolerance exactly where the timezone is unknown.
    futureDays: hasTrustedTimezone ? 0 : 1,
    today: localToday,
  });
  if (!dv.ok) {
    return res.status(400).json({ error: "Step date is out of the allowed range.", code: dv.code });
  }
  const today = dv.normalized;

  // Normalize + classify the source. Clearly-fake sources are safely ignored (no write),
  // so a mock/random provider can never poison verified daily state, and the client's
  // periodic sync loop is not broken by a 4xx.
  const source = normalizeSource(rawSource);
  if (isRejectedForDailyTotals(source)) {
    const [existing] = await db
      .select({ steps: stepDailyTotalsTable.steps })
      .from(stepDailyTotalsTable)
      .where(and(eq(stepDailyTotalsTable.userId, userId), eq(stepDailyTotalsTable.date, today)))
      .limit(1);
    return res.json({
      submitted: 0,
      ignored: true,
      reason: isProvisionalLiveSource(source) ? "provisional_not_verified" : "rejected_source",
      today: { steps: existing?.steps ?? 0 },
    });
  }
  const sessionVerified = isVerifiedDailySource(source);
  const incomingDayClass = classifyDailySource(source);

  // Read previous step total BEFORE the upsert — needed for goal-crossing detection.
  // If the row does not yet exist for today, previousSteps = 0.
  const [prevStepRow] = await db
    .select({
      steps: stepDailyTotalsTable.steps,
      distanceMeters: stepDailyTotalsTable.distanceMeters,
      caloriesBurned: stepDailyTotalsTable.caloriesBurned,
      activeMinutes: stepDailyTotalsTable.activeMinutes,
      sourceClass: stepDailyTotalsTable.sourceClass,
    })
    .from(stepDailyTotalsTable)
    .where(and(eq(stepDailyTotalsTable.userId, userId), eq(stepDailyTotalsTable.date, today)))
    .limit(1);
  const previousSteps = prevStepRow?.steps ?? 0;
  const nextDaySourceClass = combineDaySourceClass(prevStepRow?.sourceClass, incomingDayClass);

  // `totalSteps` is the absolute HealthKit/Health Connect total for the submitted local day.
  // Mid-day we keep the row monotonic with GREATEST; during the first hours after local midnight,
  // a lower verified total is the new day's true value and can replace a stale leftover row.
  const usingAbsolute = typeof parsed.data.totalSteps === "number";
  const totalSteps = parsed.data.totalSteps ?? steps; // absolute total, or delta as fallback
  const allowRolloverReplace =
    usingAbsolute
    && sessionVerified
    && today === localToday
    && totalSteps < previousSteps
    && localHourInTimeZone(effectiveTimezone, receivedAt) < ROLLOVER_REPLACE_HOURS;

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

  // Multi-device same-account merge: only kicks in for verified absolute totals
  // with a known device id. Each device's own reading is tracked separately
  // (GREATEST per device — a single device restarting/resyncing never double-
  // counts itself), then the account's daily total is the SUM across devices,
  // floored by whatever the row already had (never regresses pre-migration data).
  const useDeviceMerge = usingAbsolute && !!deviceId && sessionVerified;

  // shortUnchanged must compare against THIS device's prior contribution when
  // multi-device merge is active — otherwise a smaller second-device reading
  // (e.g. 64) is incorrectly treated as unchanged vs the account sum (e.g. 85).
  let absoluteMetricsUnchanged = false;
  if (usingAbsolute && parsed.data.shortUnchanged === true) {
    if (useDeviceMerge) {
      const [prevDeviceRow] = await db
        .select({
          steps: stepDailyDeviceTotalsTable.steps,
          distanceMeters: stepDailyDeviceTotalsTable.distanceMeters,
          caloriesBurned: stepDailyDeviceTotalsTable.caloriesBurned,
          activeMinutes: stepDailyDeviceTotalsTable.activeMinutes,
        })
        .from(stepDailyDeviceTotalsTable)
        .where(
          and(
            eq(stepDailyDeviceTotalsTable.userId, userId),
            eq(stepDailyDeviceTotalsTable.date, today),
            eq(stepDailyDeviceTotalsTable.deviceId, deviceId!),
          ),
        )
        .limit(1);
      absoluteMetricsUnchanged = !allowRolloverReplace
        && !!prevDeviceRow
        && totalSteps <= prevDeviceRow.steps
        && totalDistMeters <= prevDeviceRow.distanceMeters
        && totalCals <= prevDeviceRow.caloriesBurned
        && activeMinutes <= prevDeviceRow.activeMinutes;
    } else {
      absoluteMetricsUnchanged = !allowRolloverReplace
        && !!prevStepRow
        && totalSteps <= previousSteps
        && totalDistMeters <= prevStepRow.distanceMeters
        && totalCals <= prevStepRow.caloriesBurned
        && activeMinutes <= prevStepRow.activeMinutes;
    }
  }

  if (parsed.data.shortUnchanged === true && usingAbsolute && absoluteMetricsUnchanged) {
    return res.json({
      submitted: 0,
      unchanged: true,
      today: { steps: previousSteps },
    });
  }

  // Delta values for the session log (always the session delta regardless of absolute mode)
  const deltaDistMeters = parsed.data.distanceMeters ?? Math.round(steps * 0.762);
  const deltaCals = parsed.data.caloriesBurned ?? Math.round(steps * 0.04);

  await db.transaction(async (tx) => {
    if (useDeviceMerge) {
      await tx
        .insert(stepDailyDeviceTotalsTable)
        .values({
          userId,
          date: today,
          deviceId: deviceId!,
          steps: totalSteps,
          distanceMeters: totalDistMeters,
          caloriesBurned: totalCals,
          activeMinutes,
          sourceClass: incomingDayClass,
        })
        .onConflictDoUpdate({
          target: [
            stepDailyDeviceTotalsTable.userId,
            stepDailyDeviceTotalsTable.date,
            stepDailyDeviceTotalsTable.deviceId,
          ],
          set: {
            steps: allowRolloverReplace
              ? totalSteps
              : sql`GREATEST(${stepDailyDeviceTotalsTable.steps}, ${totalSteps})`,
            distanceMeters: allowRolloverReplace
              ? totalDistMeters
              : sql`GREATEST(${stepDailyDeviceTotalsTable.distanceMeters}, ${totalDistMeters})`,
            caloriesBurned: allowRolloverReplace
              ? totalCals
              : sql`GREATEST(${stepDailyDeviceTotalsTable.caloriesBurned}, ${totalCals})`,
            activeMinutes: allowRolloverReplace
              ? activeMinutes
              : sql`GREATEST(${stepDailyDeviceTotalsTable.activeMinutes}, ${activeMinutes})`,
            sourceClass: incomingDayClass,
            updatedAt: new Date(),
          },
        });
    }

    // Upsert daily total. Absolute Health totals are monotonic during the day, but around a user's
    // local midnight the new "today" total can legitimately be lower than a stale leftover value.
    // In that first local rollover window we replace the row for localToday instead of preserving
    // yesterday's higher value with GREATEST.
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
        sourceClass: nextDaySourceClass,
      })
      .onConflictDoUpdate({
        target: [stepDailyTotalsTable.userId, stepDailyTotalsTable.date],
        set: useDeviceMerge
          ? allowRolloverReplace
            ? {
                steps: sql`(
                  SELECT COALESCE(SUM(steps), 0) FROM step_daily_device_totals
                  WHERE user_id = ${userId} AND date = ${today}
                )`,
                distanceMeters: sql`(
                  SELECT COALESCE(SUM(distance_meters), 0) FROM step_daily_device_totals
                  WHERE user_id = ${userId} AND date = ${today}
                )`,
                caloriesBurned: sql`(
                  SELECT COALESCE(SUM(calories_burned), 0) FROM step_daily_device_totals
                  WHERE user_id = ${userId} AND date = ${today}
                )`,
                activeMinutes,
                sourceClass: incomingDayClass,
                updatedAt: new Date(),
              }
            : {
              // Multi-device: the account total is the SUM of each device's own
              // (GREATEST-protected) reading — computed inside this transaction so
              // concurrent syncs from two devices can't clobber each other. Floored
              // by the existing row so pre-migration single-device totals never drop.
              steps: sql`GREATEST(${stepDailyTotalsTable.steps}, (
                SELECT COALESCE(SUM(steps), 0) FROM step_daily_device_totals
                WHERE user_id = ${userId} AND date = ${today}
              ))`,
              distanceMeters: sql`GREATEST(${stepDailyTotalsTable.distanceMeters}, (
                SELECT COALESCE(SUM(distance_meters), 0) FROM step_daily_device_totals
                WHERE user_id = ${userId} AND date = ${today}
              ))`,
              caloriesBurned: sql`GREATEST(${stepDailyTotalsTable.caloriesBurned}, (
                SELECT COALESCE(SUM(calories_burned), 0) FROM step_daily_device_totals
                WHERE user_id = ${userId} AND date = ${today}
              ))`,
              activeMinutes: sql`GREATEST(${stepDailyTotalsTable.activeMinutes}, ${activeMinutes})`,
              sourceClass: nextDaySourceClass,
              updatedAt: new Date(),
            }
          : usingAbsolute
          ? allowRolloverReplace
            ? {
                // Absolute rollover mode: lower verified Health total is the new local day, not a
                // regression. Replace the row so yesterday's leftover does not become today's steps.
                steps: totalSteps,
                distanceMeters: totalDistMeters,
                caloriesBurned: totalCals,
                activeMinutes,
                sourceClass: incomingDayClass,
                updatedAt: new Date(),
              }
            : {
              // Absolute mode: GREATEST so daily steps are monotonically increasing.
              // If Android/iOS sends a stale lower total (e.g. subscription restart, race
              // flow resumption, or background sync race), the row is never downgraded.
              steps: sql`GREATEST(${stepDailyTotalsTable.steps}, ${totalSteps})`,
              distanceMeters: sql`GREATEST(${stepDailyTotalsTable.distanceMeters}, ${totalDistMeters})`,
              caloriesBurned: sql`GREATEST(${stepDailyTotalsTable.caloriesBurned}, ${totalCals})`,
              activeMinutes: sql`GREATEST(${stepDailyTotalsTable.activeMinutes}, ${activeMinutes})`,
              // A provisional submission can only ever ADD unverified-ness (→ "mixed"), never
              // upgrade a mixed/unverified day back to verified.
              sourceClass: nextDaySourceClass,
              updatedAt: new Date(),
            }
          : {
              // Delta mode (fallback): additive, same as before.
              steps: sql`${stepDailyTotalsTable.steps} + ${steps}`,
              distanceMeters: sql`${stepDailyTotalsTable.distanceMeters} + ${totalDistMeters}`,
              caloriesBurned: sql`${stepDailyTotalsTable.caloriesBurned} + ${totalCals}`,
              activeMinutes: sql`GREATEST(${stepDailyTotalsTable.activeMinutes}, ${activeMinutes})`,
              sourceClass: nextDaySourceClass,
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
      isVerifiedSource: sessionVerified,
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
          .select({
            steps: stepDailyTotalsTable.steps,
            distanceMeters: stepDailyTotalsTable.distanceMeters,
            caloriesBurned: stepDailyTotalsTable.caloriesBurned,
            sourceClass: stepDailyTotalsTable.sourceClass,
          })
          .from(stepDailyTotalsTable)
          .where(and(eq(stepDailyTotalsTable.userId, userId), eq(stepDailyTotalsTable.date, today)))
          .limit(1);
        if (!committed) return;
        const verifiedSteps = committed.sourceClass === "verified" ? committed.steps : 0;
        const syncNow = new Date();
        for (const g of activeGroups) {
          await db.insert(walkingGroupDailyStepsTable)
            .values({
              groupId: g.id, userId, stepDate: today,
              dailySteps: committed.steps, verifiedSteps,
              calories: committed.caloriesBurned?.toString() ?? null,
              distanceMeters: committed.distanceMeters?.toString() ?? null,
              lastSyncedAt: syncNow,
            })
            .onConflictDoUpdate({
              target: [walkingGroupDailyStepsTable.groupId, walkingGroupDailyStepsTable.userId, walkingGroupDailyStepsTable.stepDate],
              set: {
                dailySteps: allowRolloverReplace
                  ? committed.steps
                  : sql`GREATEST(${walkingGroupDailyStepsTable.dailySteps}, ${committed.steps})`,
                verifiedSteps: allowRolloverReplace
                  ? verifiedSteps
                  : sql`GREATEST(${walkingGroupDailyStepsTable.verifiedSteps}, ${verifiedSteps})`,
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

  // Credit this verified total to the participant's OWN Unlimited challenge day, resolved from
  // their locked-timezone window rather than the device's calendar date. The day row is the
  // qualification authority, so a traveller's steps can never be scored against the wrong window.
  //
  // AWAITED, unlike the broadcast below: the response reports exactly which challenge days were
  // credited and which were skipped, so the client can explain "your steps aren't counting yet"
  // instead of silently showing a stalled goal. A failure here still never fails step sync.
  let unlimitedCredits: import("../lib/unlimitedStepIngest.js").UnlimitedDayCredit[] = [];
  if (sessionVerified) {
    try {
      const { applyVerifiedStepsToUnlimitedDays } = await import("../lib/unlimitedStepIngest.js");
      unlimitedCredits = await applyVerifiedStepsToUnlimitedDays({
        userId,
        verifiedTotal: updatedForCoins?.steps ?? 0,
        deviceLocalDate: today,
      });
    } catch (err) {
      req.log.error({ err, userId }, "[Unlimited] challenge-day credit failed");
    }
  }

  // Broadcast, fire-and-forget. Runs after the credit above has already committed, so the event
  // carries the value that was just written.
  (async () => {
    // Broadcast live progress to any active Unlimited challenge day whose locked window contains
    // now (authoritative). Do not require client localDate === day.localDate. This is what makes
    // a VERIFIED total appear on other viewers' boards immediately instead of on their next poll —
    // the provisional sensor endpoint is not the only source of progress_updated.
    try {
      const { findActiveUnlimitedDaysForUser } = await import("../lib/unlimitedLiveProgress.js");
      const emitNow = new Date();
      const activeDays = await findActiveUnlimitedDaysForUser(userId, emitNow);
      if (!activeDays.length) return;

      const dayDates = [...new Set(activeDays.map((d) => d.localDate))];
      const dayStepRows =
        dayDates.length === 1 && dayDates[0] === today
          ? []
          : await db
              .select({
                date: stepDailyTotalsTable.date,
                steps: stepDailyTotalsTable.steps,
              })
              .from(stepDailyTotalsTable)
              .where(
                and(
                  eq(stepDailyTotalsTable.userId, userId),
                  inArray(stepDailyTotalsTable.date, dayDates),
                ),
              );
      const stepsByDate = new Map(dayStepRows.map((r) => [r.date, r.steps]));
      if (dayDates.includes(today)) {
        stepsByDate.set(today, updatedForCoins?.steps ?? stepsByDate.get(today) ?? 0);
      }

      const { emitUnlimitedRealtime } = await import("../lib/unlimitedRealtime.js");
      const updatedAt = emitNow.toISOString();
      for (const d of activeDays) {
        const currentSteps = stepsByDate.get(d.localDate) ?? (d.localDate === today ? (updatedForCoins?.steps ?? 0) : 0);
        const challengeTimezone = d.challengeTimezone || d.timezone;
        let provisionalTodaySteps = 0;
        try {
          const { getUnlimitedProvisionalLive, displayedFromLanes, progressSourceFromLanes } =
            await import("../lib/unlimitedProvisionalLive.js");
          const prov = await getUnlimitedProvisionalLive(d.challengeId, userId, d.localDate);
          provisionalTodaySteps = prov?.provisionalSteps ?? 0;
          const displayedLiveSteps = displayedFromLanes(currentSteps, provisionalTodaySteps);
          const progressSource = progressSourceFromLanes(currentSteps, provisionalTodaySteps);
          const payload = {
            challengeId: d.challengeId,
            userId,
            participantId: d.participantId,
            currentSteps: displayedLiveSteps,
            todaySteps: displayedLiveSteps,
            steps: displayedLiveSteps,
            displayedLiveSteps,
            verifiedTodaySteps: currentSteps,
            provisionalTodaySteps,
            progressSource,
            verificationStatus:
              provisionalTodaySteps > currentSteps
                ? "verification_delayed"
                : currentSteps > 0
                  ? "verified"
                  : "syncing",
            dayNumber: d.dayNumber,
            goalSteps: d.goalSteps,
            dailyGoalSteps: d.goalSteps,
            // Qualification / goalReached from verified only.
            goalReached: currentSteps >= d.goalSteps,
            challengeDayKey: d.localDate,
            localDate: d.localDate,
            timezone: d.timezone,
            challengeTimezone,
            // Day identity, so a peer client never assumes every participant is on the same local
            // challenge day. challengeDayIndex / participantLocalDate name what dayNumber and
            // localDate have always meant here: this participant's own day.
            challengeDayIndex: d.dayNumber,
            participantLocalDate: d.localDate,
            participantTimezone: d.timezone,
            dayStatus: d.dayStatus,
            qualificationStatus: d.qualificationStatus,
            // Display only — qualification still reads the full daily total above.
            raceStartBaselineSteps: d.startBaselineSteps,
            challengeDaySteps: Math.max(0, displayedLiveSteps - d.startBaselineSteps),
            updatedAt,
            receivedLocalDate: today,
          };
          if (process.env.NODE_ENV !== "production") {
            req.log.debug(
              {
                userId,
                challengeId: d.challengeId,
                challengeTimezone,
                receivedLocalDate: today,
                resolvedChallengeDayKey: d.localDate,
                verifiedTodaySteps: currentSteps,
                provisionalTodaySteps,
                displayedLiveSteps,
                emitAttempted: true,
              },
              "[Unlimited] walk progress emit",
            );
          }
          emitUnlimitedRealtime(d.challengeId, "progress_updated", payload, {
            event: "race:progress_updated",
            payload: {
              raceId: d.challengeId,
              ...payload,
            },
          });
          continue;
        } catch {
          /* fall through to verified-only payload */
        }
        const payload = {
          challengeId: d.challengeId,
          userId,
          participantId: d.participantId,
          currentSteps,
          todaySteps: currentSteps,
          steps: currentSteps,
          displayedLiveSteps: currentSteps,
          verifiedTodaySteps: currentSteps,
          provisionalTodaySteps: 0,
          progressSource: currentSteps > 0 ? "verified" : "unavailable",
          verificationStatus: currentSteps > 0 ? "verified" : "syncing",
          dayNumber: d.dayNumber,
          goalSteps: d.goalSteps,
          dailyGoalSteps: d.goalSteps,
          goalReached: currentSteps >= d.goalSteps,
          challengeDayKey: d.localDate,
          localDate: d.localDate,
          timezone: d.timezone,
          challengeTimezone,
          // Same per-participant day identity as the provisional payload above.
          challengeDayIndex: d.dayNumber,
          participantLocalDate: d.localDate,
          participantTimezone: d.timezone,
          dayStatus: d.dayStatus,
          qualificationStatus: d.qualificationStatus,
          raceStartBaselineSteps: d.startBaselineSteps,
          challengeDaySteps: Math.max(0, currentSteps - d.startBaselineSteps),
          updatedAt,
          receivedLocalDate: today,
        };
        emitUnlimitedRealtime(d.challengeId, "progress_updated", payload, {
          event: "race:progress_updated",
          payload: {
            raceId: d.challengeId,
            ...payload,
          },
        });
      }
    } catch (_) {}
  })();

  // Daily goal completion notification — fire-and-forget, never blocks step sync.
  // Triggered only when the user crosses the goal for the first time today.
  if (updatedForCoins) {
    (async () => {
      const currentSteps = updatedForCoins.steps ?? 0;
      const { goal: userGoal, timezone, notifyFriendsOnGoal } = await getUserGoalAndUnit(userId);

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

      notifyGroupsOnDailyGoalCompletion({
        completedUserId: userId,
        currentSteps,
        goalSteps: userGoal,
        localDate: today,
        timezone,
      }).catch(() => {});

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
    // What this submission did to the caller's Unlimited challenge day(s). Present on every
    // response (empty arrays when they are in no challenge) so the client never has to guess
    // whether steps are counting.
    unlimited: {
      // Only verified Health Connect / HealthKit totals may touch qualification state.
      verifiedSource: sessionVerified,
      deviceLocalDate: today,
      credited: unlimitedCredits
        .filter((c) => !c.timezoneDrift)
        .map((c) => ({
          challengeId: c.challengeId,
          dayNumber: c.dayNumber,
          challengeDayKey: c.localDate,
          participantLocalDate: c.localDate,
          participantTimezone: c.timezone,
          verifiedSteps: c.verifiedSteps,
          dailyGoalSteps: c.goalSteps,
          goalReached: c.goalReached,
          challengeDaySteps: c.challengeDaySteps,
          raceStartBaselineSteps: c.startBaselineSteps,
        })),
      // Steps were NOT applied to these days. The device's calendar day and the participant's
      // locked challenge day describe different 24h spans, so the incoming absolute total would
      // over- or under-credit a day that decides real money.
      skipped: unlimitedCredits
        .filter((c) => c.timezoneDrift)
        .map((c) => ({
          challengeId: c.challengeId,
          dayNumber: c.dayNumber,
          reason: "timezone_drift",
          code: "DEVICE_DAY_NOT_CHALLENGE_DAY",
          challengeDayKey: c.localDate,
          participantLocalDate: c.localDate,
          deviceLocalDate: today,
          lockedTimezone: c.timezone,
          verifiedSteps: c.verifiedSteps,
          message:
            `Your device is on ${today} but this challenge day is ${c.localDate} in ${c.timezone} `
            + "(the timezone locked when you joined). Steps will credit once the two line up.",
        })),
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
