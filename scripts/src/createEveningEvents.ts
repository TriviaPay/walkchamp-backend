import { db } from "@db";
import { raceRoomsTable } from "@db/schema";
import { eq } from "drizzle-orm";

const EVENTS = [
  {
    title: "Saturday Evening Walk — 6:15 PM (Jun 13)",
    // 6:15 PM CDT (UTC-5) → 23:15 UTC on June 13, 2026
    scheduledStartAt: new Date("2026-06-13T23:15:00.000Z"),
    trackLayout: "forest",
    inviteCode: "sponsored_sat_eve_1815_2026_06_13",
  },
  {
    title: "Saturday Evening Walk — 6:30 PM (Jun 13)",
    // 6:30 PM CDT → 23:30 UTC
    scheduledStartAt: new Date("2026-06-13T23:30:00.000Z"),
    trackLayout: "lava",
    inviteCode: "sponsored_sat_eve_1830_2026_06_13",
  },
  {
    title: "Saturday Evening Walk — 6:45 PM (Jun 13)",
    // 6:45 PM CDT → 23:45 UTC
    scheduledStartAt: new Date("2026-06-13T23:45:00.000Z"),
    trackLayout: "galaxy",
    inviteCode: "sponsored_sat_eve_1845_2026_06_13",
  },
  {
    title: "Saturday Evening Walk — 7:00 PM (Jun 13)",
    // 7:00 PM CDT → 00:00 UTC June 14
    scheduledStartAt: new Date("2026-06-14T00:00:00.000Z"),
    trackLayout: "bg",
    inviteCode: "sponsored_sat_eve_1900_2026_06_13",
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
      console.log(`Skipping (already exists): ${ev.title} → ${existing[0].id}`);
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
