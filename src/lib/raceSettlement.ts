import { logger } from "./logger.js";

/**
 * Winner-selection & winner-slot rules (backend requirement — WINNER SELECTION AND FORFEIT LOGIC).
 *
 * These functions are pure and DB-free so they can be unit-tested in isolation. They encode two
 * hard rules from the spec:
 *   1. The maximum number of winners is a function of the STARTING participant count, frozen at
 *      race start and never recalculated from live/remaining/forfeited counts.
 *   2. Only participants who completed the full target within the race duration can win, ranked by
 *      authoritative server completion time, with strictly unique positions (no ties).
 */

/**
 * Maximum winner slots for a race, based on the number of valid participants when the race STARTED.
 *
 *   2 participants        → 1 winner
 *   3 participants        → 2 winners
 *   4–10 participants     → 3 winners
 *   anything else (<2, >10) → 0 winners
 *
 * These are MAXIMUM slots — they are not guaranteed to be filled. Fewer completers ⇒ fewer winners.
 */
export function getWinnerSlotCount(startingParticipantCount: number): number {
  if (startingParticipantCount === 2) return 1;
  if (startingParticipantCount === 3) return 2;
  if (startingParticipantCount >= 4 && startingParticipantCount <= 10) return 3;
  return 0;
}

/** A participant that has completed the target (has an authoritative goal-completion timestamp). */
export interface Completer {
  participantId: string;
  userId: string;
  /** Authoritative server time (ms) the target was first reached. Must be non-null for a completer. */
  goalCompletedAtMs: number;
  /** Server-acceptance ordinal assigned at the goal-crossing tick (Postgres max+1 / Redis INCR). */
  finishRank: number | null;
  finalSteps: number;
}

export interface RankedWinner extends Completer {
  /** Unique 1-based finishing position. */
  position: number;
}

/**
 * Select up to `slotCount` winners from the participants who completed the target.
 *
 * Ordering (deterministic, no ties):
 *   1. Earliest goalCompletedAtMs
 *   2. Earliest finishRank (server-acceptance ordinal that caused the crossing) when times tie
 *   3. Stable participantId as the final deterministic fallback (logged for audit)
 *
 * Returns winners with strictly unique positions 1..N (N ≤ slotCount). Non-completers are never
 * passed in; if `completers` is empty or `slotCount` is 0 the result is [] (zero winners).
 */
export function selectWinners(completers: Completer[], slotCount: number, raceId?: string): RankedWinner[] {
  if (slotCount <= 0 || completers.length === 0) return [];

  const sorted = [...completers].sort((a, b) => {
    if (a.goalCompletedAtMs !== b.goalCompletedAtMs) return a.goalCompletedAtMs - b.goalCompletedAtMs;
    // Same completion millisecond — fall back to the authoritative acceptance ordinal.
    const ar = a.finishRank ?? Number.MAX_SAFE_INTEGER;
    const br = b.finishRank ?? Number.MAX_SAFE_INTEGER;
    if (ar !== br) return ar - br;
    // Final deterministic technical fallback: stable participant record id. Log it for audit.
    if (a.participantId !== b.participantId) {
      logger.warn(
        { raceId, a: a.participantId, b: b.participantId, goalCompletedAtMs: a.goalCompletedAtMs, finishRank: ar },
        "[selectWinners] tie broken by participantId fallback (identical completion time and ordinal)",
      );
      return a.participantId < b.participantId ? -1 : 1;
    }
    return 0;
  });

  return sorted.slice(0, slotCount).map((c, idx) => ({ ...c, position: idx + 1 }));
}
