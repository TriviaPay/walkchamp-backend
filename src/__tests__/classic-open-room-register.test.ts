import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const races = readFileSync("src/routes/races.ts", "utf8");
const registerRoute = races.slice(
  races.indexOf('router.post("/rooms/:roomId/register"'),
  races.indexOf("// ── POST /api/rooms/:roomId/cancel-registration"),
);

describe("POST /api/rooms/:roomId/register open waiting room handling", () => {
  it("does not report registration closed for joinable open/full rooms", () => {
    expect(registerRoute).toContain('if (room.status === "open" || room.status === "full")');
    expect(registerRoute).toContain("room.roomExpiresAt && Date.now() >= room.roomExpiresAt.getTime()");
    expect(registerRoute).toContain('code: "waiting_room_expired"');
    expect(registerRoute).toContain("room.currentPlayers >= room.maxPlayers");
    expect(registerRoute).toContain('code: "room_full"');
    expect(registerRoute).toContain('code: "open_room_join_required"');
    expect(registerRoute).toContain("joinEndpoint: room.entryType === \"coins_battle\"");
    expect(registerRoute).toContain('`/api/coins-battle/${room.id}/join`');
    expect(registerRoute).toContain('`/api/races/${room.id}/join-paid`');
    expect(registerRoute).toContain('`/api/races/${room.id}/join`');
  });

  it("keeps scheduled registration as the only /register write path", () => {
    expect(registerRoute).toContain('if (room.status !== "scheduled")');
    expect(registerRoute).toContain('code: "registration_closed"');
    expect(registerRoute).toContain("registerOrReviveScheduledRegistration(tx, roomId, userId)");
  });
});
