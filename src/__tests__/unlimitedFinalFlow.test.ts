import { describe, expect, it } from "vitest";
import { resolveUnlimitedFinalFlow } from "../lib/unlimitedFinalFlow.js";

const NOW = new Date("2026-09-01T16:00:00.000Z");

function resolve(overrides: Partial<Parameters<typeof resolveUnlimitedFinalFlow>[0]> = {}) {
  return resolveUnlimitedFinalFlow({
    challengeStatus: "active",
    resultsStatus: "in_progress",
    resultsAnnouncedAt: null,
    viewerEndAt: "2026-09-01T15:00:00.000Z",
    viewerStatus: "active",
    verificationPending: true,
    now: NOW,
    ...overrides,
  });
}

describe("resolveUnlimitedFinalFlow", () => {
  it("returns no final flow before this viewer's persisted UTC end", () => {
    expect(resolve({
      viewerEndAt: "2026-09-01T17:00:00.000Z",
      verificationPending: false,
    })).toBeNull();
  });

  it("returns Final Day Completed once this viewer's run has ended", () => {
    expect(resolve()).toEqual({
      status: "final_day_completed",
      title: "Final Day Completed",
      message: "Waiting for all participants to finish their challenge day.",
    });
  });

  it("returns Final Results Pending while other participant windows remain open", () => {
    expect(resolve({ resultsStatus: "waiting_for_participants" })).toEqual({
      status: "final_results_pending",
      title: "Final Results Pending",
      message: "We're waiting for all participants' challenge days to finish.",
    });
  });

  it("does not put a viewer whose run is still open into the pending final flow", () => {
    expect(resolve({
      resultsStatus: "waiting_for_participants",
      viewerEndAt: "2026-09-01T17:00:00.000Z",
      verificationPending: false,
    })).toBeNull();
  });

  it("returns Verifying Final Results during global step validation", () => {
    expect(resolve({
      resultsStatus: "steps_validation_in_progress",
      viewerEndAt: "2026-09-01T17:00:00.000Z",
      verificationPending: false,
    })).toEqual({
      status: "verifying_final_results",
      title: "Verifying Final Results",
      message: "We're verifying the final activity for all participants.",
    });
  });

  it("returns Results Ready after settlement but before announcement", () => {
    expect(resolve({
      challengeStatus: "completed",
      resultsStatus: "results_ready",
      resultsAnnouncedAt: null,
    })).toEqual({
      status: "results_ready",
      title: "Results Ready",
      message: "Final results are ready! Preparing leaderboard.",
    });
  });

  it("returns Challenge Completed after results are announced", () => {
    expect(resolve({
      challengeStatus: "completed",
      resultsStatus: "results_ready",
      resultsAnnouncedAt: "2026-09-01T16:00:00.000Z",
    })).toEqual({
      status: "challenge_completed",
      title: "Challenge Completed",
      message: "Here are the final results! Congrats to all!",
    });
  });

  it("does not reuse the final-result flow for platform cancellations", () => {
    expect(resolve({
      challengeStatus: "cancelled_by_platform",
      resultsStatus: "results_ready",
      resultsAnnouncedAt: "2026-09-01T16:00:00.000Z",
    })).toBeNull();
  });
});
