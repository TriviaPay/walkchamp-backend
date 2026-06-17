import { Router } from "express";
import { db } from "@db";
import { userPreferencesTable, profilesTable } from "@db/schema";
import { eq } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth";
import { z } from "zod";

const router = Router();

const IANA_TZ_REGEX = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/;

const prefsSchema = z.object({
  dailyStepGoal: z.number().int().min(500).max(100000).optional(),
  distanceUnit: z.enum(["km", "mi"]).optional(),
  /**
   * IANA timezone string from the device (e.g. "America/Chicago").
   * Validated by a basic pattern + Date API round-trip. Defaults to "UTC".
   */
  timezone: z
    .string()
    .regex(IANA_TZ_REGEX, "Must be a valid IANA timezone (e.g. America/Chicago)")
    .refine((tz) => {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "Unrecognised IANA timezone")
    .optional(),
});

async function getOrCreatePrefs(userId: string) {
  const [existing] = await db
    .select()
    .from(userPreferencesTable)
    .where(eq(userPreferencesTable.userId, userId))
    .limit(1);

  if (existing) return existing;

  const [created] = await db
    .insert(userPreferencesTable)
    .values({ userId })
    .onConflictDoUpdate({
      target: [userPreferencesTable.userId],
      set: { updatedAt: new Date() },
    })
    .returning();

  return created!;
}

// ── GET /api/user/preferences ─────────────────────────────────────────────────
router.get("/user/preferences", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const [prefs, profile] = await Promise.all([
    getOrCreatePrefs(userId),
    db
      .select({ createdAt: profilesTable.createdAt })
      .from(profilesTable)
      .where(eq(profilesTable.id, userId))
      .limit(1)
      .then((r) => r[0] ?? null),
  ]);

  return res.json({
    success: true,
    dailyStepGoal: prefs.dailyStepGoal,
    distanceUnit: prefs.distanceUnit,
    timezone: prefs.timezone,
    joinedAt: profile?.createdAt ?? null,
  });
});

// ── PATCH /api/user/preferences ───────────────────────────────────────────────
router.patch("/user/preferences", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = prefsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid preferences", details: parsed.error.issues });
  }

  const updates: Partial<typeof userPreferencesTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (parsed.data.dailyStepGoal !== undefined) updates.dailyStepGoal = parsed.data.dailyStepGoal;
  if (parsed.data.distanceUnit !== undefined) updates.distanceUnit = parsed.data.distanceUnit;
  if (parsed.data.timezone !== undefined) updates.timezone = parsed.data.timezone;

  await db
    .insert(userPreferencesTable)
    .values({ userId, ...updates })
    .onConflictDoUpdate({
      target: [userPreferencesTable.userId],
      set: updates,
    });

  const [updated] = await db
    .select()
    .from(userPreferencesTable)
    .where(eq(userPreferencesTable.userId, userId))
    .limit(1);

  req.log.info({ userId, timezone: updated!.timezone }, "preferences updated");

  return res.json({
    success: true,
    dailyStepGoal: updated!.dailyStepGoal,
    distanceUnit: updated!.distanceUnit,
    timezone: updated!.timezone,
  });
});

export default router;
