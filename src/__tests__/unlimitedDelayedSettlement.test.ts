import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { computeParticipantSchedule } from "../lib/challengeDayWindow.js";

const read = (p: string) => readFileSync(p, "utf8");

// An Unlimited challenge must produce NO final result until every participant in the settlement
// population has passed their own local end and every required day is verified. Host finishing,
// first participant finishing, or the challenge's host-derived end are all insufficient.

const mocks = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn() }));
vi.mock("../../db/src/index.js", () => ({ db: { select: mocks.select, update: mocks.update } }));

const {
  areAllParticipantWindowsClosed,
  areAllRequiredDaysTerminal,
  deriveResultsState,
  evaluateParticipantEligibility,
  toDayStatus,
  TERMINAL_DAY_STATUSES,
  NON_TERMINAL_DAY_STATUSES,
} = await import("../lib/unlimitedResults.js");

/** Queue up successive db.select() results; each call shifts one off. */
function stubSelects(...results: unknown[][]) {
  const queue = [...results];
  mocks.select.mockImplementation(() => {
    const rows = queue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.innerJoin = () => chain;
    chain.leftJoin = () => chain;
    chain.limit = async () => rows;
    chain.groupBy = async () => rows;
    chain.where = Object.assign(async () => rows, {}) as unknown;
    // `where` must be awaitable AND chainable into limit/groupBy.
    chain.where = () => Object.assign(Promise.resolve(rows), {
      limit: async () => rows,
      groupBy: async () => rows,
    });
    return chain;
  });
}

beforeEach(() => {
  mocks.select.mockReset();
  mocks.update.mockReset();
});

const DATE = "2026-08-09";
const india = computeParticipantSchedule({ startLocalDate: DATE, timezone: "Asia/Kolkata", durationDays: 7, goalSteps: 10000 });
const chicago = computeParticipantSchedule({ startLocalDate: DATE, timezone: "America/Chicago", durationDays: 7, goalSteps: 10000 });
const california = computeParticipantSchedule({ startLocalDate: DATE, timezone: "America/Los_Angeles", durationDays: 7, goalSteps: 10000 });

describe("§3 the wait runs to the LAST local end, not the first", () => {
  it("three timezones end at three different UTC instants", () => {
    expect(india.endAtUtc.toISOString()).toBe("2026-08-15T18:30:00.000Z");
    expect(chicago.endAtUtc.toISOString()).toBe("2026-08-16T05:00:00.000Z");
    expect(california.endAtUtc.toISOString()).toBe("2026-08-16T07:00:00.000Z");
    // California is last, so nothing may finalize before it.
    expect(california.endAtUtc.getTime()).toBeGreaterThan(chicago.endAtUtc.getTime());
    expect(chicago.endAtUtc.getTime()).toBeGreaterThan(india.endAtUtc.getTime());
  });

  it("is not closed while one participant is still inside their window", async () => {
    // India and Chicago done; California still walking.
    stubSelects([{ registered: 3, finished: 2, latestEnd: california.endAtUtc, unresolved: 0 }]);
    const state = await areAllParticipantWindowsClosed("ch-1", chicago.endAtUtc);

    expect(state.allClosed).toBe(false);
    expect(state.registeredParticipantCount).toBe(3);
    expect(state.participantsFinishedCount).toBe(2);
    expect(state.participantsPendingCount).toBe(1);
    expect(state.latestParticipantEndAtUtc?.toISOString()).toBe(california.endAtUtc.toISOString());
  });

  it("is closed only once the last participant's end has passed", async () => {
    stubSelects([{ registered: 3, finished: 3, latestEnd: california.endAtUtc, unresolved: 0 }]);
    const state = await areAllParticipantWindowsClosed("ch-1", california.endAtUtc);
    expect(state.allClosed).toBe(true);
    expect(state.participantsPendingCount).toBe(0);
  });

  it("treats an unresolvable end as PENDING, never as finished", async () => {
    // A membership with no computed end is not evidence the challenge is over.
    stubSelects([{ registered: 3, finished: 2, latestEnd: chicago.endAtUtc, unresolved: 1 }]);
    const state = await areAllParticipantWindowsClosed("ch-1", california.endAtUtc);
    expect(state.allClosed).toBe(false);
  });

  it("never reports an empty population as closed", async () => {
    stubSelects([{ registered: 0, finished: 0, latestEnd: null, unresolved: 0 }]);
    const state = await areAllParticipantWindowsClosed("ch-1");
    expect(state.allClosed).toBe(false);
  });
});

describe("§5–§9 results status lifecycle", () => {
  const base = { id: "ch-1", status: "active", settlementStatus: null, resultsStatus: "in_progress" };

  it("in_progress while nobody has finished", async () => {
    stubSelects([{ registered: 3, finished: 0, latestEnd: california.endAtUtc, unresolved: 0 }]);
    const s = await deriveResultsState(base, india.startAtUtc);
    expect(s.resultsStatus).toBe("in_progress");
  });

  it("waiting_for_participants once some have finished but others have not", async () => {
    stubSelects([{ registered: 3, finished: 2, latestEnd: california.endAtUtc, unresolved: 0 }]);
    const s = await deriveResultsState(base, chicago.endAtUtc);
    expect(s.resultsStatus).toBe("waiting_for_participants");
    expect(s.participantsPendingCount).toBe(1);
  });

  it("steps_validation_in_progress once all windows close but days remain unverified", async () => {
    stubSelects(
      [{ registered: 3, finished: 3, latestEnd: california.endAtUtc, unresolved: 0 }],
      [{ participantId: "p-1", pending: 2 }],
    );
    const s = await deriveResultsState(base, california.endAtUtc);
    expect(s.resultsStatus).toBe("steps_validation_in_progress");
    expect(s.pendingDayCount).toBe(2);
    expect(s.participantsAwaitingValidation).toBe(1);
  });

  it("does NOT reach results_ready from the clock alone — settlement owns that", async () => {
    stubSelects(
      [{ registered: 3, finished: 3, latestEnd: california.endAtUtc, unresolved: 0 }],
      [], // every day terminal
    );
    const s = await deriveResultsState(base, new Date("2026-09-01T00:00:00Z"));
    // All windows closed AND all days terminal — still not ready, because no payout is committed.
    expect(s.resultsStatus).toBe("steps_validation_in_progress");
  });

  it("a settled challenge reports results_ready", async () => {
    stubSelects([{ registered: 3, finished: 3, latestEnd: california.endAtUtc, unresolved: 0 }]);
    const s = await deriveResultsState({ ...base, status: "completed" }, california.endAtUtc);
    expect(s.resultsStatus).toBe("results_ready");
  });
});

describe("§22 terminal day vocabulary", () => {
  it("only passed and failed are terminal", () => {
    expect([...TERMINAL_DAY_STATUSES]).toEqual(["passed", "failed"]);
    expect([...NON_TERMINAL_DAY_STATUSES]).toEqual(["pending", "in_progress", "pending_verification"]);
  });

  it("counts unverified days across the settlement population", async () => {
    stubSelects([{ participantId: "p-1", pending: 3 }, { participantId: "p-2", pending: 1 }]);
    const v = await areAllRequiredDaysTerminal("ch-1");
    expect(v.allDaysTerminal).toBe(false);
    expect(v.pendingDayCount).toBe(4);
    expect(v.participantsAwaitingValidation).toBe(2);
  });

  it("is satisfied when nothing is pending", async () => {
    stubSelects([]);
    const v = await areAllRequiredDaysTerminal("ch-1");
    expect(v.allDaysTerminal).toBe(true);
    expect(v.pendingDayCount).toBe(0);
  });
});

describe("§14 client-facing day status", () => {
  const start = chicago.windows[2].windowStartUtc;
  const end = chicago.windows[2].windowEndUtc;

  it("upcoming before the window opens", () => {
    expect(toDayStatus("pending", start, end, new Date(start.getTime() - 3_600_000))).toBe("upcoming");
  });

  it("in_progress inside the window", () => {
    expect(toDayStatus("pending", start, end, new Date(start.getTime() + 3_600_000))).toBe("in_progress");
    expect(toDayStatus("in_progress", start, end, new Date(start.getTime() + 3_600_000))).toBe("in_progress");
  });

  it("validation_pending after the window closes but before finalization", () => {
    expect(toDayStatus("in_progress", start, end, new Date(end.getTime() + 60_000))).toBe("validation_pending");
    expect(toDayStatus("pending_verification", start, end, new Date(end.getTime() + 60_000))).toBe("validation_pending");
  });

  it("terminal states ignore the clock", () => {
    const beforeStart = new Date(start.getTime() - 86_400_000);
    expect(toDayStatus("passed", start, end, beforeStart)).toBe("passed");
    expect(toDayStatus("failed", start, end, beforeStart)).toBe("failed");
  });
});

describe("§11/§18 eligibility is per-day, never a step total", () => {
  /** participants query, then the day aggregate query. */
  function stubEligibility(participants: unknown[], dayAgg: unknown[]) {
    stubSelects(participants, dayAgg);
  }

  const active = { participantId: "p-1", userId: "u-1", qualificationStatus: "active", disqualificationReason: null, inPopulation: true };

  it("eligible only when every required day passed", async () => {
    stubEligibility([active], [{ participantId: "p-1", passed: 7, failed: 0, pending: 0 }]);
    const [r] = await evaluateParticipantEligibility("ch-1", 7);
    expect(r.status).toBe("eligible");
    expect(r.reasonCode).toBe("all_days_passed");
  });

  it("one failed day is terminal — later big days cannot repay it", async () => {
    // The §11 worked example: 6 days passed, day 4 failed at 9,999 against a 10,000 goal.
    stubEligibility([active], [{ participantId: "p-1", passed: 6, failed: 1, pending: 0 }]);
    const [r] = await evaluateParticipantEligibility("ch-1", 7);
    expect(r.status).toBe("not_eligible");
    expect(r.reasonCode).toBe("daily_goal_missed");
    expect(r.passedDays).toBe(6);
    expect(r.failedDays).toBe(1);
  });

  it("100,000 total steps with one short day is still not eligible", async () => {
    // §18: eligibility never looks at a challenge-wide step total.
    stubEligibility([active], [{ participantId: "p-1", passed: 6, failed: 1, pending: 0 }]);
    const [r] = await evaluateParticipantEligibility("ch-1", 7);
    expect(r.status).toBe("not_eligible");
    const results = read("src/lib/unlimitedResults.ts");
    expect(results).not.toContain("totalChallengeSteps");
    expect(results).not.toContain("sum(");
  });

  it("stays pending while any day is still verifying", async () => {
    stubEligibility([active], [{ participantId: "p-1", passed: 6, failed: 0, pending: 1 }]);
    const [r] = await evaluateParticipantEligibility("ch-1", 7);
    expect(r.status).toBe("pending");
    expect(r.reasonCode).toBeNull();
  });

  it("a short record is not eligible — an unproven day is not a passed day", async () => {
    stubEligibility([active], [{ participantId: "p-1", passed: 6, failed: 0, pending: 0 }]);
    const [r] = await evaluateParticipantEligibility("ch-1", 7);
    expect(r.status).toBe("not_eligible");
    expect(r.reasonCode).toBe("verification_failed");
  });

  it("leaving and being outside the population are not_eligible", async () => {
    stubEligibility(
      [{ ...active, qualificationStatus: "left" }],
      [{ participantId: "p-1", passed: 7, failed: 0, pending: 0 }],
    );
    const [r] = await evaluateParticipantEligibility("ch-1", 7);
    expect(r.status).toBe("not_eligible");
    expect(r.reasonCode).toBe("left_challenge");
  });

  it("keeps the recorded disqualification reason", async () => {
    stubEligibility(
      [{ ...active, qualificationStatus: "disqualified", disqualificationReason: "simulation" }],
      [{ participantId: "p-1", passed: 3, failed: 0, pending: 0 }],
    );
    const [r] = await evaluateParticipantEligibility("ch-1", 7);
    expect(r.status).toBe("not_eligible");
    expect(r.reasonCode).toBe("simulation");
  });
});

// ── Wiring guards ────────────────────────────────────────────────────────────

describe("settlement is gated on the delayed-global rule", () => {
  const settle = read("src/lib/unlimitedChallengeSettlement.ts");

  it("never finalizes from a host-derived end", () => {
    expect(settle).toContain("areAllParticipantWindowsClosed(challengeId)");
    // §4 — the host's own end and the challenge's host-derived end are not finalization triggers.
    expect(settle).not.toContain("challengeEndAtUtc");
    expect(settle).not.toContain("hostEndAt");
  });

  it("publishes results_ready only after payouts commit", () => {
    const readyAt = settle.indexOf("markResultsReady");
    const creditAt = settle.indexOf("creditCashChallengePrizes");
    expect(readyAt).toBeGreaterThan(-1);
    expect(creditAt).toBeLessThan(settle.lastIndexOf("markResultsReady"));
    // Every terminal branch publishes: split, refund-all, and manual-review.
    expect(settle.split("markResultsReady(").length - 1).toBe(3);
  });

  it("records explicit eligibility for every membership before splitting", () => {
    expect(settle).toContain("await persistEligibility(eligibility)");
    // Compare against the call site, not the import line at the top of the file.
    expect(settle.indexOf("await persistEligibility(eligibility)")).toBeLessThan(
      settle.indexOf("computeEqualSplit(pre.prizePoolCents"),
    );
  });

  it("refreshes the result status when it defers", () => {
    expect(settle.split("refreshUnlimitedResultsStatus(challengeId)").length - 1).toBe(2);
  });
});

describe("results status is driven and frozen correctly", () => {
  const results = read("src/lib/unlimitedResults.ts");
  const jobs = read("src/lib/unlimitedChallengeJobs.ts");

  it("the reconciler advances the lifecycle every tick", () => {
    expect(jobs).toContain("refreshUnlimitedResultsStatus(c.id, now)");
    expect(jobs).toContain('ne(unlimitedChallengesTable.resultsStatus, "results_ready")');
  });

  it("transitions are compare-and-set so a duplicate tick cannot double-emit", () => {
    expect(results).toContain("eq(unlimitedChallengesTable.resultsStatus, challenge.resultsStatus)");
    expect(results).toContain('ne(unlimitedChallengesTable.resultsStatus, "results_ready")');
    expect(results).toContain("if (!changed) return false; // already published");
  });

  it("never walks a published result backwards", () => {
    expect(results).toContain('if (challenge.resultsStatus === "results_ready") return null');
    expect(results).toContain('if (state.resultsStatus === "results_ready") return state; // owned by markResultsReady');
  });

  it("§2 freezes the settlement population at start, excluding leavers", () => {
    expect(jobs).toContain("captureSettlementPopulation(challengeId)");
    expect(results).toContain('eq(unlimitedChallengeParticipantsTable.qualificationStatus, "left")');
    expect(results).toContain("settlementPopulationSize: population");
    // Ghost host has no participant row at all, so it can never enter the population.
    expect(results).toContain("Ghost hosts never appear here");
  });
});

describe("§19/§20 losing eligibility does not stop history or settle early", () => {
  const jobs = read("src/lib/unlimitedChallengeJobs.ts");
  const ingest = read("src/lib/unlimitedStepIngest.ts");

  it("later days keep being credited after a failed day", () => {
    // Neither the ingest nor the finalizer filters by participant qualification status, so days
    // 5..N still record for someone who failed day 4.
    expect(ingest).not.toContain("qualificationStatus");
    const finalize = jobs.slice(jobs.indexOf("export async function finalizeUnlimitedDays"), jobs.indexOf("async function getVerifiedSteps"));
    expect(finalize).not.toContain("ne(unlimitedChallengeParticipantsTable.qualificationStatus");
  });

  it("the first failed day disqualifies once and is not re-applied", () => {
    expect(jobs).toContain('inArray(unlimitedChallengeParticipantsTable.qualificationStatus, ["active", "goal_completed_today", "pending_verification"])');
  });

  it("an early loss never publishes the challenge result", () => {
    const settle = read("src/lib/unlimitedChallengeSettlement.ts");
    // markResultsReady is only reachable after both gates.
    expect(settle.indexOf("areAllParticipantWindowsClosed")).toBeLessThan(settle.indexOf("markResultsReady"));
    expect(settle.indexOf("areAllRequiredDaysTerminal")).toBeLessThan(settle.indexOf("markResultsReady"));
  });
});

describe("§12/§15 daily history API", () => {
  const route = read("src/routes/unlimitedChallenge.ts");
  const history = route.slice(
    route.indexOf('router.get("/unlimited-challenges/:id/daily-history"'),
    route.indexOf("// Chat: comments + reactions"),
  );

  it("returns every required day ordered, with the participant's calendar date", () => {
    expect(history).toContain("orderBy(asc(unlimitedChallengeDaysTable.dayNumber))");
    expect(history).toContain("participantLocalDate: d.localDate");
    expect(history).toContain("participantTimezone: d.timezone");
    expect(history).toContain("windowStartUtc: d.windowStartUtc");
    expect(history).toContain("windowEndUtc: d.windowEndUtc");
  });

  it("carries the §13 record fields", () => {
    for (const field of [
      "dayIndex", "dailyGoalSteps", "verifiedSteps", "verificationSource", "verificationStatus",
      "dayStatus", "createdAt", "updatedAt", "finalizedAt",
    ]) {
      expect(history).toContain(`${field}:`);
    }
  });

  it("maps stored statuses onto the client vocabulary", () => {
    expect(history).toContain("toDayStatus(d.status, d.windowStartUtc, d.windowEndUtc, now)");
  });

  it("reports passed/failed/pending counts so a lost run still shows its history", () => {
    expect(history).toContain("passedDays: days.filter");
    expect(history).toContain("failedDays: days.filter");
    expect(history).toContain("prizePoolEligibilityStatus: participant.prizePoolEligibilityStatus");
  });
});

describe("API exposes the result lifecycle without leaking anti-cheat detail", () => {
  const route = read("src/routes/unlimitedChallenge.ts");
  const progress = read("src/lib/unlimitedLiveProgress.ts");

  it("serializes resultsStatus and the §7 counters", () => {
    expect(route).toContain("resultsStatus: c.resultsStatus");
    expect(route).toContain("registeredParticipantCount: closure.registeredParticipantCount");
    expect(route).toContain("participantsFinishedCount: closure.participantsFinishedCount");
    expect(route).toContain("participantsPendingCount: closure.participantsPendingCount");
  });

  it("coarsens verification and simulation reasons on public boards", () => {
    expect(progress).toContain("export function publicEligibilityReason");
    expect(progress).toContain('return "not_qualified"');
    expect(route).toContain("publicEligibilityReason(r.eligibilityReasonCode)");
  });
});

describe("migration 0029 is additive and preserves finished history", () => {
  const sql = read("db/migrations/0029_unlimited_delayed_global_settlement.sql");

  it("adds defaulted columns only", () => {
    expect(sql).toContain(`ADD COLUMN IF NOT EXISTS "results_status" text DEFAULT 'in_progress' NOT NULL`);
    expect(sql).toContain(`ADD COLUMN IF NOT EXISTS "prize_pool_eligibility_status" text DEFAULT 'pending' NOT NULL`);
    expect(sql).toContain(`ADD COLUMN IF NOT EXISTS "in_settlement_population" boolean DEFAULT true NOT NULL`);
    expect(sql).not.toMatch(/DROP\s+(COLUMN|TABLE)/i);
  });

  it("marks already-completed challenges results_ready", () => {
    // Otherwise finished history would render as though it were still being validated.
    expect(sql).toContain(`SET "results_status" = 'results_ready'`);
    expect(sql).toContain(`WHERE "status" IN ('completed', 'cancelled_by_platform')`);
  });

  it("derives past eligibility from the recorded outcome, not a fresh judgement", () => {
    expect(sql).toContain(`WHERE p."qualification_status" = 'qualified'`);
    expect(sql).toContain(`'left_challenge'`);
    expect(sql).toContain(`COALESCE(p."disqualification_reason", 'daily_goal_missed')`);
  });

  it("is registered in the journal", () => {
    expect(read("db/migrations/meta/_journal.json")).toContain("0029_unlimited_delayed_global_settlement");
  });
});

describe("Classic result logic is untouched", () => {
  it("no Unlimited result helper leaks into Classic settlement", () => {
    for (const file of ["src/lib/raceSettlement.ts", "src/routes/races.ts", "src/lib/raceReconciliation.ts"]) {
      const source = read(file);
      expect(source).not.toContain("unlimitedResults");
      expect(source).not.toContain("areAllParticipantWindowsClosed");
      expect(source).not.toContain("prizePoolEligibilityStatus");
    }
  });
});
