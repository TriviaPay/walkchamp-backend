import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const races = readFileSync("src/routes/races.ts", "utf8");
const upcomingTab = races.slice(
  races.indexOf('if (tab === "upcoming")'),
  races.indexOf("// ── Current tab (default)"),
);

describe("GET /api/rooms/available upcoming registration counts", () => {
  it("derives display and capacity counts from scheduled registrations", () => {
    expect(upcomingTab).toContain("const registrationCounts = upcomingRoomIds.length > 0");
    expect(upcomingTab).toContain("raceRoomId: scheduledRoomRegistrationsTable.raceRoomId");
    expect(upcomingTab).toContain("count: sql<number>`count(*)::int`");
    expect(upcomingTab).toContain('inArray(scheduledRoomRegistrationsTable.status, ["registered", "active"])');
    expect(upcomingTab).toContain(".groupBy(scheduledRoomRegistrationsTable.raceRoomId)");
    expect(upcomingTab).toContain("const registrationCountMap = new Map");
    expect(upcomingTab).toContain("const registeredCount = registrationCountMap.get(r.id) ?? 0");
    expect(upcomingTab).toContain("registered_count: registeredCount");
    expect(upcomingTab).toContain("eligible_to_register: !registeredSet.has(r.id) && registeredCount < r.maxPlayers");
    expect(upcomingTab).not.toContain("registered_count: r.registeredCount");
    expect(upcomingTab).not.toContain("r.registeredCount < r.maxPlayers");
  });
});
