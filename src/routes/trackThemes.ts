import { Router, type Request, type Response } from "express";
import { db } from "../../db/src/index.js";
import {
  raceTrackThemesTable,
  userTrackThemesTable,
  coinBalancesTable,
} from "../../db/src/schema/index.js";
import { eq, and, asc, ne } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import { getCoinBalance, spendCoins } from "../lib/coinsService.js";
import {
  isObjectStorageConfigError,
  isObjectStorageConfigured,
  storedObjectExists,
} from "../lib/objectStorage.js";
import { proxyStoredObjectResponse } from "../lib/objectMediaProxy.js";
import { config } from "../lib/config.js";
import { triggerEvent } from "../lib/pusher.js";
import { buildTrackThemeMedia } from "../lib/trackThemeMedia.js";
import { logger } from "../lib/logger.js";

const router = Router();
const THEME_OBJECT_EXTENSIONS = ["", ".png", ".jpg", ".jpeg", ".webp", ".gif"];
const GLOBAL_DEFAULT_THEME_CODE = "bg";

// ── Default themes seeded on first request ────────────────────────────────────
const DEFAULT_THEMES = [
  { code: "bg",          name: "Neon Finish",      priceCoins: 0,    isDefault: true,  sortOrder: 0  },
  { code: "daylightStadium", name: "Daylight Stadium", priceCoins: 0, isDefault: false, sortOrder: 1  },
  { code: "bg1",         name: "Arcade Track",     priceCoins: 250,  isDefault: false, sortOrder: 2  },
  { code: "galaxy",      name: "Galaxy",           priceCoins: 500,  isDefault: false, sortOrder: 3  },
  { code: "forest",      name: "Forest",           priceCoins: 750,  isDefault: false, sortOrder: 4  },
  { code: "city",        name: "City",             priceCoins: 1000, isDefault: false, sortOrder: 5  },
  { code: "lava",        name: "Lava",             priceCoins: 1500, isDefault: false, sortOrder: 6  },
  { code: "ice",         name: "Ice",              priceCoins: 1500, isDefault: false, sortOrder: 7  },
  { code: "candy",       name: "Candy Land",       priceCoins: 2000, isDefault: false, sortOrder: 8  },
  { code: "farm",        name: "Farm",             priceCoins: 2500, isDefault: false, sortOrder: 9  },
  { code: "underwater",  name: "Underwater",       priceCoins: 3000, isDefault: false, sortOrder: 10 },
  { code: "musicfest",   name: "Music Fest",       priceCoins: 5000, isDefault: false, sortOrder: 11 },
  // ── New themes ───────────────────────────────────────────────────────────────
  { code: "barbie",       name: "Barbie",           priceCoins: 250,  isDefault: false, sortOrder: 12 },
  { code: "desert",       name: "Desert",           priceCoins: 250,  isDefault: false, sortOrder: 13 },
  { code: "gold",         name: "Gold",             priceCoins: 500,  isDefault: false, sortOrder: 14 },
  { code: "nightforest",  name: "Night Forest",     priceCoins: 750,  isDefault: false, sortOrder: 15 },
  { code: "skykingdom",   name: "Sky Kingdom",      priceCoins: 1000, isDefault: false, sortOrder: 16 },
  { code: "rain",         name: "Rain",             priceCoins: 250,  isDefault: false, sortOrder: 17 },
  { code: "storm",        name: "Storm",            priceCoins: 500,  isDefault: false, sortOrder: 18 },
  { code: "mountain",     name: "Mountain",         priceCoins: 750,  isDefault: false, sortOrder: 19 },
  { code: "waterfall",    name: "Waterfall",        priceCoins: 1000, isDefault: false, sortOrder: 20 },
  { code: "webcity",      name: "Web City",         priceCoins: 1500, isDefault: false, sortOrder: 21 },
  { code: "bridge",       name: "Bridge",           priceCoins: 1500, isDefault: false, sortOrder: 22 },
  { code: "newyork",      name: "New York",         priceCoins: 2000, isDefault: false, sortOrder: 23 },
  { code: "pirateisland", name: "Pirate Island",    priceCoins: 2500, isDefault: false, sortOrder: 24 },
  { code: "paradise",     name: "Paradise",         priceCoins: 3000, isDefault: false, sortOrder: 25 },
  { code: "musicfest2",   name: "Music Fest 2",     priceCoins: 5000, isDefault: false, sortOrder: 26 },
  // ── Premium race-track skins ─────────────────────────────────────────────────
  { code: "chocolate",    name: "Chocolate Factory", priceCoins: 1000, isDefault: false, sortOrder: 27 },
  { code: "fireworks",    name: "Fireworks",          priceCoins: 1500, isDefault: false, sortOrder: 28 },
  { code: "moon",         name: "Moon Base",          priceCoins: 2000, isDefault: false, sortOrder: 29 },
  { code: "rainbow_road", name: "Rainbow Road",       priceCoins: 3000, isDefault: false, sortOrder: 30 },
  { code: "runway",       name: "Runway",             priceCoins: 1500, isDefault: false, sortOrder: 31 },
  { code: "toy_race",     name: "Toy Race",           priceCoins: 1000, isDefault: false, sortOrder: 32 },
  { code: "water_park",   name: "Water Park",         priceCoins: 2000, isDefault: false, sortOrder: 33 },
];

let seeded = false;
let seedThemesPromise: Promise<void> | null = null;

async function seedThemesIfNeeded(): Promise<void> {
  if (seeded) return;
  if (!seedThemesPromise) {
    seedThemesPromise = (async () => {
      // Insert all themes; onConflictDoNothing safely skips already-existing rows
      await db
        .insert(raceTrackThemesTable)
        .values(
          DEFAULT_THEMES.map((t) => ({
            code: t.code,
            name: t.name,
            priceCoins: t.priceCoins,
            assetKey: t.code,
            sortOrder: t.sortOrder,
            isDefault: t.isDefault,
            isActive: true,
          })),
        )
        .onConflictDoNothing();

      // Keep exactly one global fallback default. Per-user defaults live in user_track_themes.
      await db
        .update(raceTrackThemesTable)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(ne(raceTrackThemesTable.code, GLOBAL_DEFAULT_THEME_CODE));

      await db
        .update(raceTrackThemesTable)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(raceTrackThemesTable.code, GLOBAL_DEFAULT_THEME_CODE));

      seeded = true;
    })().catch((err: unknown) => {
      seedThemesPromise = null;
      throw err;
    });
  }

  await seedThemesPromise;
}

function buildThemePayload<T extends {
  code: string;
  assetVersion?: number | null;
}>(theme: T) {
  const media = buildTrackThemeMedia(theme.code, theme.assetVersion);
  return {
    ...theme,
    assetVersion: media.assetVersion,
    width: media.width,
    height: media.height,
    imageSet: media.imageSet,
    imageUrl: media.imageUrl,
  };
}

function setThemeCatalogCacheHeaders(res: Response) {
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
  res.setHeader("Cloudflare-CDN-Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
  res.setHeader("CDN-Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
  res.setHeader("Surrogate-Control", "max-age=300");
}

function isThemeCatalogRequest(req: Request): boolean {
  return req.query.scope === "catalog" || req.query.static === "1";
}

function isThemeFreeForUser(theme: Pick<typeof raceTrackThemesTable.$inferSelect, "isDefault" | "priceCoins">): boolean {
  return theme.isDefault || theme.priceCoins === 0;
}

async function userOwnsTheme(userId: string, themeCode: string): Promise<boolean> {
  const [owned] = await db
    .select({ id: userTrackThemesTable.id })
    .from(userTrackThemesTable)
    .where(and(eq(userTrackThemesTable.userId, userId), eq(userTrackThemesTable.themeCode, themeCode)))
    .limit(1);

  return !!owned;
}

export async function setUserDefaultTrackTheme(userId: string, themeCode: string): Promise<boolean> {
  await seedThemesIfNeeded();

  const [theme] = await db
    .select()
    .from(raceTrackThemesTable)
    .where(and(eq(raceTrackThemesTable.code, themeCode), eq(raceTrackThemesTable.isActive, true)))
    .limit(1);

  if (!theme) return false;

  if (!isThemeFreeForUser(theme) && !(await userOwnsTheme(userId, themeCode))) {
    return false;
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(userTrackThemesTable)
      .set({ isEquipped: false, updatedAt: now })
      .where(eq(userTrackThemesTable.userId, userId));

    await tx
      .insert(userTrackThemesTable)
      .values({
        userId,
        themeCode,
        purchasePriceCoins: 0,
        isEquipped: true,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [userTrackThemesTable.userId, userTrackThemesTable.themeCode],
        set: { isEquipped: true, updatedAt: now },
      });
  });

  return true;
}

async function resolveThemeObjectKey(assetKey: string | null | undefined, themeCode: string): Promise<string | null> {
  if (!isObjectStorageConfigured()) return null;

  const baseKeys = new Set<string>();
  const normalizedAssetKey = assetKey?.trim() || themeCode;

  if (normalizedAssetKey.includes("/")) {
    baseKeys.add(normalizedAssetKey);
  } else {
    baseKeys.add(`race-themes/${normalizedAssetKey}`);
  }

  if (!normalizedAssetKey.includes(".")) {
    for (const baseKey of [...baseKeys]) {
      for (const ext of THEME_OBJECT_EXTENSIONS) {
        baseKeys.add(`${baseKey}${ext}`);
      }
    }
  }

  for (const key of baseKeys) {
    if (await storedObjectExists(key)) {
      return key;
    }
  }

  return null;
}

export async function getTrackThemeCatalog() {
  await seedThemesIfNeeded();

  const allThemes = await db
    .select()
    .from(raceTrackThemesTable)
    .where(eq(raceTrackThemesTable.isActive, true))
    .orderBy(asc(raceTrackThemesTable.sortOrder));

  return {
    defaultThemeCode: GLOBAL_DEFAULT_THEME_CODE,
    themes: allThemes.map((t) => buildThemePayload({
      code: t.code,
      name: t.name,
      priceCoins: t.priceCoins,
      isDefault: t.isDefault,
      assetKey: t.assetKey,
      assetVersion: t.assetVersion,
      sortOrder: t.sortOrder,
    })),
  };
}

export async function getTrackThemeSummaryForUser(userId: string) {
  await seedThemesIfNeeded();

  const [allThemes, ownedRows, balanceData] = await Promise.all([
    db
      .select()
      .from(raceTrackThemesTable)
      .where(eq(raceTrackThemesTable.isActive, true))
      .orderBy(asc(raceTrackThemesTable.sortOrder)),
    db
      .select()
      .from(userTrackThemesTable)
      .where(eq(userTrackThemesTable.userId, userId)),
    getCoinBalance(userId),
  ]);

  const ownedMap = new Map(ownedRows.map((r) => [r.themeCode, r]));
  const { currentBalance } = balanceData;
  let selectedThemeCode = ownedRows.find((r) => r.isEquipped)?.themeCode ?? GLOBAL_DEFAULT_THEME_CODE;
  const selectedTheme = allThemes.find((t) => t.code === selectedThemeCode);
  if (!selectedTheme || (!isThemeFreeForUser(selectedTheme) && !ownedMap.has(selectedTheme.code))) {
    selectedThemeCode = GLOBAL_DEFAULT_THEME_CODE;
  }

  const themes = allThemes.map((t) => {
    const owned = isThemeFreeForUser(t) || ownedMap.has(t.code);
    const locked = !owned;
    return buildThemePayload({
      code: t.code,
      name: t.name,
      priceCoins: t.priceCoins,
      isDefault: t.isDefault,
      owned,
      locked,
      isEquipped: owned ? t.code === selectedThemeCode : false,
      canPurchase: locked && currentBalance >= t.priceCoins,
      coinsNeeded: locked ? Math.max(0, t.priceCoins - currentBalance) : 0,
      assetKey: t.assetKey,
      assetVersion: t.assetVersion,
      sortOrder: t.sortOrder,
    });
  });

  return {
    coinBalance: currentBalance,
    selectedThemeCode,
    defaultThemeCode: GLOBAL_DEFAULT_THEME_CODE,
    ownedCount: themes.filter((t) => t.owned).length,
    totalCount: themes.length,
    equippedTheme: themes.find((t) => t.isEquipped) ?? null,
    themes,
  };
}

// ── GET /api/track-themes ─────────────────────────────────────────────────────
// Returns all active themes with user ownership state + current coin balance.
router.get("/track-themes", (req, res, next) => {
  if (isThemeCatalogRequest(req)) return next();
  return requireAuth(req, res, next);
}, async (req, res) => {
  try {
    if (isThemeCatalogRequest(req)) {
      setThemeCatalogCacheHeaders(res);
      return res.json(await getTrackThemeCatalog());
    }

    const userId = (req as AuthenticatedRequest).descopeUserId;
    const summary = await getTrackThemeSummaryForUser(userId);
    return res.json({
      coinBalance: summary.coinBalance,
      selectedThemeCode: summary.selectedThemeCode,
      defaultThemeCode: summary.defaultThemeCode,
      themes: summary.themes,
    });
  } catch (err) {
    req.log.error({ err }, "track-themes GET error");
    return res.status(500).json({ error: "Failed to fetch track themes" });
  }
});

// ── POST /api/track-themes/:code/purchase ─────────────────────────────────────
router.post("/track-themes/:code/purchase", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const code = req.params.code as string;

  try {
    await seedThemesIfNeeded();

    // Load theme
    const [theme] = await db
      .select()
      .from(raceTrackThemesTable)
      .where(and(eq(raceTrackThemesTable.code, code), eq(raceTrackThemesTable.isActive, true)))
      .limit(1);

    if (!theme) return res.status(404).json({ success: false, message: "Theme not found" });
    if (theme.isDefault || theme.priceCoins === 0) {
      return res.status(400).json({ success: false, message: "This theme is already free" });
    }

    // Check not already owned
    const [existing] = await db
      .select()
      .from(userTrackThemesTable)
      .where(and(eq(userTrackThemesTable.userId, userId), eq(userTrackThemesTable.themeCode, code)))
      .limit(1);

    if (existing) {
      return res.status(400).json({ success: false, message: "Theme already owned" });
    }

    // Spend coins
    const spend = await spendCoins({
      userId,
      amount: theme.priceCoins,
      source: "theme_purchase",
      sourceId: code,
      description: `Unlocked ${theme.name} track theme`,
    });

    if (!spend.success) {
      return res.status(400).json({
        success: false,
        message: "Not enough coins",
        coins_needed: spend.coinsNeeded,
        currentBalance: spend.newBalance,
      });
    }

    // Record ownership
    await db.insert(userTrackThemesTable).values({
      userId,
      themeCode: code,
      purchasePriceCoins: theme.priceCoins,
      isEquipped: false,
    });

    req.log.info({ userId, themeCode: code, price: theme.priceCoins }, "track theme purchased");

    triggerEvent(`private-user-${userId}`, "walk.bootstrap_invalidated", {
      reason: "theme_purchased",
      themeCode: code,
    }).catch(() => {});

    return res.json({
      success: true,
      message: "Theme unlocked",
      coinBalance: spend.newBalance,
      theme: buildThemePayload({
        code: theme.code,
        name: theme.name,
        priceCoins: theme.priceCoins,
        isDefault: theme.isDefault,
        owned: true,
        locked: false,
        isEquipped: false,
        canPurchase: false,
        coinsNeeded: 0,
        assetKey: theme.assetKey,
        assetVersion: theme.assetVersion,
        sortOrder: theme.sortOrder,
      }),
    });
  } catch (err) {
    req.log.error({ err }, "track-themes purchase error");
    return res.status(500).json({ success: false, message: "Purchase failed" });
  }
});

// ── POST /api/track-themes/:code/equip ───────────────────────────────────────
router.post("/track-themes/:code/equip", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const code = req.params.code as string;

  try {
    await seedThemesIfNeeded();

    const [theme] = await db
      .select()
      .from(raceTrackThemesTable)
      .where(and(eq(raceTrackThemesTable.code, code), eq(raceTrackThemesTable.isActive, true)))
      .limit(1);

    if (!theme) return res.status(404).json({ error: "Theme not found" });

    // Must own or be a free/default theme.
    if (!isThemeFreeForUser(theme)) {
      const [owned] = await db
        .select()
        .from(userTrackThemesTable)
        .where(and(eq(userTrackThemesTable.userId, userId), eq(userTrackThemesTable.themeCode, code)))
        .limit(1);
      if (!owned) return res.status(403).json({ error: "Theme not owned" });
    }

    const equipped = await setUserDefaultTrackTheme(userId, code);
    if (!equipped) return res.status(403).json({ error: "Theme not owned" });

    triggerEvent(`private-user-${userId}`, "walk.bootstrap_invalidated", {
      reason: "theme_equipped",
      themeCode: code,
    }).catch(() => {});

    return res.json({ success: true, equippedCode: code });
  } catch (err) {
    req.log.error({ err }, "track-themes equip error");
    return res.status(500).json({ error: "Failed to equip theme" });
  }
});

// ── GET /api/track-themes/:code/image ─────────────────────────────────────────
router.get("/track-themes/:code/image", async (req, res) => {
  const code = String(req.params.code);
  if (!isObjectStorageConfigured()) return res.status(503).json({ error: "Theme asset storage is not configured" });

  try {
    await seedThemesIfNeeded();

    const [theme] = await db
      .select({ code: raceTrackThemesTable.code, assetKey: raceTrackThemesTable.assetKey })
      .from(raceTrackThemesTable)
      .where(and(eq(raceTrackThemesTable.code, code), eq(raceTrackThemesTable.isActive, true)))
      .limit(1);

    if (!theme) return res.status(404).json({ error: "Theme not found" });

    const objKey = await resolveThemeObjectKey(theme.assetKey, theme.code);
    if (!objKey) {
      req.log.warn({ code: theme.code, assetKey: theme.assetKey }, "track theme asset missing from object storage");
      return res.status(404).json({ error: "Theme image not found" });
    }

    await proxyStoredObjectResponse(req, res, {
      routeName: "track-theme-image",
      objectKey: objKey,
      maxBytes: config.runtime.themeImageBodyLimitBytes,
      cacheControl: req.query.v
        ? "public, max-age=31536000, immutable"
        : "public, max-age=300",
    });
    return;
  } catch (err) {
    if (isObjectStorageConfigError(err)) {
      return res.status(503).json({ error: "Theme asset storage is not configured" });
    }
    req.log.error({ err, code }, "track theme image fetch failed");
    return res.status(500).json({ error: "Failed to fetch theme image" });
  }
});

// ── GET /api/track-themes/validate ───────────────────────────────────────────
// Used internally by race room creation to validate theme ownership.
export async function validateThemeOwnership(userId: string, themeCode: string): Promise<boolean> {
  try {
    await seedThemesIfNeeded();
    const [theme] = await db
      .select()
      .from(raceTrackThemesTable)
      .where(eq(raceTrackThemesTable.code, themeCode))
      .limit(1);

    if (!theme || !theme.isActive) return false;
    if (isThemeFreeForUser(theme)) return true;

    const [owned] = await db
      .select()
      .from(userTrackThemesTable)
      .where(and(eq(userTrackThemesTable.userId, userId), eq(userTrackThemesTable.themeCode, themeCode)))
      .limit(1);

    return !!owned;
  } catch (err) {
    // Fail CLOSED: an unexpected error (pool exhaustion, timeout, deadlock —
    // all inducible under load) must not grant access to a paid theme. Deny and
    // let the caller surface the failure rather than silently bypass the paywall.
    logger.error({ err, userId, themeCode }, "validateThemeOwnership failed; denying access");
    return false;
  }
}

export default router;
