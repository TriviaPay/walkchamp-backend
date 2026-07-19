import { Router, type RequestHandler } from "express";
import multer from "multer";
import { db } from "../../db/src/index.js";
import { profilesTable, walletsTable, achievementDefinitionsTable, userTitlesTable, friendsTable, friendRequestsTable } from "../../db/src/schema/index.js";
import { raceResultsTable } from "../../db/src/schema/index.js";
import { stepDailyTotalsTable, userStepSourcesTable } from "../../db/src/schema/index.js";
import { coinBalancesTable } from "../../db/src/schema/index.js";
import { raceParticipantsTable, raceRoomsTable } from "../../db/src/schema/index.js";
import { eq, and, or, desc, ne, gt, notInArray, sql } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import {
  deleteStoredObject,
  isObjectStorageConfigError,
  isObjectStorageConfigured,
  objectKeyFromUrl,
  objectUrl,
  putStoredObject,
} from "../lib/objectStorage.js";
import { proxyStoredObjectResponse } from "../lib/objectMediaProxy.js";
import { triggerEvent } from "../lib/pusher.js";
import { z } from "zod";
import { buildGeneratedObjectKey, validateRasterUpload } from "../lib/uploadPolicy.js";
import { sanitizePlainText } from "../lib/text.js";
import { config } from "../lib/config.js";
import { createRedisRateLimit, rateLimitByActorOrIp } from "../lib/rateLimit.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only images are allowed"));
  },
});

const router = Router();
const uploadLimiter: RequestHandler = config.features.rateLimitingEnabled
  ? createRedisRateLimit({
      bucket: "profile-avatar-upload",
      windowMs: 15 * 60 * 1000,
      max: 20,
      failureMode: "closed",
      message: "Too many upload attempts — please try again later.",
      code: "UPLOAD_RATE_LIMITED",
      key: rateLimitByActorOrIp,
      dimensions: ["actor", "ip", "device", "token"],
    })
  : (_req, _res, next) => next();

// ── Level system ──────────────────────────────────────────────────────────────
const LEVEL_THRESHOLDS = [
  { level: 1,  title: "New Walker",         xp: 0     },
  { level: 2,  title: "Street Starter",     xp: 100   },
  { level: 3,  title: "Rookie Walker",      xp: 250   },
  { level: 4,  title: "Daily Strider",      xp: 500   },
  { level: 5,  title: "Pace Builder",       xp: 900   },
  { level: 6,  title: "Fast Walker",        xp: 1400  },
  { level: 7,  title: "Race Challenger",    xp: 2000  },
  { level: 8,  title: "Step Warrior",       xp: 2800  },
  { level: 9,  title: "Endurance Walker",   xp: 3800  },
  { level: 10, title: "City Champion",      xp: 5000  },
  { level: 11, title: "Country Contender",  xp: 6500  },
  { level: 12, title: "Global Racer",       xp: 8500  },
  { level: 13, title: "Elite Strider",      xp: 11000 },
  { level: 14, title: "Marathon Mindset",   xp: 14000 },
  { level: 15, title: "Walk Legend",        xp: 18000 },
];

function computeLevelData(lifetimeXP: number) {
  let current = LEVEL_THRESHOLDS[0];
  for (const t of LEVEL_THRESHOLDS) {
    if (lifetimeXP >= t.xp) current = t;
    else break;
  }
  const next = LEVEL_THRESHOLDS.find((t) => t.xp > lifetimeXP);
  const currentLevelXP = lifetimeXP - current.xp;
  const nextLevelXP    = next ? next.xp - current.xp : 0;
  const progressPercent = nextLevelXP > 0
    ? Math.min(100, Math.floor((currentLevelXP / nextLevelXP) * 100))
    : 100;
  return { level: current.level, levelTitle: current.title, xp: lifetimeXP, currentLevelXP, nextLevelXP, progressPercent };
}

// XP from walking: 1 XP per 100 steps (matches existing display)
// XP from races: completes=10/20 (free/paid), win=+25, 2nd=+15, 3rd=+10
function computeXP(totalSteps: number, raceResults: { rank: number; prizeCents: number; eligibleForPrize?: boolean }[]) {
  const stepXP = Math.floor(totalSteps / 100);
  let raceXP = 0;
  for (const r of raceResults) {
    raceXP += r.prizeCents > 0 ? 20 : 10;
    if (isRaceWinResult(r)) raceXP += 25;
    else if (r.rank === 2) raceXP += 15;
    else if (r.rank === 3) raceXP += 10;
  }
  return stepXP + raceXP;
}

function isRaceWinResult(r: { rank: number | null | undefined; eligibleForPrize?: boolean }): boolean {
  return r.rank === 1 && r.eligibleForPrize !== false;
}

function isRacePodiumRank(rank: number | null | undefined): boolean {
  return typeof rank === "number" && rank >= 1 && rank <= 3;
}

// Compute consecutive-day streak from step_daily_totals rows (ordered by date desc).
// A streak is consecutive days ending on today or yesterday with steps > 0.
function computeStreak(rows: { date: string | Date; steps: number | null }[]): number {
  if (rows.length === 0) return 0;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  // Build a set of date strings (YYYY-MM-DD) that have steps > 0
  const activeDates = new Set<string>();
  for (const r of rows) {
    if ((r.steps ?? 0) > 0) {
      const d = typeof r.date === "string" ? r.date.slice(0, 10) : r.date.toISOString().slice(0, 10);
      activeDates.add(d);
    }
  }
  if (activeDates.size === 0) return 0;

  // Walk backwards from today; allow starting from yesterday if today has no steps
  const todayStr = today.toISOString().slice(0, 10);
  const yesterday = new Date(today);
  yesterday.setUTCDate(today.getUTCDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  let cursor: Date;
  if (activeDates.has(todayStr)) {
    cursor = today;
  } else if (activeDates.has(yesterdayStr)) {
    cursor = yesterday;
  } else {
    return 0; // Streak is broken — neither today nor yesterday was active
  }

  let streak = 0;
  while (true) {
    const key = cursor.toISOString().slice(0, 10);
    if (!activeDates.has(key)) break;
    streak++;
    cursor = new Date(cursor);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

const BLOCKED = new Set([
  "admin", "support", "official", "system", "moderator", "staff",
  "walkchamp", "walk_champ", "null", "undefined", "test",
]);
function isBlocked(username: string) {
  const l = username.toLowerCase().replace(/_/g, "");
  return BLOCKED.has(l) || l.includes("admin") || l.includes("walkchamp") || l.includes("official") || l.includes("support");
}

// ── GET /api/profile/me ───────────────────────────────────────────────────────
router.get("/profile/me", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const today  = new Date().toISOString().slice(0, 10);

  // Critical queries — if these fail, we return 404/500 as appropriate
  const [profiles, wallets] = await Promise.all([
    db.select().from(profilesTable).where(eq(profilesTable.id, userId)).limit(1),
    db.select().from(walletsTable).where(eq(walletsTable.userId, userId)).limit(1),
  ]);

  const p = profiles[0];
  if (!p) return res.status(404).json({ error: "Profile not found" });

  // Optional queries — each wrapped independently so one bad table never breaks the response
  const [
    todayResult,
    allRaceResult,
    activeTitleResult,
    streakResult,
    coinBalResult,
    challengeHistResult,
    stepSourceResult,
    rankCountResult,
  ] = await Promise.allSettled([
    db.select({ steps: stepDailyTotalsTable.steps })
      .from(stepDailyTotalsTable)
      .where(and(eq(stepDailyTotalsTable.userId, userId), eq(stepDailyTotalsTable.date, today)))
      .limit(1),
    // raceResultsTable is authoritative for stats: rank NOT NULL, prizeCents present
    db.select({
        rank: raceResultsTable.rank,
        prizeCents: raceResultsTable.prizeCents,
        eligibleForPrize: raceResultsTable.eligibleForPrize,
      })
      .from(raceResultsTable)
      .where(eq(raceResultsTable.userId, userId)),
    db.select({ achievementCode: userTitlesTable.achievementCode })
      .from(userTitlesTable)
      .where(and(eq(userTitlesTable.userId, userId), eq(userTitlesTable.isActive, true)))
      .limit(1),
    db.select({ date: stepDailyTotalsTable.date, steps: stepDailyTotalsTable.steps })
      .from(stepDailyTotalsTable)
      .where(eq(stepDailyTotalsTable.userId, userId))
      .orderBy(desc(stepDailyTotalsTable.date)),
    db.select({ lifetimeEarned: coinBalancesTable.lifetimeEarned })
      .from(coinBalancesTable)
      .where(eq(coinBalancesTable.userId, userId))
      .limit(1),
    db.select({
        roomId:            raceRoomsTable.id,
        title:             raceRoomsTable.title,
        type:              raceRoomsTable.type,
        entryType:         raceRoomsTable.entryType,
        targetSteps:       raceRoomsTable.targetSteps,
        completedAt:       raceRoomsTable.completedAt,
        participantStatus: raceParticipantsTable.status,
        rank:              raceParticipantsTable.rank,
        prizeAmountCents:  raceParticipantsTable.prizeAmountCents,
      })
      .from(raceParticipantsTable)
      .innerJoin(raceRoomsTable, eq(raceParticipantsTable.raceRoomId, raceRoomsTable.id))
      .where(and(eq(raceParticipantsTable.userId, userId), eq(raceRoomsTable.status, "completed")))
      .orderBy(desc(raceRoomsTable.completedAt))
      .limit(5),
    db.select()
      .from(userStepSourcesTable)
      .where(eq(userStepSourcesTable.userId, userId))
      .limit(1),
    // Count users with strictly more all-time steps → user's global rank
    db.select({ cnt: sql<number>`count(*)::int` })
      .from(profilesTable)
      .where(and(
        ne(profilesTable.id, userId),
        gt(profilesTable.totalSteps, p.totalSteps ?? 0),
        notInArray(profilesTable.accountStatus, ["banned", "deleted"]),
      )),
  ]);

  // Safely unwrap each settled result with a fallback
  const todayRows          = todayResult.status        === "fulfilled" ? todayResult.value        : [];
  const allRaceRows        = allRaceResult.status      === "fulfilled" ? allRaceResult.value      : [];
  const activeTitleRows    = activeTitleResult.status  === "fulfilled" ? activeTitleResult.value  : [];
  const streakRows         = streakResult.status       === "fulfilled" ? streakResult.value       : [];
  const coinBalRows        = coinBalResult.status      === "fulfilled" ? coinBalResult.value      : [];
  const challengeHistRows  = challengeHistResult.status === "fulfilled" ? challengeHistResult.value : [];
  const stepSourceRows     = stepSourceResult.status   === "fulfilled" ? stepSourceResult.value   : [];
  const rankCountRows      = rankCountResult.status    === "fulfilled" ? rankCountResult.value    : [];

  // Log any query failures for debugging without crashing
  [todayResult, allRaceResult, activeTitleResult, streakResult, coinBalResult, challengeHistResult, stepSourceResult, rankCountResult]
    .forEach((r, i) => { if (r.status === "rejected") req.log.warn({ i, err: String(r.reason) }, "profile query partial failure"); });

  const w              = wallets[0];
  const todaySteps     = todayRows[0]?.steps ?? 0;
  const liveStreak     = computeStreak(streakRows);
  const liveAllTime    = streakRows.reduce((sum, r) => sum + (r.steps ?? 0), 0);
  const lifetimeXP     = computeXP(liveAllTime, allRaceRows);
  const levelData      = computeLevelData(lifetimeXP);

  const totalRaces   = allRaceRows.length;
  const racesWon     = allRaceRows.filter(isRaceWinResult).length;
  const top3Finishes = allRaceRows.filter((r) => isRacePodiumRank(r.rank)).length;
  const winRate      = totalRaces > 0 ? Math.round((racesWon / totalRaces) * 100) : 0;

  db.update(profilesTable).set({ lastSeenAt: new Date() }).where(eq(profilesTable.id, userId)).catch(() => {});

  // Resolve active title definition (if any)
  let activeTitleData: { code: string; title: string; difficulty: string; icon: string | null } | null = null;
  const activeCode = activeTitleRows[0]?.achievementCode;
  if (activeCode) {
    try {
      const def = await db
        .select()
        .from(achievementDefinitionsTable)
        .where(eq(achievementDefinitionsTable.code, activeCode))
        .limit(1);
      if (def[0]) {
        activeTitleData = { code: def[0].code, title: def[0].title, difficulty: def[0].difficulty, icon: def[0].icon };
      }
    } catch { /* ignore — title display is non-critical */ }
  }

  return res.json({
    success: true,
    data: {
      profile: {
        id:                  p.id,
        fullName:            p.fullName,
        username:            p.username,
        email:               p.email,
        country:             p.country,
        countryCode:         p.countryCode,
        countryFlag:         p.countryFlag,
        avatarColor:         p.avatarColor,
        avatarUrl:           p.avatarUrl,
        avatarVersion:       p.updatedAt?.getTime() ?? 0,
        bio:                 p.bio,
        referralCode:        p.referralCode,
        profileCompleted:    p.profileCompleted,
        accountStatus:       p.accountStatus,
        paidRaceEnabled:     p.paidRaceEnabled,
        withdrawalsEnabled:  p.withdrawalsEnabled,
      },
      stats: {
        todaySteps,
        allTimeSteps:    liveAllTime,
        dayStreak:       liveStreak,
        dailyRank:       p.currentRank === 9999 ? null : p.currentRank,
        level:           levelData.level,
        levelTitle:      levelData.levelTitle,
        xp:              levelData.xp,
        currentLevelXP:  levelData.currentLevelXP,
        nextLevelXP:     levelData.nextLevelXP,
        progressPercent: levelData.progressPercent,
        totalRaces,
        racesWon,
        top3Finishes,
        winRate,
        coinsEarned:  coinBalRows[0]?.lifetimeEarned ?? 0,
        globalRank:   (rankCountRows[0]?.cnt ?? 0) + 1,
      },
      wallet: {
        availableBalance:    (w?.availableBalanceCents    ?? 0) / 100,
        pendingBalance:      (w?.pendingBalanceCents      ?? 0) / 100,
        withdrawableBalance: (w?.withdrawableBalanceCents ?? 0) / 100,
        totalEarned:         (w?.totalEarnedCents         ?? 0) / 100,
      },
      active_title: activeTitleData,
      achievements: [],
      challengeHistory: (() => {
        // Deduplicate by roomId — keep the first occurrence (already ordered by completedAt desc)
        const seen = new Set<string>();
        return challengeHistRows
          .filter(row => { if (seen.has(row.roomId)) return false; seen.add(row.roomId); return true; })
          .map(row => ({
            id:               row.roomId,
            title:            row.title,
            type:             row.type,
            entryType:        row.entryType,
            targetSteps:      row.targetSteps,
            participantStatus: row.participantStatus,
            rank:             row.rank,
            prizeAmountCents: row.prizeAmountCents,
            completedAt:      row.completedAt?.toISOString() ?? null,
          }));
      })(),
      last7Days: streakRows.slice(0, 7).reverse().map(r => ({
        date: typeof r.date === "string" ? r.date.slice(0, 10) : (r.date as Date).toISOString().slice(0, 10),
        steps: r.steps ?? 0,
      })),
      stepSource: stepSourceRows[0] ? {
        platform:         stepSourceRows[0].platform,
        permissionStatus: stepSourceRows[0].permissionStatus,
        setupCompleted:   stepSourceRows[0].setupCompleted,
        lastSyncAt:       stepSourceRows[0].lastSyncAt?.toISOString() ?? null,
      } : null,
    },
  });
});

// ── PUT /api/profile/me ───────────────────────────────────────────────────────
const ALLOWED_AVATAR_COLORS = [
  "#00E676", "#00B4FF", "#06B6D4", "#FFD700",
  "#FF6B35", "#A855F7", "#F472B6", "#34D399",
];

const updateProfileSchema = z.object({
  fullName:    z.string().min(1).max(100).optional(),
  username:    z.string().min(6).max(14).regex(/^[a-zA-Z][a-zA-Z0-9_]{5,13}$/, "Username must be 6-14 characters, start with a letter, and contain only letters, numbers, or underscores.").optional(),
  country:     z.string().max(100).optional(),
  countryCode: z.string().max(10).optional(),
  countryFlag: z.string().max(10).optional(),
  bio:         z.string().max(300).optional(),
  avatarColor: z.string().refine((c) => ALLOWED_AVATAR_COLORS.includes(c), { message: "Invalid avatar color." }).optional(),
});

router.put("/profile/me", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const parse = updateProfileSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: parse.error.issues[0]?.message ?? "Invalid data" });
  }
  const updates = parse.data;

  if (updates.username) {
    const lower = updates.username.toLowerCase();
    if (isBlocked(lower)) {
      return res.status(409).json({ error: "This username is not allowed." });
    }
    const existing = await db
      .select({ id: profilesTable.id })
      .from(profilesTable)
      .where(eq(profilesTable.username, lower))
      .limit(1);
    if (existing.length > 0 && existing[0].id !== userId) {
      return res.status(409).json({ error: "This username is already taken." });
    }
    updates.username = lower;
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (updates.fullName    !== undefined) patch.fullName    = sanitizePlainText(updates.fullName);
  if (updates.username    !== undefined) patch.username    = updates.username;
  if (updates.country     !== undefined) patch.country     = sanitizePlainText(updates.country);
  if (updates.countryCode !== undefined) patch.countryCode = sanitizePlainText(updates.countryCode);
  if (updates.countryFlag !== undefined) patch.countryFlag = sanitizePlainText(updates.countryFlag);
  if (updates.bio         !== undefined) patch.bio         = sanitizePlainText(updates.bio);
  if (updates.avatarColor !== undefined) patch.avatarColor = updates.avatarColor;

  const [updated] = await db
    .update(profilesTable)
    .set(patch)
    .where(eq(profilesTable.id, userId))
    .returning();

  if (!updated) return res.status(404).json({ error: "Profile not found" });

  return res.json({
    success: true,
    profile: {
      id:          updated.id,
      fullName:    updated.fullName,
      username:    updated.username,
      country:     updated.country,
      countryCode: updated.countryCode,
      countryFlag: updated.countryFlag,
      bio:         updated.bio,
      avatarColor: updated.avatarColor,
    },
  });
});

// ── POST /api/profile/me/avatar ───────────────────────────────────────────────
router.post("/profile/me/avatar", requireAuth, uploadLimiter, upload.single("avatar"), async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const file   = req.file;
  if (!file) return res.status(400).json({ error: "No image provided" });
  if (!isObjectStorageConfigured()) return res.status(503).json({ error: "Avatar storage is not configured" });

  try {
    const contentType = validateRasterUpload(file);
    const [profile] = await db
      .select({ avatarUrl: profilesTable.avatarUrl })
      .from(profilesTable)
      .where(eq(profilesTable.id, userId))
      .limit(1);
    const oldKey = objectKeyFromUrl(profile?.avatarUrl);
    const objKey = buildGeneratedObjectKey("avatars", userId, contentType);

    if (oldKey) {
      await deleteStoredObject(oldKey).catch(() => {});
    }
    await putStoredObject(objKey, file.buffer, contentType, {
      cacheControl: "public, max-age=31536000, immutable",
    });

    const avatarUrl = objectUrl(objKey);
    const displayUrl = `/api/profile/avatar/${userId}`;

    req.log.info({ userId, avatarUrl, bucket: config.objectStorage.bucket }, "avatar uploaded to object storage");

    const now = new Date();
    await db
      .update(profilesTable)
      .set({ avatarUrl, updatedAt: now })
      .where(eq(profilesTable.id, userId));

    const avatarVersion = now.getTime();
    triggerEvent("public-presence", "avatar:updated", { userId, avatarVersion }).catch(() => {});

    return res.json({ success: true, avatarUrl, displayUrl, avatarVersion });
  } catch (err) {
    if (isObjectStorageConfigError(err)) {
      return res.status(503).json({ error: "Avatar storage is not configured" });
    }
    req.log.error(err, "avatar upload failed");
    return res.status(500).json({ error: "Upload failed" });
  }
});

// ── GET /api/profile/avatar/:userId ──────────────────────────────────────────
router.get("/profile/avatar/:userId", async (req, res) => {
  const userId = String(req.params.userId);
  if (!isObjectStorageConfigured()) return res.status(503).end();

  try {
    const [profile] = await db
      .select({ avatarUrl: profilesTable.avatarUrl })
      .from(profilesTable)
      .where(eq(profilesTable.id, userId))
      .limit(1);
    const objKey = objectKeyFromUrl(profile?.avatarUrl);
    if (!objKey) return res.status(404).end();

    await proxyStoredObjectResponse(req, res, {
      routeName: "profile-avatar",
      objectKey: objKey,
      maxBytes: config.runtime.uploadBodyLimitBytes,
      cacheControl: req.query.v
        ? "public, max-age=31536000, immutable"
        : "no-cache, must-revalidate",
    });
    return;
  } catch (err) {
    if (isObjectStorageConfigError(err)) {
      return res.status(503).end();
    }
    req.log.error(err, "avatar fetch failed");
    return res.status(500).end();
  }
});

// ── DELETE /api/profile/me/avatar ─────────────────────────────────────────────
router.delete("/profile/me/avatar", requireAuth, async (req, res) => {
  const userId   = (req as AuthenticatedRequest).descopeUserId;
  if (!isObjectStorageConfigured()) return res.status(503).json({ error: "Avatar storage is not configured" });
  const [profile] = await db
    .select({ avatarUrl: profilesTable.avatarUrl })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);
  const oldKey = objectKeyFromUrl(profile?.avatarUrl);
  if (oldKey) {
    deleteStoredObject(oldKey).catch(() => {});
  }

  const now = new Date();
  await db
    .update(profilesTable)
    .set({ avatarUrl: null, updatedAt: now })
    .where(eq(profilesTable.id, userId));

  triggerEvent("public-presence", "avatar:updated", { userId, avatarVersion: now.getTime() }).catch(() => {});

  // Return avatarVersion so client can immediately bust the cache for this user
  return res.json({ success: true, avatarVersion: now.getTime() });
});

// ── GET /api/profile/public/:username ─────────────────────────────────────────
router.get("/profile/public/:username", async (req, res) => {
  const username = String(req.params.username).toLowerCase().trim();

  const rows = await db
    .select({
      id:            profilesTable.id,
      fullName:      profilesTable.fullName,
      username:      profilesTable.username,
      country:       profilesTable.country,
      countryFlag:   profilesTable.countryFlag,
      avatarColor:   profilesTable.avatarColor,
      avatarUrl:     profilesTable.avatarUrl,
      bio:           profilesTable.bio,
      totalSteps:    profilesTable.totalSteps,
      currentStreak: profilesTable.currentStreak,
      currentRank:   profilesTable.currentRank,
    })
    .from(profilesTable)
    .where(eq(profilesTable.username, username))
    .limit(1);

  const p = rows[0];
  if (!p) return res.status(404).json({ error: "User not found" });

  const [raceRows, pubStreakRows] = await Promise.all([
    db.select({
        rank: raceResultsTable.rank,
        prizeCents: raceResultsTable.prizeCents,
        eligibleForPrize: raceResultsTable.eligibleForPrize,
      })
      .from(raceResultsTable)
      .where(eq(raceResultsTable.userId, p.id)),
    db.select({ date: stepDailyTotalsTable.date, steps: stepDailyTotalsTable.steps })
      .from(stepDailyTotalsTable)
      .where(eq(stepDailyTotalsTable.userId, p.id))
      .orderBy(desc(stepDailyTotalsTable.date)),
  ]);

  const pubAllTime = pubStreakRows.reduce((sum, r) => sum + (r.steps ?? 0), 0);
  const lifetimeXP = computeXP(pubAllTime, raceRows);
  const levelData  = computeLevelData(lifetimeXP);
  const pubStreak  = computeStreak(pubStreakRows);

  return res.json({
    success: true,
    data: {
      profile: {
        ...p,
        currentRank: p.currentRank === 9999 ? null : p.currentRank,
      },
      stats: {
        allTimeSteps:    pubAllTime,
        dayStreak:       pubStreak,
        dailyRank:       p.currentRank === 9999 ? null : p.currentRank,
        level:           levelData.level,
        levelTitle:      levelData.levelTitle,
        xp:              levelData.xp,
        progressPercent: levelData.progressPercent,
        totalRaces:      raceRows.length,
        racesWon:        raceRows.filter(isRaceWinResult).length,
        top3Finishes:    raceRows.filter((r) => isRacePodiumRank(r.rank)).length,
      },
    },
  });
});

// ── GET /api/users/:userId/public-profile ──────────────────────────────────────
// Returns public profile info for any user by ID. Used in waiting room profile modal.
router.get("/users/:userId/public-profile", requireAuth, async (req, res) => {
  const myId = (req as AuthenticatedRequest).descopeUserId;
  const targetId = String(req.params.userId);

  const [p] = await db
    .select({
      id:            profilesTable.id,
      username:      profilesTable.username,
      country:       profilesTable.country,
      countryFlag:   profilesTable.countryFlag,
      avatarColor:   profilesTable.avatarColor,
      avatarUrl:     profilesTable.avatarUrl,
      updatedAt:     profilesTable.updatedAt,
      totalSteps:    profilesTable.totalSteps,
      currentStreak: profilesTable.currentStreak,
    })
    .from(profilesTable)
    .where(eq(profilesTable.id, targetId))
    .limit(1);

  if (!p) return res.status(404).json({ error: "User not found" });

  const [raceRows, titleRow, friendRow, reqRow, coinRow, cashWonRow] = await Promise.all([
    db.select({ rank: raceResultsTable.rank, eligibleForPrize: raceResultsTable.eligibleForPrize })
      .from(raceResultsTable)
      .where(eq(raceResultsTable.userId, targetId)),
    db.select({ code: achievementDefinitionsTable.code, title: achievementDefinitionsTable.title })
      .from(userTitlesTable)
      .innerJoin(achievementDefinitionsTable, eq(achievementDefinitionsTable.code, userTitlesTable.achievementCode))
      .where(and(eq(userTitlesTable.userId, targetId), eq(userTitlesTable.isActive, true)))
      .limit(1)
      .then((r) => r[0] ?? null),
    db.select({ id: friendsTable.id })
      .from(friendsTable)
      .where(and(eq(friendsTable.userId, myId), eq(friendsTable.friendId, targetId)))
      .limit(1)
      .then((r) => r[0] ?? null),
    db.select({ id: friendRequestsTable.id, senderId: friendRequestsTable.senderId })
      .from(friendRequestsTable)
      .where(and(
        eq(friendRequestsTable.status, "pending"),
        or(
          and(eq(friendRequestsTable.senderId, myId), eq(friendRequestsTable.recipientId, targetId)),
          and(eq(friendRequestsTable.senderId, targetId), eq(friendRequestsTable.recipientId, myId)),
        ),
      ))
      .limit(1)
      .then((r) => r[0] ?? null),
    db.select({ currentBalance: coinBalancesTable.currentBalance })
      .from(coinBalancesTable)
      .where(eq(coinBalancesTable.userId, targetId))
      .limit(1)
      .then((r) => r[0] ?? null),
    db.select({ totalCashWonCents: sql<number>`COALESCE(SUM(${raceResultsTable.prizeCents}), 0)::int` })
      .from(raceResultsTable)
      .innerJoin(raceRoomsTable, sql`${raceResultsTable.raceRoomId}::uuid = ${raceRoomsTable.id}`)
      .where(and(
        eq(raceResultsTable.userId, targetId),
        gt(raceRoomsTable.entryAmountCents, 0),
      ))
      .then((r) => r[0] ?? null),
  ]);

  let friendStatus: "none" | "pending_sent" | "pending_received" | "friends" = "none";
  let friendRequestId: string | null = null;

  if (friendRow) {
    friendStatus = "friends";
  } else if (reqRow) {
    friendStatus = reqRow.senderId === myId ? "pending_sent" : "pending_received";
    friendRequestId = reqRow.id;
  }
  const lifetimeCashWonCents = cashWonRow?.totalCashWonCents ?? 0;

  return res.json({
    userId: p.id,
    username: p.username,
    country: p.country ?? null,
    countryFlag: p.countryFlag ?? "🏳️",
    avatarColor: p.avatarColor ?? "#00E676",
    avatarUrl:   p.avatarUrl ?? null,
    avatarVersion: p.updatedAt?.getTime() ?? 0,
    activeTitle: titleRow ? { code: titleRow.code, title: titleRow.title } : null,
    friendStatus,
    friendRequestId,
    stats: {
      lifetimeSteps:     p.totalSteps ?? 0,
      coinsBalance:      coinRow?.currentBalance ?? 0,
      lifetimeCashWonCents,
      lifetimeCashWonDollars: lifetimeCashWonCents / 100,
      racesPlayed:       raceRows.length,
      raceWins:          raceRows.filter(isRaceWinResult).length,
      currentStreakDays:  p.currentStreak ?? 0,
    },
  });
});


// ── POST /api/me/step-source ──────────────────────────────────────────────────
const stepSourceSchema = z.object({
  platform:          z.string().min(1).max(50),
  permission_status: z.string().min(1).max(30),
  source_name:       z.string().max(100).optional(),
  setup_completed:   z.boolean().optional(),
});

router.post("/me/step-source", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parse = stepSourceSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: parse.error.issues[0]?.message ?? "Invalid data" });
  }
  const { platform, permission_status, source_name, setup_completed } = parse.data;
  const now = new Date();

  const existing = await db
    .select({ id: userStepSourcesTable.id })
    .from(userStepSourcesTable)
    .where(and(eq(userStepSourcesTable.userId, userId), eq(userStepSourcesTable.platform, platform)))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(userStepSourcesTable)
      .set({
        permissionStatus: permission_status,
        ...(source_name !== undefined ? { sourceName: source_name } : {}),
        ...(setup_completed !== undefined ? { setupCompleted: setup_completed } : {}),
        ...(setup_completed === true ? { setupCompletedAt: now } : {}),
        lastSyncAt: now,
        updatedAt: now,
      })
      .where(and(eq(userStepSourcesTable.userId, userId), eq(userStepSourcesTable.platform, platform)));
  } else {
    await db.insert(userStepSourcesTable).values({
      userId,
      platform,
      permissionStatus: permission_status,
      ...(source_name !== undefined ? { sourceName: source_name } : {}),
      setupCompleted: setup_completed ?? false,
      ...(setup_completed === true ? { setupCompletedAt: now } : {}),
      lastSyncAt: now,
    });
  }

  req.log.info({ userId, platform, permission_status }, "step source upserted");
  return res.json({ success: true });
});

// ── DELETE /api/me/account ────────────────────────────────────────────────────
router.delete("/me/account", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  await db
    .update(profilesTable)
    .set({ accountStatus: "deleted", updatedAt: new Date() })
    .where(eq(profilesTable.id, userId));

  req.log.info({ userId }, "account self-deleted by user request");
  return res.json({ success: true });
});

export default router;
