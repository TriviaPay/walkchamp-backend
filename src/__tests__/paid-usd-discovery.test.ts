import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Regression guard: cash challenges are created as `paid_usd`, but every discovery path
// once listed only the legacy paid_1/paid_3/paid_5 tiers. Rooms existed and were joinable
// by id, yet never appeared in any list and never produced a challenge card — so the Cash
// Prize card could not reach a Join state. The legacy tiers have never had a single room.

const races = readFileSync("src/routes/races.ts", "utf8");

/** Slice out `getChallengeCardsForUser`, which drives the Walk page cards. */
const cardsFn = races.slice(
  races.indexOf("export async function getChallengeCardsForUser"),
  races.indexOf("export async function getRoomCountsSummary"),
);

describe("paid_usd is discoverable", () => {
  it("challenge cards are built for paid_usd", () => {
    expect(cardsFn).toContain('"paid_usd"');
    const entryTypes = /const entryTypes = \[([^\]]+)\]/.exec(cardsFn)?.[1] ?? "";
    expect(entryTypes).toContain("paid_usd");
  });

  it("the count aggregation and countsMap agree on the entry types", () => {
    // countsMap is indexed as countsMap[row.entryType].open — any type accepted by the
    // inArray filter but missing from countsMap is a TypeError at request time.
    const inArrayTypes = /inArray\(raceRoomsTable\.entryType, \[([^\]]+)\]\)/.exec(cardsFn)?.[1] ?? "";
    const filtered = [...inArrayTypes.matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1]);
    expect(filtered).toContain("paid_usd");

    const countsMapBlock = cardsFn.slice(
      cardsFn.indexOf("const countsMap"),
      cardsFn.indexOf("for (const row of rawCounts)"),
    );
    for (const entryType of filtered) {
      expect(countsMapBlock).toContain(`${entryType}: { open: 0, in_progress: 0 }`);
    }
  });

  it("cards carry the room's entry amount so a custom-amount room can be priced", () => {
    // paid_usd rooms have a per-room amount rather than a fixed tier, so the client
    // cannot infer the fee from the entry type alone.
    expect(cardsFn).toContain("entryAmountCents: raceRoomsTable.entryAmountCents");
    expect(cardsFn).toContain("entryAmountCents: room.entryAmountCents");
    expect(cardsFn).toContain("entryAmountCents: best.entryAmountCents");
  });

  it("the instant-rooms filter includes paid_usd in `all` and offers a cash bucket", () => {
    const map = races.slice(
      races.indexOf("const filterToEntryTypes"),
      races.indexOf("const orderCol"),
    );
    expect(map).toContain("paid_usd");
    expect(/all: \[[^\]]*"paid_usd"/.test(map)).toBe(true);
    expect(map).toContain('cash: ["paid_usd"]');
  });

  it("GET /races can filter to cash rooms", () => {
    expect(races).toContain('filter === "cash" || filter === "usd" || filter === "paid_usd"');
  });
});
