import { db } from "@db";
import { raceRoomsTable, profilesTable } from "@db/schema";
import { eq } from "drizzle-orm";
import {
  SPONSORED_EVENT_MAX_SLOTS,
  SPONSORED_EVENT_TARGET_STEPS,
  getSponsoredPrizePoolCents,
} from "../../src/lib/sponsoredEventRules.js";

// One-time bootstrap for a database that has zero sponsored rooms.
//
// The worker's autoFillSchedule() borrows creatorId from an existing sponsored room, so on an
// empty database it can never create the first one ("autoFill skipped — no creator found yet").
// This seeds the same 8 weekends autoFillSchedule would, using identical field values and
// invite codes, so the worker's idempotency guard picks up from here and self-sustains.
//
// Deliberately does NOT call notifyPromotionalSponsoredEvent — seeding 16 events at once would
// send 16 promotional push blasts to the whole user base. Future weekends created by the worker
// notify at the normal one-event-at-a-time cadence.
//
// Usage:
//   CREATOR_ID=<profileId> pnpm tsx ./scripts/src/seedSponsoredWeekends.ts --dry-run
//   CREATOR_ID=<profileId> pnpm tsx ./scripts/src/seedSponsoredWeekends.ts

const TZ_OFFSET_HOURS = -5; // America/Chicago CDT — matches sponsoredEvents.ts
const WEEKEND_COUNT = 8;

function makeEventTime(baseDate: Date, localHour: number): Date {
  const d = new Date(baseDate);
  d.setUTCHours(localHour - TZ_OFFSET_HOURS, 0, 0, 0);
  return d;
}

function padDate(n: number) { return String(n).padStart(2, "0"); }

function eventInviteCode(day: "sat" | "sun", slot: "morning" | "evening", date: Date): string {
  return `sponsored_${day}_${slot}_${date.getUTCFullYear()}_${padDate(date.getUTCMonth() + 1)}_${padDate(date.getUTCDate())}`;
}

function pickTrackLayout(day: "sat" | "sun", date: Date): string {
  const weekIndex = Math.floor((date.getUTCDate() - 1) / 7);
  const satTracks = ["bg1", "bg3", "bg5", "bg", "bg2"] as const;
  const sunTracks = ["bg2", "bg4", "bg", "bg1", "bg3"] as const;
  return day === "sat"
    ? satTracks[weekIndex % satTracks.length]
    : sunTracks[weekIndex % sunTracks.length];
}

function getUpcomingWeekends(count: number): Array<{ sat: Date; sun: Date }> {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const daysToSat = dayOfWeek === 6 ? 0 : (6 - dayOfWeek + 7) % 7;
  const weekends: Array<{ sat: Date; sun: Date }> = [];
  for (let i = 0; i < count; i++) {
    const sat = new Date(now);
    sat.setUTCDate(now.getUTCDate() + daysToSat + i * 7);
    sat.setUTCHours(0, 0, 0, 0);
    const sun = new Date(sat);
    sun.setUTCDate(sat.getUTCDate() + 1);
    weekends.push({ sat, sun });
  }
  return weekends;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const creatorId = process.env.CREATOR_ID?.trim();
  if (!creatorId) {
    console.error("CREATOR_ID is required (profile id to attribute the seeded events to).");
    process.exit(1);
  }

  const [creator] = await db
    .select({ id: profilesTable.id, username: profilesTable.username })
    .from(profilesTable)
    .where(eq(profilesTable.id, creatorId))
    .limit(1);
  if (!creator) {
    console.error(`CREATOR_ID ${creatorId} does not exist in profiles on this database.`);
    process.exit(1);
  }
  console.log(`${dryRun ? "[dry-run] " : ""}creator: ${creator.username} (${creator.id})`);

  const schedule: Array<{ day: "sat" | "sun"; slot: "morning" | "evening"; date: Date; localHour: number; title: string }> = [];
  for (const { sat, sun } of getUpcomingWeekends(WEEKEND_COUNT)) {
    const satLabel = sat.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const sunLabel = sun.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    schedule.push(
      { day: "sat", slot: "morning", date: sat, localHour: 8, title: `Saturday Morning Walk (${satLabel})` },
      { day: "sun", slot: "evening", date: sun, localHour: 18, title: `Sunday Evening Walk (${sunLabel})` },
    );
  }

  let created = 0;
  let skipped = 0;
  for (const ev of schedule) {
    const inviteCode = eventInviteCode(ev.day, ev.slot, ev.date);
    const startAt = makeEventTime(ev.date, ev.localHour);
    const trackLayout = pickTrackLayout(ev.day, ev.date);

    const existing = await db
      .select({ id: raceRoomsTable.id })
      .from(raceRoomsTable)
      .where(eq(raceRoomsTable.inviteCode, inviteCode))
      .limit(1);
    if (existing.length > 0) {
      skipped += 1;
      console.log(`skip (exists): ${inviteCode}`);
      continue;
    }

    if (dryRun) {
      created += 1;
      console.log(`would create: ${inviteCode} | ${ev.title} | ${startAt.toISOString()} | ${trackLayout}`);
      continue;
    }

    const [inserted] = await db.insert(raceRoomsTable).values({
      creatorId: creator.id,
      title: ev.title,
      type: "sponsored",
      entryType: "free",
      entryAmountCents: 0,
      targetSteps: SPONSORED_EVENT_TARGET_STEPS,
      maxPlayers: SPONSORED_EVENT_MAX_SLOTS,
      status: "scheduled",
      scheduleType: "scheduled",
      scheduledStartAt: startAt,
      prizePoolCents: getSponsoredPrizePoolCents(SPONSORED_EVENT_MAX_SLOTS),
      inviteCode,
      isPrivate: false,
      trackLayout,
    }).returning({ id: raceRoomsTable.id });

    created += 1;
    console.log(`created: ${inviteCode} | ${inserted.id} | ${startAt.toISOString()} | ${trackLayout}`);
  }

  console.log(`${dryRun ? "[dry-run] " : ""}done — ${created} ${dryRun ? "would be created" : "created"}, ${skipped} skipped`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
