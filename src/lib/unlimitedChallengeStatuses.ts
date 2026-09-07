export const UNLIMITED_LEFT_STATUSES = ["left", "forfeited", "withdrawn", "quit"] as const;
export const UNLIMITED_NON_ACTIVE_STATUSES = [...UNLIMITED_LEFT_STATUSES] as const;
/** Pre-start/removal exits disappear; post-start forfeits remain visible as historical racers. */
export const UNLIMITED_ROSTER_EXCLUDED_STATUSES = ["left", "withdrawn", "quit"] as const;

export function toStreakChallengeParticipantStatus(status: string): string {
  return status.toUpperCase();
}
