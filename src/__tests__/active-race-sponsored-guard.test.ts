import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("active race sponsored guard", () => {
  it("does not let sponsored rooms block regular challenge host or join guards", () => {
    const racesRoute = readFileSync("src/routes/races.ts", "utf8");
    const helperStart = racesRoute.indexOf("async function getRegularRaceRegistrationForUser");
    const helperEnd = racesRoute.indexOf("function activeRacePayload");
    const helper = racesRoute.slice(helperStart, helperEnd);

    expect(helper).toContain('ne(raceRoomsTable.type, "sponsored")');
    expect(helper).toContain('inArray(raceRoomsTable.status, ["open", "full", "in_progress"])');
    expect(helper).toContain('eq(raceRoomsTable.status, "scheduled")');
    expect(helper).toContain('eq(scheduledRoomRegistrationsTable.status, "registered")');
  });

  it("keeps sponsored rooms out of regular challenge cards", () => {
    const racesRoute = readFileSync("src/routes/races.ts", "utf8");
    const cardsStart = racesRoute.indexOf("export async function getChallengeCardsForUser");
    const cardsEnd = racesRoute.indexOf("router.get(\"/challenges/available\"");
    const cardsHelper = racesRoute.slice(cardsStart, cardsEnd);

    expect(cardsHelper.match(/ne\(raceRoomsTable\.type, "sponsored"\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("adds modal copy and room details to regular-race conflict payloads", () => {
    const racesRoute = readFileSync("src/routes/races.ts", "utf8");
    expect(racesRoute).toContain('REGULAR_RACE_REGISTRATION_EXISTS_CODE = "REGULAR_RACE_REGISTRATION_EXISTS"');
    expect(racesRoute).toContain('REGULAR_RACE_REGISTRATION_EXISTS_TITLE = "Already Registered"');
    expect(racesRoute).toContain("You are already registered for another race. Please withdraw from or complete your current race before registering for a new one.");

    const payloadStart = racesRoute.indexOf("function activeRacePayload");
    const payloadEnd = racesRoute.indexOf("// ── GET /api/races/current-active");
    const payload = racesRoute.slice(payloadStart, payloadEnd);

    expect(payload).toContain("room_type: row.type");
    expect(payload).toContain('is_sponsored: row.type === "sponsored"');
  });
});
