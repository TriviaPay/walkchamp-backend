import { db } from "@db";
import { raceRoomsTable } from "@db/schema";
import { eq } from "drizzle-orm";

async function run() {
  const rows = await db.select({ id: raceRoomsTable.id, title: raceRoomsTable.title, status: raceRoomsTable.status, scheduledStartAt: raceRoomsTable.scheduledStartAt, inviteCode: raceRoomsTable.inviteCode })
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.type, "sponsored"));
  for (const r of rows) console.log(r.status, r.scheduledStartAt?.toISOString(), r.title, r.inviteCode);
}
run().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
