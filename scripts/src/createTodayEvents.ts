import { db } from "@db";
import { raceRoomsTable } from "@db/schema";
import { eq } from "drizzle-orm";

const EVENTS = [
  {
    title: "Saturday Afternoon Walk (Jun 13)",
    // 1:20 PM CDT = UTC-5 → 18:20 UTC on June 13, 2026
    scheduledStartAt: new Date("2026-06-13T18:20:00.000Z"),
    trackLayout: "forest",
    inviteCode: "sponsored_sat_afternoon_1320_2026_06_13",
  },
  {
    title: "Saturday Midday Walk (Jun 13)",
    // 1:30 PM CDT → 18:30 UTC
    scheduledStartAt: new Date("2026-06-13T18:30:00.000Z"),
    trackLayout: "lava",
    inviteCode: "sponsored_sat_midday_1330_2026_06_13",
  },
  {
    title: "Saturday Evening Walk (Jun 13)",
    // 1:40 PM CDT → 18:40 UTC
    scheduledStartAt: new Date("2026-06-13T18:40:00.000Z"),
    trackLayout: "galaxy",
    inviteCode: "sponsored_sat_evening_1340_2026_06_13",
  },
  {
    title: "Saturday Late Afternoon Walk (Jun 13)",
    // 5:40 PM CDT → 22:40 UTC
    scheduledStartAt: new Date("2026-06-13T22:40:00.000Z"),
    trackLayout: "lava",
    inviteCode: "sponsored_sat_late_afternoon_1740_2026_06_13",
  },
  {
    title: "Saturday Night Walk (Jun 13)",
    // 6:00 PM CDT → 23:00 UTC
    scheduledStartAt: new Date("2026-06-13T23:00:00.000Z"),
    trackLayout: "galaxy",
    inviteCode: "sponsored_sat_night_1800_2026_06_13",
  },
];

async function main() {
  const [recent] = await db
    .select({ creatorId: raceRoomsTable.creatorId })
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.type, "sponsored"))
    .limit(1);

  if (!recent) {
    console.error("No existing sponsored events found — cannot borrow creatorId.");
    process.exit(1);
  }
  console.log("Using creatorId:", recent.creatorId);

  for (const ev of EVENTS) {
    const existing = await db
      .select({ id: raceRoomsTable.id })
      .from(raceRoomsTable)
      .where(eq(raceRoomsTable.inviteCode, ev.inviteCode))
      .limit(1);

    if (existing.length > 0) {
      console.log(`Skipping (exists): ${ev.title} → ${existing[0].id}`);
      continue;
    }

    const [inserted] = await db.insert(raceRoomsTable).values({
      creatorId: recent.creatorId,
      title: ev.title,
      type: "sponsored",
      entryType: "free",
      entryAmountCents: 0,
      targetSteps: 10000,
      maxPlayers: 10,
      status: "scheduled",
      scheduleType: "scheduled",
      scheduledStartAt: ev.scheduledStartAt,
      prizePoolCents: 1000,
      inviteCode: ev.inviteCode,
      isPrivate: false,
      trackLayout: ev.trackLayout,
    }).returning({ id: raceRoomsTable.id });

    console.log(`Created: ${ev.title} (${inserted.id}) @ ${ev.scheduledStartAt.toISOString()} — track: ${ev.trackLayout}`);
  }
  console.log("Done.");
}

main().catch((err) => { console.error(err); process.exit(1); });
