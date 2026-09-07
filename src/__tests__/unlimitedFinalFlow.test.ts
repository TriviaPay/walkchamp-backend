import { describe, expect, it } from "vitest";
import {
  resolveStreakChallengeFinalResult,
  resolveUnlimitedFinalFlow,
} from "../lib/unlimitedFinalFlow.js";

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
  it("keeps a forfeited participant out of every legacy verification/result state", () => {
    expect(resolve({
      resultsStatus: "steps_validation_in_progress",
      viewerQualificationStatus: "forfeited",
    })).toEqual({
      status: "forfeited",
      title: "Challenge Forfeited",
      message: "You have forfeited from this Streak Challenge and are no longer eligible for the prize pool.",
      secondaryMessage: "You can still follow the challenge and view the final results.",
      prizeEligible: false,
    });
  });

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

function resolveFinalResult(
  overrides: Partial<Parameters<typeof resolveStreakChallengeFinalResult>[0]> = {},
) {
  return resolveStreakChallengeFinalResult({
    isParticipant: true,
    challengeStatus: "active",
    resultsStatus: "waiting_for_participants",
    resultsAnnouncedAt: null,
    viewerEndAt: "2026-09-01T15:00:00.000Z",
    viewerStatus: "active",
    verificationPending: true,
    allParticipantWindowsClosed: false,
    participantsFinishedCount: 1,
    latestParticipantEndAtUtc: "2026-09-01T18:00:00.000Z",
    finalVerificationParticipantCount: 2,
    finalVerificationSubmittedCount: 0,
    finalVerificationCompletedCount: 0,
    finalVerificationPendingCount: 2,
    verificationWindowMs: 4 * 60 * 60_000,
    now: NOW,
    ...overrides,
  });
}

describe("resolveStreakChallengeFinalResult", () => {
  it("keeps race final verification separate from permanent participant forfeiture", () => {
    expect(resolveFinalResult({
      resultsStatus: "steps_validation_in_progress",
      allParticipantWindowsClosed: true,
      participantsFinishedCount: 2,
      latestParticipantEndAtUtc: "2026-09-01T15:00:00.000Z",
      viewerQualificationStatus: "forfeited",
    })).toMatchObject({
      participantStatus: "FORFEITED",
      raceStatus: "FINAL_VERIFICATION",
      prizeEligible: false,
      title: "Challenge Forfeited",
      message: "You have forfeited from this Streak Challenge and are no longer eligible for the prize pool.",
      secondaryMessage: "You can still follow the challenge and view the final results.",
    });
  });

  it("does not overwrite forfeiture when race results are settled or announced", () => {
    expect(resolveFinalResult({
      challengeStatus: "completed",
      resultsStatus: "results_ready",
      resultsAnnouncedAt: "2026-09-01T16:00:00.000Z",
      allParticipantWindowsClosed: true,
      viewerQualificationStatus: "forfeited",
    })).toMatchObject({
      participantStatus: "FORFEITED",
      raceStatus: "RESULTS_ANNOUNCED",
      prizeEligible: false,
    });
  });

  it("recognizes legacy post-start left rows as forfeited", () => {
    expect(resolveFinalResult({
      viewerQualificationStatus: "left",
      viewerDisqualificationReason: "left_after_start",
    })).toMatchObject({ participantStatus: "FORFEITED", prizeEligible: false });
  });

  it("marks an early finisher while the race waits for participant-local day ends", () => {
    expect(resolveFinalResult()).toMatchObject({
      participantStatus: "FINAL_DAY_COMPLETED_WAITING",
      raceStatus: "WAITING_FOR_PARTICIPANT_DAY_ENDS",
      title: "Final Day Completed",
      message: "Your final challenge day is complete. We’re waiting for the remaining participants to finish in their local time zones.",
      verificationStartedAt: null,
      settlementEligibleAt: null,
    });
  });

  it("moves the whole race into final verification at the latest valid participant end", () => {
    expect(resolveFinalResult({
      resultsStatus: "steps_validation_in_progress",
      allParticipantWindowsClosed: true,
      participantsFinishedCount: 2,
      latestParticipantEndAtUtc: "2026-09-01T15:00:00.000Z",
    })).toMatchObject({
      participantStatus: "FINAL_VERIFICATION",
      raceStatus: "FINAL_VERIFICATION",
      title: "Final Verification",
      message: "Your challenge is complete. We’re verifying the final activity for all participants.",
      verificationStartedAt: "2026-09-01T15:00:00.000Z",
      preparingLeaderboardAt: "2026-09-01T17:00:00.000Z",
      settlementEligibleAt: "2026-09-01T19:00:00.000Z",
      verificationWindowSeconds: 14_400,
    });
  });

  it("reports results-ready/preparing-leaderboard after two hours when verification is progressing", () => {
    expect(resolveFinalResult({
      resultsStatus: "steps_validation_in_progress",
      allParticipantWindowsClosed: true,
      participantsFinishedCount: 2,
      latestParticipantEndAtUtc: "2026-09-01T13:30:00.000Z",
      finalVerificationSubmittedCount: 1,
      now: NOW,
    })).toMatchObject({
      participantStatus: "RESULTS_READY",
      raceStatus: "PREPARING_LEADERBOARD",
      title: "Results Ready",
      message: "Final verification is almost complete. We’re preparing the leaderboard.",
      verificationProgressing: true,
      verificationPending: true,
    });
  });

  it("does not claim preparation merely because two hours elapsed without a provider submission", () => {
    expect(resolveFinalResult({
      resultsStatus: "steps_validation_in_progress",
      allParticipantWindowsClosed: true,
      participantsFinishedCount: 2,
      latestParticipantEndAtUtc: "2026-09-01T13:30:00.000Z",
    })?.raceStatus).toBe("FINAL_VERIFICATION");
  });

  it("distinguishes committed settlement from announced results", () => {
    expect(resolveFinalResult({
      challengeStatus: "completed",
      resultsStatus: "results_ready",
      allParticipantWindowsClosed: true,
    })).toMatchObject({ participantStatus: "RESULTS_READY", raceStatus: "SETTLED" });

    expect(resolveFinalResult({
      challengeStatus: "completed",
      resultsStatus: "results_ready",
      resultsAnnouncedAt: "2026-09-01T16:00:00.000Z",
      allParticipantWindowsClosed: true,
    })).toMatchObject({
      participantStatus: "RESULTS_ANNOUNCED",
      raceStatus: "RESULTS_ANNOUNCED",
      title: "Streak Challenge Completed",
      message: "Streak Challenge Completed. The final results are ready. Congratulations to all participants!",
    });
  });

  it("does not assign a participant status to an authenticated spectator", () => {
    expect(resolveFinalResult({
      isParticipant: false,
      resultsStatus: "steps_validation_in_progress",
      allParticipantWindowsClosed: true,
      participantsFinishedCount: 2,
      latestParticipantEndAtUtc: "2026-09-01T15:00:00.000Z",
    })).toMatchObject({ participantStatus: null, raceStatus: "FINAL_VERIFICATION" });
  });
});
