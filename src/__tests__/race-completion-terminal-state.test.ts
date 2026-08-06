import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getWinnerSlotCount } from "../lib/raceSettlement.js";
import { isSettlementPending } from "../routes/races.js";

// A cash race with hybrid strict verification used to sit at status=in_progress — showing as
// LIVE at 105/100 — for the whole grace window, because autoCompleteRace returned early while
// awaiting verification and BOTH the payout and the only `status: "completed"` write lived past
// that return. These guard the split: winner slots ending the race, verification gating only
// the payout.

const races = readFileSync("src/routes/races.ts", "utf8");

describe("winner slot rules (unchanged)", () => {
  it("2 -> 1 winner, 3 -> 2, 4..10 -> 3", () => {
    expect(getWinnerSlotCount(2)).toBe(1);
    expect(getWinnerSlotCount(3)).toBe(2);
    for (const n of [4, 5, 6, 7, 8, 9, 10]) {
      expect(getWinnerSlotCount(n)).toBe(3);
    }
  });

  it("a 2-player race needs only ONE finisher", () => {
    // Explicitly guards "do not require the 2nd player to finish when only 1 slot exists".
    const finishedCount = 1;
    expect(finishedCount >= getWinnerSlotCount(2)).toBe(true);
  });

  it("completion is driven by finishedCount >= winnerSlotCount", () => {
    expect(races).toContain("finishedCount >= winnersNeeded");
    expect(races).toContain("getWinnerSlotCount(");
  });

  it("still ends on the 24h cap when nobody finishes", () => {
    expect(races).toContain("FIXED_RACE_MAX_DURATION_MS");
    expect(races).toContain("race_duration_expired");
  });
});

describe("settlement-pending is a terminal-but-unpaid state", () => {
  it("classifies only the two deferred states as pending", () => {
    expect(isSettlementPending("awaiting_verification")).toBe(true);
    expect(isSettlementPending("review_required")).toBe(true);
    // Settled and unknown states must NOT re-open the payout compare-and-swap.
    expect(isSettlementPending("paid")).toBe(false);
    expect(isSettlementPending("partially_verified")).toBe(false);
    expect(isSettlementPending(null)).toBe(false);
    expect(isSettlementPending(undefined)).toBe(false);
  });
});

describe("a deferred cash race leaves the live state", () => {
  it("marks the room terminal at the grace-window deferral instead of returning live", () => {
    const fn = races.slice(races.indexOf("export async function autoCompleteRace"));
    const graceBlock = fn.slice(fn.indexOf("if (anyPendingInGrace)"), fn.indexOf("if (anyPendingInGrace)") + 600);
    expect(graceBlock).toContain('markRoomTerminalPendingSettlement(raceId, "awaiting_verification"');
  });

  it("marks the room terminal at the ops review hold too", () => {
    const fn = races.slice(races.indexOf("export async function autoCompleteRace"));
    const heldBlock = fn.slice(fn.indexOf("if (contested)"), fn.indexOf("if (contested)") + 600);
    expect(heldBlock).toContain('markRoomTerminalPendingSettlement(raceId, "review_required"');
  });

  it("sets status=completed while preserving the pending settlement marker", () => {
    const helper = races.slice(
      races.indexOf("async function markRoomTerminalPendingSettlement"),
      races.indexOf("export async function autoCompleteRace"),
    );
    expect(helper).toContain('status: "completed"');
    expect(helper).toContain("settlementStatus,");
    // Only claims a live race — never re-stamps a room that already settled.
    expect(helper).toContain('eq(raceRoomsTable.status, "in_progress")');
  });
});

describe("the payout can still run after the race went terminal", () => {
  it("re-enters autoCompleteRace for a completed-but-unsettled room", () => {
    const fn = races.slice(races.indexOf("export async function autoCompleteRace"));
    const guard = fn.slice(0, fn.indexOf("const durationCompletion"));
    expect(guard).toContain("reEnteringForSettlement");
    expect(guard).toContain("isSettlementPending(room.settlementStatus)");
    // The old unconditional bail would have stranded every deferred payout.
    expect(guard).not.toContain('if (!room || room.status !== "in_progress") return;');
  });

  it("the payout compare-and-swap accepts in_progress OR completed-and-pending", () => {
    const cas = races.slice(races.indexOf("// ── Step 1: Mark the race completed"));
    expect(cas).toContain('eq(raceRoomsTable.status, "in_progress")');
    expect(cas).toContain('eq(raceRoomsTable.status, "completed")');
    expect(cas).toContain("PENDING_SETTLEMENT_STATUSES");
  });

  it("does not backdate the race end time to the payout time", () => {
    const cas = races.slice(races.indexOf("// ── Step 1: Mark the race completed"));
    expect(cas).toContain("coalesce(${raceRoomsTable.completedAt}");
  });

  it("sweeps deferred payouts ahead of the idle fast-path gate", () => {
    // A completed-pending room is not an "active race", so running the sweep after the
    // activeRaceCount() gate would never pay it out on an otherwise idle server.
    const cleanup = races.slice(
      races.indexOf("export async function cleanupOverdueRaces"),
      races.indexOf("// ── Feature flags"),
    );
    const sweepAt = cleanup.indexOf("await resettlePendingRaces()");
    const gateAt = cleanup.indexOf("activeRaceCount()");
    expect(sweepAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(-1);
    expect(sweepAt).toBeLessThan(gateAt);
  });

  it("only auto-retries awaiting_verification, leaving ops holds to /verification-resolve", () => {
    const sweep = races.slice(
      races.indexOf("export async function resettlePendingRaces"),
      races.indexOf("export async function cleanupOverdueRaces"),
    );
    expect(sweep).toContain('eq(raceRoomsTable.settlementStatus, "awaiting_verification")');
    expect(sweep).not.toContain('"review_required"');
  });
});

describe("POST /races/:id/verify re-kicks a deferred settlement", () => {
  const verify = races.slice(
    races.indexOf('router.post("/races/:id/verify"'),
    races.indexOf("// ── GET /api/races/:id/result-status"),
  );

  it("re-enters autoCompleteRace when settlement is owed", () => {
    expect(verify).toContain("if (awaitingSettlement)");
    expect(verify).toContain('autoCompleteRace(raceId, "verification_received")');
  });

  it("keeps accepting verification for as long as settlement is pending", () => {
    // The room flips to completed as soon as winner slots fill, so the short post-completion
    // window would otherwise reject the very verification the grace window waits hours for.
    expect(verify).toContain("const awaitingSettlement = isSettlementPending(room.settlementStatus)");
    expect(verify).toContain("&& !awaitingSettlement");
  });
});
