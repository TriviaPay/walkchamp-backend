import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Guards for the all-forfeit completion path: an all-quit race (including multi-day duration
// challenges) must never stay stuck LIVE. The finalization is DB-heavy and tested behaviorally
// elsewhere; these assert the invariants at the source level so a refactor can't silently reintroduce
// the "duration challenge stuck LIVE after everyone quits" bug.

const races = readFileSync("src/routes/races.ts", "utf8");

describe("all_forfeited bypasses the duration end-date wait", () => {
  it("defines a FORCED_COMPLETION_REASONS set that includes all_forfeited", () => {
    expect(races).toContain('"all_forfeited"');
    expect(races).toMatch(/const FORCED_COMPLETION_REASONS = new Set\(\[/);
  });
  it("the duration guard honors FORCED_COMPLETION_REASONS (not just manual)", () => {
    expect(races).toContain("if (FORCED_COMPLETION_REASONS.has(endedReason)) return { allowed: true");
  });
  it("the completion UPDATE guard honors FORCED_COMPLETION_REASONS", () => {
    expect(races).toContain("const completionAllowedSql = FORCED_COMPLETION_REASONS.has(endedReason)");
  });
});

describe("forfeit auto-completes when nobody is left racing", () => {
  it("the /leave forfeit path completes with all_forfeited when active count hits zero", () => {
    expect(races).toContain('autoCompleteRace(raceId, "all_forfeited")');
  });
  it("emits a per-user race:participant-forfeited event on each quit", () => {
    expect(races).toContain('"race:participant-forfeited"');
  });
  it("a forfeit never refunds (post-start refund rules unchanged)", () => {
    expect(races).toContain('refund: { eligible: false, type: "none"');
  });
});

describe("recovery net completes an all-forfeit duration challenge early", () => {
  it("detects zero remaining participants and completes instead of waiting for the end date", () => {
    expect(races).toContain("duration challenge — all forfeited, completing");
    expect(races).toContain('autoCompleteRace(race.id, "all_forfeited")');
  });
});
