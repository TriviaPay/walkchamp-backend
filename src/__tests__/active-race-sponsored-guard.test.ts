import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("active race sponsored guard", () => {
  it("does not let sponsored rooms block regular challenge host or join guards", () => {
    const racesRoute = readFileSync("src/routes/races.ts", "utf8");
    const helperStart = racesRoute.indexOf("async function getActiveRaceForUser");
    const helperEnd = racesRoute.indexOf("function activeRacePayload");
    const helper = racesRoute.slice(helperStart, helperEnd);

    expect(helper).toContain('ne(raceRoomsTable.type, "sponsored")');
    expect(helper).toContain('inArray(raceRoomsTable.status, ["open", "full", "in_progress"])');
  });

  it("keeps sponsored rooms out of regular challenge cards", () => {
    const racesRoute = readFileSync("src/routes/races.ts", "utf8");
    const cardsStart = racesRoute.indexOf("export async function getChallengeCardsForUser");
    const cardsEnd = racesRoute.indexOf("router.get(\"/challenges/available\"");
    const cardsHelper = racesRoute.slice(cardsStart, cardsEnd);

    expect(cardsHelper.match(/ne\(raceRoomsTable\.type, "sponsored"\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("adds room type details to ACTIVE_RACE_EXISTS payloads", () => {
    const racesRoute = readFileSync("src/routes/races.ts", "utf8");
    const payloadStart = racesRoute.indexOf("function activeRacePayload");
    const payloadEnd = racesRoute.indexOf("// ── GET /api/races/current-active");
    const payload = racesRoute.slice(payloadStart, payloadEnd);

    expect(payload).toContain("room_type: row.type");
    expect(payload).toContain('is_sponsored: row.type === "sponsored"');
  });
});
