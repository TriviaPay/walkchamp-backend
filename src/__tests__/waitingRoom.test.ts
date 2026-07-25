import { describe, expect, it } from "vitest";
import { computeCanStart } from "../lib/waitingRoom.js";

// Pure-function tests for the Waiting Room start-eligibility rule (canStart).
// Uses the real backend config (minimumParticipants defaults to 2).

const NOW = new Date("2026-07-25T12:00:00.000Z");
const future = (ms: number) => new Date(NOW.getTime() + ms);
const past = (ms: number) => new Date(NOW.getTime() - ms);

type Room = Parameters<typeof computeCanStart>[0];
const room = (overrides: Partial<Room>): Room => ({
  mode: "open_window",
  status: "open",
  currentPlayers: 2,
  minimumParticipants: 2,
  roomExpiresAt: future(30 * 60_000),
  ...overrides,
});

describe("computeCanStart", () => {
  it("open-window room with enough players before expiry can start", () => {
    expect(computeCanStart(room({}), NOW)).toBe(true);
    expect(computeCanStart(room({ status: "full" }), NOW)).toBe(true);
  });

  it("scheduled rooms can NEVER be host-started", () => {
    expect(computeCanStart(room({ mode: "scheduled", roomExpiresAt: null }), NOW)).toBe(false);
  });

  it("cannot start below the minimum", () => {
    expect(computeCanStart(room({ currentPlayers: 1 }), NOW)).toBe(false);
  });

  it("cannot start once the 30-minute window has closed", () => {
    expect(computeCanStart(room({ roomExpiresAt: past(1) }), NOW)).toBe(false);
    expect(computeCanStart(room({ roomExpiresAt: NOW }), NOW)).toBe(false); // exactly at expiry
  });

  it("cannot start a room that is not in a startable state", () => {
    for (const status of ["in_progress", "completed", "cancelled", "expired", "starting", "scheduled"] as const) {
      expect(computeCanStart(room({ status }), NOW)).toBe(false);
    }
  });

  it("falls back to the configured minimum when the room did not freeze one (legacy)", () => {
    // minimumParticipants null → config default (2). 2 players → startable; 1 → not.
    expect(computeCanStart(room({ minimumParticipants: null, currentPlayers: 2 }), NOW)).toBe(true);
    expect(computeCanStart(room({ minimumParticipants: null, currentPlayers: 1 }), NOW)).toBe(false);
  });

  it("legacy open room (mode null) is startable when it has enough players", () => {
    expect(computeCanStart(room({ mode: null, roomExpiresAt: null, currentPlayers: 2 }), NOW)).toBe(true);
  });

  it("respects a higher frozen minimum than the default", () => {
    expect(computeCanStart(room({ minimumParticipants: 4, currentPlayers: 3 }), NOW)).toBe(false);
    expect(computeCanStart(room({ minimumParticipants: 4, currentPlayers: 4 }), NOW)).toBe(true);
  });
});
