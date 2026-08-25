import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const races = readFileSync("src/routes/races.ts", "utf8");
const completion = races.slice(races.indexOf("export async function autoCompleteRace"));
const activation = races.slice(races.indexOf("export async function activateRoomAndStart"));
const adjudication = readFileSync("src/lib/protectedRaceAdjudication.ts", "utf8");
const coinsBattle = readFileSync("src/routes/coinsBattle.ts", "utf8");

describe("protected race lifecycle contract", () => {
  it("requires every protected participant to pass preflight before charging/start", () => {
    expect(activation.indexOf("assertProtectedRaceReadyToStart")).toBeGreaterThan(-1);
    expect(activation.indexOf("assertProtectedRaceReadyToStart")).toBeLessThan(activation.indexOf("debitCashChallengeEntry"));
  });

  it("uses a server end and blocks early protected completion", () => {
    expect(activation).toContain("serverEndAt: challengeEndAt");
    expect(completion).toContain("Date.now() < room.serverEndAt.getTime()");
  });

  it("requires finalized adjudication before standings or payout logic runs", () => {
    const gate = completion.indexOf("attemptProtectedRaceAdjudication(raceId)");
    const participantRead = completion.indexOf("const participants = await db");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(participantRead);
    expect(completion).toContain("if (!adjudication.ready)");
  });

  it("persists results in the same transaction before cash and sponsored awards", () => {
    const resultWrite = completion.indexOf("tx.insert(raceResultsTable)");
    expect(resultWrite).toBeGreaterThan(completion.indexOf("db.transaction(async (tx)"));
    expect(resultWrite).toBeLessThan(completion.indexOf("creditCashChallengePrizes(tx"));
    expect(resultWrite).toBeLessThan(completion.indexOf("createPendingSponsoredGiftCardAwards"));
  });

  it("has durable retries and a bounded void/refund path", () => {
    expect(adjudication).toContain("[0, 5, 15, 30, 60, 120, 240]");
    expect(adjudication).toContain("reviewWindowMs");
    expect(adjudication).toContain("createProtectedRaceVoidRefund");
  });

  it("marks rooms created by the dedicated Coins Battle route as protected", () => {
    expect(coinsBattle).toContain("protectedRace: true");
    expect(coinsBattle).toContain("protectedPolicySnapshot: protectedPolicy");
    expect(coinsBattle).toContain("protectedDurationMinutes");
    expect(coinsBattle).toContain("validateProtectedDuration");
  });
});
