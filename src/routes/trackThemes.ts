import { Router } from "express";
import { db } from "@db";
import {
  raceTrackThemesTable,
  userTrackThemesTable,
  coinBalancesTable,
} from "@db/schema";
import { eq, and, asc } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth";
import { getCoinBalance, spendCoins } from "../lib/coinsService";
import {
  isObjectStorageConfigError,
  isObjectStorageConfigured,
  storedObjectExists,
} from "../lib/objectStorage";
import { proxyStoredObjectResponse } from "../lib/objectMediaProxy";
import { config } from "../lib/config";

const router = Router();
const THEME_OBJECT_EXTENSIONS = ["", ".png", ".jpg", ".jpeg", ".webp", ".gif"];

// ── Default themes seeded on first request ────────────────────────────────────
const DEFAULT_THEMES = [
  { code: "bg",          name: "Neon Finish",      priceCoins: 0,    isDefault: true,  sortOrder: 0  },
  { code: "daylightStadium", name: "Daylight Stadium", priceCoins: 0, isDefault: true,  sortOrder: 1  },
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

async function seedThemesIfNeeded(): Promise<void> {
  if (seeded) return;
  seeded = true; // set early to prevent concurrent calls
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
}

function buildThemeImageUrl(code: string): string {
  return `/api/track-themes/${encodeURIComponent(code)}/image`;
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

// ── GET /api/track-themes ─────────────────────────────────────────────────────
// Returns all active themes with user ownership state + current coin balance.
router.get("/track-themes", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  try {
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

    const themes = allThemes.map((t) => {
      const owned = t.isDefault || ownedMap.has(t.code);
      const locked = !owned;
      const ownedRow = ownedMap.get(t.code);
      return {
        code: t.code,
        name: t.name,
        priceCoins: t.priceCoins,
        isDefault: t.isDefault,
        owned,
        locked,
        isEquipped: ownedRow?.isEquipped ?? t.isDefault,
        canPurchase: locked && currentBalance >= t.priceCoins,
        coinsNeeded: locked ? Math.max(0, t.priceCoins - currentBalance) : 0,
        assetKey: t.assetKey,
        imageUrl: buildThemeImageUrl(t.code),
        sortOrder: t.sortOrder,
      };
    });

    return res.json({ coinBalance: currentBalance, themes });
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

    return res.json({
      success: true,
      message: "Theme unlocked",
      coinBalance: spend.newBalance,
      theme: {
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
        imageUrl: buildThemeImageUrl(theme.code),
        sortOrder: theme.sortOrder,
      },
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

    // Must own or be default
    if (!theme.isDefault) {
      const [owned] = await db
        .select()
        .from(userTrackThemesTable)
        .where(and(eq(userTrackThemesTable.userId, userId), eq(userTrackThemesTable.themeCode, code)))
        .limit(1);
      if (!owned) return res.status(403).json({ error: "Theme not owned" });
    }

    // Unequip all, then equip selected
    await db
      .update(userTrackThemesTable)
      .set({ isEquipped: false, updatedAt: new Date() })
      .where(eq(userTrackThemesTable.userId, userId));

    if (!theme.isDefault) {
      await db
        .update(userTrackThemesTable)
        .set({ isEquipped: true, updatedAt: new Date() })
        .where(
          and(eq(userTrackThemesTable.userId, userId), eq(userTrackThemesTable.themeCode, code)),
        );
    }

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
    if (theme.isDefault) return true;

    const [owned] = await db
      .select()
      .from(userTrackThemesTable)
      .where(and(eq(userTrackThemesTable.userId, userId), eq(userTrackThemesTable.themeCode, themeCode)))
      .limit(1);

    return !!owned;
  } catch {
    return true; // fail-open to avoid breaking race creation
  }
}

export default router;
