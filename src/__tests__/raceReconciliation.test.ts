import { describe, expect, it } from "vitest";
import {
  reconcileParticipant,
  finalizationDecision,
  isFinalizable,
  type ReconciliationTolerances,
  type RaceReconciliationResult,
} from "../lib/raceReconciliation.js";

const TOL: ReconciliationTolerances = {
  absoluteToleranceSteps: 100,
  percentTolerance: 0.03,
  reviewThresholdPercent: 0.15,
  verificationWindowMs: 10 * 60_000,
};

const RACE_END = 1_000_000;
const base = (over: Partial<Parameters<typeof reconcileParticipant>[0]>) =>
  reconcileParticipant({
    liveSteps: 10_000,
    verifiedSteps: null,
    raceEndedAtMs: RACE_END,
    nowMs: RACE_END + 1000,
    tolerances: TOL,
    ...over,
  });

describe("no verification yet", () => {
  it("within window → pending, reconciled = live, not finalized", () => {
    const r = base({ verifiedSteps: null, nowMs: RACE_END + 60_000 });
    expect(r.status).toBe("pending");
    expect(r.reconciledSteps).toBe(10_000);
    expect(r.difference).toBeNull();
  });
  it("window elapsed → verification_delayed on live, never disqualified", () => {
    const r = base({ verifiedSteps: null, nowMs: RACE_END + 11 * 60_000 });
    expect(r.status).toBe("verification_delayed");
    expect(r.reconciledSteps).toBe(10_000);
    expect(r.reasonCodes).toContain("fallback_to_live");
  });
});

describe("verified present", () => {
  it("exact match → matched", () => {
    const r = base({ verifiedSteps: 10_000 });
    expect(r.status).toBe("matched");
    expect(r.reconciledSteps).toBe(10_000);
    expect(r.difference).toBe(0);
  });
  it("small absolute delta → within_tolerance, conservative min", () => {
    const r = base({ liveSteps: 10_000, verifiedSteps: 10_080 }); // 80 ≤ 100
    expect(r.status).toBe("within_tolerance");
    expect(r.reconciledSteps).toBe(10_000);
    expect(r.reasonCodes).toContain("verified_higher");
  });
  it("small percent delta → within_tolerance", () => {
    const r = base({ liveSteps: 100_000, verifiedSteps: 102_000 }); // 2% ≤ 3%, abs 2000 > 100
    expect(r.status).toBe("within_tolerance");
    expect(r.reconciledSteps).toBe(100_000);
  });
  it("verified much higher (backfill) → review_required, keep conservative live", () => {
    const r = base({ liveSteps: 10_000, verifiedSteps: 30_000 });
    expect(r.status).toBe("review_required");
    expect(r.reconciledSteps).toBe(10_000);
    expect(r.reasonCodes).toContain("possible_backfill");
  });
  it("verified moderately lower → review_required, correct down to verified", () => {
    const r = base({ liveSteps: 10_000, verifiedSteps: 9_000 }); // 10% ≤ 15%
    expect(r.status).toBe("review_required");
    expect(r.reconciledSteps).toBe(9_000);
    expect(r.reasonCodes).toContain("auto_correct_to_verified");
  });
  it("verified much lower → review_required with manual_review reason", () => {
    const r = base({ liveSteps: 10_000, verifiedSteps: 5_000 }); // 50% > 15%
    expect(r.status).toBe("review_required");
    expect(r.reconciledSteps).toBe(5_000);
    expect(r.reasonCodes).toContain("manual_review");
  });
});

describe("invariants", () => {
  it("preserves both source values in the result", () => {
    const r = base({ liveSteps: 12_345, verifiedSteps: 12_000 });
    expect(r.liveSteps).toBe(12_345);
    expect(r.verifiedSteps).toBe(12_000);
  });
  it("is idempotent — same input yields identical output", () => {
    const input = { liveSteps: 10_000, verifiedSteps: 9_000, raceEndedAtMs: RACE_END, nowMs: RACE_END + 1000, tolerances: TOL };
    expect(reconcileParticipant(input)).toEqual(reconcileParticipant(input));
  });
  it("never emits 'finalized' (that is settlement's stamp)", () => {
    for (const verifiedSteps of [null, 10_000, 10_050, 30_000, 5_000]) {
      const r = base({ verifiedSteps, nowMs: RACE_END + 20 * 60_000 });
      expect(r.status).not.toBe("finalized");
    }
  });
});

describe("finalizationDecision (winner safety §15)", () => {
  const result = (over: Partial<RaceReconciliationResult>): RaceReconciliationResult => ({
    liveSteps: 10_000, verifiedSteps: 10_000, reconciledSteps: 10_000, difference: 0,
    differencePercent: 0, status: "matched", reasonCodes: [], reconciledAtUtc: "2026-01-01T00:00:00.000Z",
    ...over,
  });

  it("matched / within_tolerance / verification_delayed are finalizable", () => {
    expect(isFinalizable("matched")).toBe(true);
    expect(isFinalizable("within_tolerance")).toBe(true);
    expect(isFinalizable("verification_delayed")).toBe(true);
  });
  it("pending and review_required are NOT finalizable", () => {
    expect(isFinalizable("pending")).toBe(false);
    expect(isFinalizable("review_required")).toBe(false);
  });
  it("pending → defer (finalization waits for verification)", () => {
    const d = finalizationDecision(result({ status: "pending" }));
    expect(d.defer).toBe(true);
    expect(d.finalize).toBe(false);
  });
  it("matched → finalize on reconciled total (reconciled drives final result)", () => {
    const d = finalizationDecision(result({ status: "matched", reconciledSteps: 9_900 }));
    expect(d.defer).toBe(false);
    expect(d.finalize).toBe(true);
    expect(d.reconciledSteps).toBe(9_900);
  });
  it("review_required → not finalized (settle on live + flag), never auto-pays on divergence", () => {
    const d = finalizationDecision(result({ status: "review_required", reconciledSteps: 5_000 }));
    expect(d.finalize).toBe(false);
    expect(d.defer).toBe(false);
  });
  it("session conflict forces review and never finalizes (§18)", () => {
    const d = finalizationDecision(result({ status: "matched" }), { sessionConflict: true });
    expect(d.status).toBe("review_required");
    expect(d.finalize).toBe(false);
    expect(d.reasonCodes).toContain("session_conflict");
  });
});
