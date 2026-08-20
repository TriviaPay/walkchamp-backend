import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Source-level money-path invariants for STRICT verification (participant-funded races). The
// finalization pass is DB-heavy and tested behaviorally elsewhere; these guards fail loudly if a
// refactor reintroduces "pay a funded-race winner from provisional live progress".

const read = (p: string) => readFileSync(p, "utf8");

describe("strict verification is scoped to participant-funded (real-money) races", () => {
  it("forces strict for ANY funded race — no env flag can turn it off (F-12)", () => {
    const races = read("src/routes/races.ts");
    expect(races).toContain("const strictRace = useHybrid && room.entryAmountCents > 0");
    // The old gate let strictEnabled (default false) disarm the hold on a default prod env.
    expect(races).not.toContain("strictEnabled && room.entryAmountCents");
  });

  it("refuses to boot a production cash deployment without the reconciliation pass (F-12)", () => {
    const cfg = read("src/lib/config.ts");
    expect(cfg).toContain(
      "ENABLE_HYBRID_RECONCILIATION=true is required when cash features are enabled in production",
    );
  });

  it("forwards the hybrid flags to the deployed container, defaulted ON (F-12)", () => {
    const compose = read("docker-compose.coolify.yml");
    expect(compose).toContain("ENABLE_HYBRID_RECONCILIATION: ${ENABLE_HYBRID_RECONCILIATION:-true}");
    expect(compose).toContain(
      "HYBRID_REQUIRE_VERIFICATION_FOR_PAYOUT: ${HYBRID_REQUIRE_VERIFICATION_FOR_PAYOUT:-true}",
    );
  });
});

describe("a funded race is HELD, never settled on live, when verification is missing", () => {
  const races = read("src/routes/races.ts");
  it("holds for review and returns instead of finalizing on live", () => {
    // The strict branch must NOT fall through to the live-fallback finalize used by non-strict races.
    expect(races).toContain('reconciliationReasonCodes: ["verification_missing", "held_for_review"]');
    // Selective hold: a held participant who could reach a paid slot blocks the whole settlement.
    expect(races).toContain("could affect a paid slot; awaiting ops decision");
    expect(races).toContain('settlementStatus: "review_required"');
  });
  it("pays verified winners when held participants are provably out of the money", () => {
    expect(races).toContain("held participants are out of the money, paying verified winners");
    expect(races).toContain('settlementStatus: "partially_verified"');
  });
  it("only the non-strict branch may fall back to the capped live total", () => {
    // The fallback-to-live write is reason-coded and reachable only after the strict branch `continue`s.
    expect(races).toContain('["verification_window_elapsed", "fallback_to_live"]');
  });
});

describe("finalization uses reconciled (never raw live) for a finalized participant", () => {
  it("authoritativeSteps returns reconciledSteps only when reconciliation is finalized", () => {
    const races = read("src/routes/races.ts");
    expect(races).toContain('p.reconciliationStatus === "finalized" && p.reconciledSteps != null');
  });
});

describe("only the backend issues the final decision (ops resolution endpoint exists)", () => {
  const races = read("src/routes/races.ts");
  it("exposes an admin-key-guarded approve/reject/resync endpoint", () => {
    expect(races).toContain('router.post("/races/:id/verification-resolve", requireAuth, requireAdminKey');
    expect(races).toContain('z.enum(["approve", "reject", "resync"])');
  });
  it("re-attempts completion after a decision so a resolved race can settle", () => {
    expect(races).toContain('autoCompleteRace(raceId, "verification_resolved")');
  });
  it("bounds an ops approval by serverCap so it cannot displace an already-paid winner", () => {
    expect(races).toContain("const serverCap = participant.currentSteps + config.hybridReconciliation.absoluteToleranceSteps");
    expect(races).toContain("const finalSteps = Math.min(requested, serverCap)");
  });
});

describe("server-controlled absent-verification policy", () => {
  it("config exposes the three-value policy enum, derived (not client-chosen)", () => {
    const cfg = read("src/lib/config.ts");
    expect(cfg).toContain('ABSENT_VERIFICATION_POLICY: z.enum(["strict_hold", "pragmatic_fallback", "strict_cash_only"])');
    expect(cfg).toContain("absentVerificationPolicy");
    expect(cfg).toContain('strictEnabled: absentVerificationPolicy !== "pragmatic_fallback"');
  });
});

describe("durable verification-decision audit", () => {
  it("writes a system audit row on hold and an ops audit row on approve/reject", () => {
    const races = read("src/routes/races.ts");
    expect(races).toContain("writeVerificationAudit");
    expect(races).toContain('decision: "held"');
    expect(races).toContain('decision: "approved_manually"');
    expect(races).toContain('decision: "rejected"');
    expect(races).toContain('decidedBy: "operations"');
  });
});

describe("frontend-authoritative result status", () => {
  it("exposes GET result-status returning final fields only when finalized", () => {
    const races = read("src/routes/races.ts");
    expect(races).toContain('router.get("/races/:id/result-status"');
    expect(races).toContain("const finalized = recon === \"finalized\" && room.status === \"completed\" && result != null");
    expect(races).toContain("liveSteps: participant.currentSteps");
  });
});
