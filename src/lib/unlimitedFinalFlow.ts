export type UnlimitedFinalFlowStatus =
  | "final_day_completed"
  | "final_results_pending"
  | "verifying_final_results"
  | "results_ready"
  | "challenge_completed"
  | "forfeited";

export interface UnlimitedFinalFlow {
  status: UnlimitedFinalFlowStatus;
  title: string;
  message: string;
  secondaryMessage?: string;
  prizeEligible?: boolean;
}

export type StreakChallengeParticipantFinalStatus =
  | "FINAL_DAY_COMPLETED_WAITING"
  | "FINAL_VERIFICATION"
  | "RESULTS_READY"
  | "RESULTS_ANNOUNCED"
  | "FORFEITED";

export type StreakChallengeRaceFinalStatus =
  | "WAITING_FOR_PARTICIPANT_DAY_ENDS"
  | "FINAL_VERIFICATION"
  | "PREPARING_LEADERBOARD"
  | "SETTLED"
  | "RESULTS_ANNOUNCED";

export interface StreakChallengeFinalResult {
  participantStatus: StreakChallengeParticipantFinalStatus | null;
  raceStatus: StreakChallengeRaceFinalStatus | null;
  title: string | null;
  message: string | null;
  secondaryMessage: string | null;
  prizeEligible: boolean | null;
  lastParticipantEndAtUtc: string | null;
  verificationStartedAt: string | null;
  preparingLeaderboardAt: string | null;
  settlementEligibleAt: string | null;
  verificationElapsedSeconds: number | null;
  preparingLeaderboardAfterSeconds: number;
  verificationWindowSeconds: number;
  verificationProgressing: boolean;
  verificationPending: boolean;
}

interface ResolveUnlimitedFinalFlowInput {
  challengeStatus: string | null | undefined;
  resultsStatus: string | null | undefined;
  resultsAnnouncedAt: Date | string | null | undefined;
  viewerEndAt: Date | string | null | undefined;
  viewerStatus: string | null | undefined;
  viewerQualificationStatus?: string | null | undefined;
  viewerDisqualificationReason?: string | null | undefined;
  verificationPending: boolean;
  now?: Date;
}

interface ResolveStreakChallengeFinalResultInput extends ResolveUnlimitedFinalFlowInput {
  isParticipant: boolean;
  allParticipantWindowsClosed: boolean;
  participantsFinishedCount: number;
  latestParticipantEndAtUtc: Date | string | null | undefined;
  finalVerificationParticipantCount: number;
  finalVerificationSubmittedCount: number;
  finalVerificationCompletedCount: number;
  finalVerificationPendingCount: number;
  resultsReadyAt?: Date | string | null;
  settledAt?: Date | string | null;
  verificationWindowMs?: number;
}

const PREPARING_LEADERBOARD_AFTER_MS = 2 * 60 * 60_000;
const DEFAULT_VERIFICATION_WINDOW_MS = 4 * 60 * 60_000;

export const STREAK_FORFEITED_PARTICIPANT_CONTENT = {
  title: "Challenge Forfeited",
  message: "You have forfeited from this Streak Challenge and are no longer eligible for the prize pool.",
  secondaryMessage: "You can still follow the challenge and view the final results.",
} as const;

const STREAK_FINAL_COPY = {
  FORFEITED: {
    ...STREAK_FORFEITED_PARTICIPANT_CONTENT,
  },
  FINAL_DAY_COMPLETED_WAITING: {
    title: "Final Day Completed",
    message: "Your final challenge day is complete. We’re waiting for the remaining participants to finish in their local time zones.",
  },
  FINAL_VERIFICATION: {
    title: "Final Verification",
    message: "Your challenge is complete. We’re verifying the final activity for all participants.",
  },
  PREPARING_LEADERBOARD: {
    title: "Results Ready",
    message: "Final verification is almost complete. We’re preparing the leaderboard.",
  },
  RESULTS_ANNOUNCED: {
    title: "Streak Challenge Completed",
    message: "Streak Challenge Completed. The final results are ready. Congratulations to all participants!",
  },
} as const;

/**
 * Canonical recognition for both new forfeits and legacy post-start exits. Older rows used
 * `left` plus `left_after_start`; treating those as ordinary pre-start departures would let the
 * participant-facing status drift back into verification after deployment.
 */
export function isStreakChallengeParticipantForfeited(input: {
  qualificationStatus: string | null | undefined;
  disqualificationReason?: string | null | undefined;
}): boolean {
  return input.qualificationStatus === "forfeited"
    || (input.qualificationStatus === "left" && input.disqualificationReason === "left_after_start");
}

const FINAL_FLOW_COPY: Record<UnlimitedFinalFlowStatus, UnlimitedFinalFlow> = {
  final_day_completed: {
    status: "final_day_completed",
    title: "Final Day Completed",
    message: "Waiting for all participants to finish their challenge day.",
  },
  final_results_pending: {
    status: "final_results_pending",
    title: "Final Results Pending",
    message: "We're waiting for all participants' challenge days to finish.",
  },
  verifying_final_results: {
    status: "verifying_final_results",
    title: "Verifying Final Results",
    message: "We're verifying the final activity for all participants.",
  },
  results_ready: {
    status: "results_ready",
    title: "Results Ready",
    message: "Final results are ready! Preparing leaderboard.",
  },
  challenge_completed: {
    status: "challenge_completed",
    title: "Challenge Completed",
    message: "Here are the final results! Congrats to all!",
  },
  forfeited: {
    status: "forfeited",
    ...STREAK_FINAL_COPY.FORFEITED,
    prizeEligible: false,
  },
};

function isAtOrAfter(value: Date | string | null | undefined, now: Date): boolean {
  if (!value) return false;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) && now.getTime() >= timestamp;
}

function toTimestamp(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function toIso(timestamp: number | null): string | null {
  return timestamp == null ? null : new Date(timestamp).toISOString();
}

/**
 * Canonical frontend contract for the Streak Challenge final-result lifecycle.
 *
 * All clocks originate from the race-wide maximum persisted participantEndAtUtc in the frozen
 * settlement population. This resolver never accepts a device timezone or a client-derived end.
 * RESULTS_READY/PREPARING_LEADERBOARD is a presentation phase only; persisted resultsStatus stays
 * under settlement ownership until every health and day-finalization gate actually passes.
 */
export function resolveStreakChallengeFinalResult(
  input: ResolveStreakChallengeFinalResultInput,
): StreakChallengeFinalResult | null {
  const forfeited = input.isParticipant && isStreakChallengeParticipantForfeited({
    qualificationStatus: input.viewerQualificationStatus,
    disqualificationReason: input.viewerDisqualificationReason,
  });
  if (input.challengeStatus === "cancelled_by_platform" && !forfeited) return null;

  const now = input.now ?? new Date();
  const verificationWindowMs = Math.max(0, input.verificationWindowMs ?? DEFAULT_VERIFICATION_WINDOW_MS);
  const preparingAfterMs = Math.min(PREPARING_LEADERBOARD_AFTER_MS, verificationWindowMs);
  const lastEndMs = toTimestamp(input.latestParticipantEndAtUtc);
  const viewerEnded =
    input.verificationPending
    || isAtOrAfter(input.viewerEndAt, now)
    || input.viewerStatus === "completed"
    || input.viewerStatus === "failed"
    || input.viewerStatus === "left";
  const verificationStartedAt = input.allParticipantWindowsClosed ? lastEndMs : null;
  const elapsedMs = verificationStartedAt == null
    ? null
    : Math.max(0, now.getTime() - verificationStartedAt);
  const verificationProgressing = input.finalVerificationSubmittedCount > 0
    || input.finalVerificationCompletedCount > 0;
  const globalVerificationPending = input.allParticipantWindowsClosed
    && input.finalVerificationParticipantCount > 0
    && input.finalVerificationPendingCount > 0;

  let participantStatus: StreakChallengeParticipantFinalStatus | null = null;
  let raceStatus: StreakChallengeRaceFinalStatus | null = null;
  let copy: { title: string; message: string } | null = null;
  if (input.resultsAnnouncedAt) {
    participantStatus = "RESULTS_ANNOUNCED";
    raceStatus = "RESULTS_ANNOUNCED";
    copy = STREAK_FINAL_COPY.RESULTS_ANNOUNCED;
  } else if (input.resultsStatus === "results_ready" || input.challengeStatus === "completed") {
    participantStatus = "RESULTS_READY";
    raceStatus = "SETTLED";
    copy = STREAK_FINAL_COPY.PREPARING_LEADERBOARD;
  } else if (input.allParticipantWindowsClosed) {
    if (elapsedMs != null && elapsedMs >= preparingAfterMs && verificationProgressing) {
      participantStatus = "RESULTS_READY";
      raceStatus = "PREPARING_LEADERBOARD";
      copy = STREAK_FINAL_COPY.PREPARING_LEADERBOARD;
    } else {
      participantStatus = "FINAL_VERIFICATION";
      raceStatus = "FINAL_VERIFICATION";
      copy = STREAK_FINAL_COPY.FINAL_VERIFICATION;
    }
  } else if (input.participantsFinishedCount > 0) {
    raceStatus = "WAITING_FOR_PARTICIPANT_DAY_ENDS";
    if (viewerEnded) {
      participantStatus = "FINAL_DAY_COMPLETED_WAITING";
      copy = STREAK_FINAL_COPY.FINAL_DAY_COMPLETED_WAITING;
    }
  } else if (viewerEnded) {
    // Defensive compatibility for old rows whose aggregate counters have not been refreshed yet.
    participantStatus = "FINAL_DAY_COMPLETED_WAITING";
    raceStatus = "WAITING_FOR_PARTICIPANT_DAY_ENDS";
    copy = STREAK_FINAL_COPY.FINAL_DAY_COMPLETED_WAITING;
  } else if (!forfeited) {
    return null;
  }

  // Participant forfeiture is permanent and wins over every personal lifecycle state. The
  // independently resolved raceStatus above is intentionally left untouched.
  if (forfeited) {
    participantStatus = "FORFEITED";
    copy = STREAK_FINAL_COPY.FORFEITED;
  }

  return {
    participantStatus: input.isParticipant ? participantStatus : null,
    raceStatus,
    title: copy?.title ?? null,
    message: copy?.message ?? null,
    secondaryMessage: forfeited ? STREAK_FINAL_COPY.FORFEITED.secondaryMessage : null,
    prizeEligible: forfeited ? false : null,
    lastParticipantEndAtUtc: toIso(lastEndMs),
    verificationStartedAt: toIso(verificationStartedAt),
    preparingLeaderboardAt: toIso(verificationStartedAt == null ? null : verificationStartedAt + preparingAfterMs),
    settlementEligibleAt: toIso(verificationStartedAt == null ? null : verificationStartedAt + verificationWindowMs),
    verificationElapsedSeconds: elapsedMs == null ? null : Math.floor(elapsedMs / 1000),
    preparingLeaderboardAfterSeconds: Math.floor(preparingAfterMs / 1000),
    verificationWindowSeconds: Math.floor(verificationWindowMs / 1000),
    verificationProgressing,
    verificationPending: globalVerificationPending,
  };
}

/**
 * Resolve the viewer-facing final-result flow from backend-owned state only.
 *
 * `viewerEndAt` is the participant's persisted locked-timezone end instant (or the schedule
 * fallback produced by deriveViewerState). Device timezones and client clocks never participate.
 */
export function resolveUnlimitedFinalFlow(
  input: ResolveUnlimitedFinalFlowInput,
): UnlimitedFinalFlow | null {
  if (isStreakChallengeParticipantForfeited({
    qualificationStatus: input.viewerQualificationStatus,
    disqualificationReason: input.viewerDisqualificationReason,
  })) {
    return FINAL_FLOW_COPY.forfeited;
  }
  if (input.challengeStatus === "cancelled_by_platform") return null;

  if (input.resultsAnnouncedAt) return FINAL_FLOW_COPY.challenge_completed;
  if (input.resultsStatus === "results_ready") return FINAL_FLOW_COPY.results_ready;

  // Compatibility for completed legacy rows that predate the results lifecycle columns.
  if (input.challengeStatus === "completed" && !input.resultsStatus) {
    return FINAL_FLOW_COPY.challenge_completed;
  }

  if (input.resultsStatus === "steps_validation_in_progress") {
    return FINAL_FLOW_COPY.verifying_final_results;
  }

  const viewerEnded =
    input.verificationPending
    || isAtOrAfter(input.viewerEndAt, input.now ?? new Date())
    || input.viewerStatus === "completed"
    || input.viewerStatus === "failed"
    || input.viewerStatus === "left";

  if (!viewerEnded) return null;
  if (input.resultsStatus === "waiting_for_participants") {
    return FINAL_FLOW_COPY.final_results_pending;
  }
  return FINAL_FLOW_COPY.final_day_completed;
}
