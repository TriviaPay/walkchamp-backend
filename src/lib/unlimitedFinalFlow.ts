export type UnlimitedFinalFlowStatus =
  | "final_day_completed"
  | "final_results_pending"
  | "verifying_final_results"
  | "results_ready"
  | "challenge_completed";

export interface UnlimitedFinalFlow {
  status: UnlimitedFinalFlowStatus;
  title: string;
  message: string;
}

interface ResolveUnlimitedFinalFlowInput {
  challengeStatus: string | null | undefined;
  resultsStatus: string | null | undefined;
  resultsAnnouncedAt: Date | string | null | undefined;
  viewerEndAt: Date | string | null | undefined;
  viewerStatus: string | null | undefined;
  verificationPending: boolean;
  now?: Date;
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
};

function isAtOrAfter(value: Date | string | null | undefined, now: Date): boolean {
  if (!value) return false;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) && now.getTime() >= timestamp;
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
