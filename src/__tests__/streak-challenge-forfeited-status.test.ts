import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const service = readFileSync("src/lib/unlimitedChallengeService.ts", "utf8");
const results = readFileSync("src/lib/unlimitedResults.ts", "utf8");
const routes = readFileSync("src/routes/unlimitedChallenge.ts", "utf8");
const schedule = readFileSync("src/lib/unlimitedParticipantSchedule.ts", "utf8");

describe("Streak Challenge forfeited participant contract", () => {
  it("persists forfeiture and prize ineligibility in the same leave transaction", () => {
    expect(service).toContain('const participantStatus = preStart ? "left" as const : "forfeited" as const');
    expect(service).toContain('prizePoolEligibilityStatus: "not_eligible"');
    expect(service).toContain('eligibilityReasonCode: "left_challenge"');
    expect(service).toContain('action: preStart ? "unlimited_challenge.leave" : "unlimited_challenge.forfeit"');
  });

  it("keeps retries idempotent and emits the canonical forfeiture event only on change", () => {
    expect(service).toContain('changed: false');
    expect(service).toContain('if (result.changed)');
    expect(service).toContain('participantStatus === "forfeited" ? "participant_forfeited" : "participant_left"');
    expect(service).toContain('participantStatus === "forfeited" ? "race:participant-forfeited" : "race:player-left"');
  });

  it("retains forfeits in timing but excludes them from verification and eligibility", () => {
    const closure = results.slice(
      results.indexOf("export async function areAllParticipantWindowsClosed"),
      results.indexOf("// ── §22 Validation completion"),
    );
    expect(closure).toContain("inSettlementPopulation");
    expect(closure).not.toContain("UNLIMITED_LEFT_STATUSES");
    expect(results).toContain("notInArray(unlimitedChallengeParticipantsTable.qualificationStatus, [...UNLIMITED_LEFT_STATUSES])");
    expect(results).toContain("(UNLIMITED_LEFT_STATUSES as readonly string[]).includes(p.qualificationStatus)");
  });

  it("returns backend-authored forfeiture content from detail/history responses", () => {
    expect(routes).toContain("STREAK_FORFEITED_PARTICIPANT_CONTENT");
    expect(routes).toContain("participantStatus: finalResult?.participantStatus ?? null");
    expect(routes).toContain("secondaryMessage: finalResult?.secondaryMessage ?? null");
    expect(routes).toContain("prizeEligible: viewerForfeited ? false : null");
  });

  it("prevents the generic viewer clock from reactivating a persisted forfeit", () => {
    expect(schedule).toContain('p.qualificationStatus === "forfeited"');
    expect(schedule).toContain('viewerStatus: "forfeited"');
  });
});
