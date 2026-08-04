/**
 * Unlimited Challenge realtime fan-out.
 *
 * Canonical channel: `unlimited-challenge-{id}` (native unlimited events).
 * Compatibility: also emit on `public-live-race-{id}` with classic race event
 * names so Waiting Room / Live Detail (which already subscribe there) update
 * without a separate client migration.
 */

import { triggerEvent } from "./pusher.js";

export function unlimitedChallengeChannel(challengeId: string): string {
  return `unlimited-challenge-${challengeId}`;
}

export function unlimitedLiveRaceChannel(challengeId: string): string {
  return `public-live-race-${challengeId}`;
}

/** Fire both channel families (best-effort; never throws). */
export function emitUnlimitedRealtime(
  challengeId: string,
  unlimitedEvent: string,
  payload: Record<string, unknown>,
  classic?: { event: string; payload?: Record<string, unknown> },
): void {
  void triggerEvent(unlimitedChallengeChannel(challengeId), unlimitedEvent, payload);
  if (classic) {
    void triggerEvent(
      unlimitedLiveRaceChannel(challengeId),
      classic.event,
      classic.payload ?? payload,
    );
  }
}
