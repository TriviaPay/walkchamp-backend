import { db } from "@db";
import {
  profilesTable,
  userAchievementsTable,
  userTitlesTable,
} from "@db/schema";
import { eq, and } from "drizzle-orm";

const TEST_TITLES = ["daily_starter", "first_stepper"] as const;
const ACTIVE_TITLE = "daily_starter" as const;

async function seedUser(userId: string, username: string) {
  const now = new Date();

  for (const code of TEST_TITLES) {
    await db
      .insert(userAchievementsTable)
      .values({
        userId,
        achievementCode: code,
        unlocked: true,
        unlockedAt: now,
        progressValue: 1,
      })
      .onConflictDoUpdate({
        target: [userAchievementsTable.userId, userAchievementsTable.achievementCode],
        set: { unlocked: true, unlockedAt: now, updatedAt: now },
      });

    await db
      .insert(userTitlesTable)
      .values({ userId, achievementCode: code, isActive: false })
      .onConflictDoNothing();

    console.log(`    ✓ ${code}`);
  }

  await db
    .update(userTitlesTable)
    .set({ isActive: false, updatedAt: now })
    .where(eq(userTitlesTable.userId, userId));

  await db
    .update(userTitlesTable)
    .set({ isActive: true, equippedAt: now, updatedAt: now })
    .where(
      and(
        eq(userTitlesTable.userId, userId),
        eq(userTitlesTable.achievementCode, ACTIVE_TITLE),
      ),
    );

  console.log(`    → active: ${ACTIVE_TITLE}`);
}

async function main() {
  const profiles = await db
    .select({ id: profilesTable.id, username: profilesTable.username })
    .from(profilesTable);

  if (!profiles.length) {
    console.error("No profiles found — make sure at least one user has logged in.");
    process.exit(1);
  }

  console.log(`Found ${profiles.length} profile(s) — seeding all:`);

  for (const user of profiles) {
    console.log(`\n→ ${user.username} (${user.id})`);
    await seedUser(user.id, user.username ?? "unknown");
  }

  console.log("\n✅ All profiles seeded — each user now has 2 owned titles.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
