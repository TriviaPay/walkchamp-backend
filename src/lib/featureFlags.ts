import { db } from "../../db/src/index.js";
import { featureFlagsTable } from "../../db/src/schema/index.js";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";

const CACHE_TTL_MS = 30_000;

type CachedFlag = {
  enabled: boolean;
  expiresAt: number;
};

const cache = new Map<string, CachedFlag>();

function envOverride(key: string): boolean | null {
  const envKey = `FEATURE_${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const raw = process.env[envKey];
  if (raw == null) return null;
  return raw === "true";
}

export async function isFeatureEnabled(key: string, defaultValue = false): Promise<boolean> {
  const override = envOverride(key);
  if (override != null) return override;

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.enabled;
  }

  try {
    const [row] = await db
      .select({ enabled: featureFlagsTable.enabled })
      .from(featureFlagsTable)
      .where(eq(featureFlagsTable.key, key))
      .limit(1);

    const enabled = row?.enabled ?? defaultValue;
    cache.set(key, { enabled, expiresAt: Date.now() + CACHE_TTL_MS });
    return enabled;
  } catch (err) {
    logger.warn({ err, key }, "[FeatureFlags] falling back to default");
    return defaultValue;
  }
}

export async function areCashFeaturesEnabled(): Promise<boolean> {
  const envSwitch = process.env.CASH_FEATURES_ENABLED === "true";
  if (!envSwitch) return false;
  return isFeatureEnabled("cash_features", false);
}

export function clearFeatureFlagCache() {
  cache.clear();
}
