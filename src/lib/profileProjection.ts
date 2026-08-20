import { eq } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import { profilesTable } from "../../db/src/schema/index.js";
import { config } from "./config.js";
import { ensureRedisCacheConnected, getRedisCache } from "./redis.js";

const key = (userId: string) => `projection:profile:${userId}`;

export async function setProfileAvatarProjection(userId: string, avatarUrl: string | null, avatarVersion: number): Promise<void> {
  if (!config.redis.cacheUrl) return;
  await ensureRedisCacheConnected();
  await getRedisCache().set(key(userId), JSON.stringify({ avatarUrl, avatarVersion }), "EX", 24 * 60 * 60);
}

export async function getProfileAvatarProjection(userId: string): Promise<{ avatarUrl: string | null; avatarVersion: number } | null> {
  if (config.redis.cacheUrl) {
    try {
      await ensureRedisCacheConnected();
      const cached = await getRedisCache().get(key(userId));
      if (cached) return JSON.parse(cached) as { avatarUrl: string | null; avatarVersion: number };
    } catch {
      // PostgreSQL fallback keeps old clients functional during a cache outage.
    }
  }
  const [profile] = await db.select({ avatarUrl: profilesTable.avatarUrl, updatedAt: profilesTable.updatedAt })
    .from(profilesTable).where(eq(profilesTable.id, userId)).limit(1);
  if (!profile) return null;
  const projection = { avatarUrl: profile.avatarUrl, avatarVersion: profile.updatedAt?.getTime() ?? 0 };
  void setProfileAvatarProjection(userId, projection.avatarUrl, projection.avatarVersion).catch(() => {});
  return projection;
}
