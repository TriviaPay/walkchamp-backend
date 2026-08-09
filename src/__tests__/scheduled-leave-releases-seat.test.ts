import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { raceRoomsTable, scheduledRoomRegistrationsTable } from "../../db/src/schema/index.js";
import { releaseScheduledRegistration, type DbTx } from "../lib/raceIntegrity.js";

// A scheduled room has NO race_participants rows before materialize-at-start — its roster is
// scheduled_room_registrations and its occupancy is registeredCount. Leaving used to touch only
// race_participants/currentPlayers, so the seat was never released: the roster poll re-added the
// leaver and Trending's "Joined" never dropped.

const read = (p: string) => readFileSync(p, "utf8");

const removeBlock = () => {
  const races = read("src/routes/races.ts");
  return races.slice(
    races.indexOf('router.post("/races/:id/participants/:userId/remove"'),
    races.indexOf("NON_MEMBER_CANDIDATE_LIMIT"),
  );
};

type Registration = { id: string; status: string };

function fakeTx(registration: Registration | null) {
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () => selectChain,
    for: async () => (registration ? [registration] : []),
  };
  const tx = {
    select: () => selectChain,
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ table, values });
        },
      }),
    }),
  };
  return { tx: tx as unknown as DbTx, updates };
}

describe("releaseScheduledRegistration", () => {
  it("cancels the registration and decrements registeredCount", async () => {
    const { tx, updates } = fakeTx({ id: "reg-1", status: "registered" });

    const result = await releaseScheduledRegistration(tx, "room-1", "user-1", { registeredCount: 3 });

    expect(result).toEqual({ changed: true, registeredCount: 2, hadRegistration: true });

    const regUpdate = updates.find((u) => u.table === scheduledRoomRegistrationsTable);
    expect(regUpdate?.values.status).toBe("cancelled");
    expect(regUpdate?.values.cancelledAt).toBeInstanceOf(Date);
    // Cleared so a re-register isn't mistaken for an already-materialized seat.
    expect(regUpdate?.values.activatedAt).toBeNull();

    const roomUpdate = updates.find((u) => u.table === raceRoomsTable);
    expect(roomUpdate?.values.registeredCount).toBe(2);
  });

  it("never drives registeredCount negative", async () => {
    const { tx } = fakeTx({ id: "reg-1", status: "registered" });
    const result = await releaseScheduledRegistration(tx, "room-1", "user-1", { registeredCount: 0 });
    expect(result.registeredCount).toBe(0);
  });

  it("is an idempotent no-op once the registration is cancelled", async () => {
    const { tx, updates } = fakeTx({ id: "reg-1", status: "cancelled" });

    const result = await releaseScheduledRegistration(tx, "room-1", "user-1", { registeredCount: 3 });

    // The count must NOT drop twice when leave and the app's follow-up cancel both run.
    expect(result).toEqual({ changed: false, registeredCount: 3, hadRegistration: true });
    expect(updates).toHaveLength(0);
  });

  it("does not release a seat once the race has materialized it", async () => {
    const { tx, updates } = fakeTx({ id: "reg-1", status: "activated" });

    const result = await releaseScheduledRegistration(tx, "room-1", "user-1", { registeredCount: 3 });

    // Post-start departure is a forfeit; giving the seat back would re-open a running race.
    expect(result.changed).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("reports a missing registration so callers can 404", async () => {
    const { tx } = fakeTx(null);
    const result = await releaseScheduledRegistration(tx, "room-1", "user-1", { registeredCount: 3 });
    expect(result).toEqual({ changed: false, registeredCount: 3, hadRegistration: false });
  });
});

describe("every pre-start departure path releases the scheduled seat", () => {
  it("leave releases the registration when there is no participant row", () => {
    const races = read("src/routes/races.ts");
    const leave = races.slice(
      races.indexOf('router.post("/races/:id/leave"'),
      races.indexOf("Post-start leave: forfeit this participant"),
    );

    expect(leave).toContain('isPreStart && room.status === "scheduled"');
    expect(leave).toContain("releaseScheduledRegistration(tx, raceId, userId, lockedRoom)");
    // The seat release must be inside a transaction that re-locks the room, so registeredCount is
    // read and written under the same lock as register/cancel-registration.
    expect(leave).toContain("const lockedRoom = await lockRaceRoom(tx, raceId)");
    expect(leave).toContain("release?.hadRegistration");
  });

  it("the refund path releases the seat inside the refund transaction", () => {
    const refunds = read("src/lib/refundService.ts");
    const leaveFn = refunds.slice(
      refunds.indexOf("export async function createRefundForRaceLeave"),
      refunds.indexOf("export async function createRefundBatchForRaceCancellation"),
    );

    expect(leaveFn).toContain('room.status === "scheduled"');
    expect(leaveFn).toContain("releaseScheduledRegistration(tx, input.raceId, input.userId, room)");
    // Same transaction as the refund — a refunded leave can never keep its seat.
    expect(leaveFn).not.toContain("await db.transaction(async (tx2)");
    expect(leaveFn).toContain("registrationCancelled: result.registrationRelease.changed");
    expect(leaveFn).toContain("registeredCount: result.registrationRelease.registeredCount");
  });

  it("host removal releases the seat in both the free and paid branches", () => {
    const remove = removeBlock();
    // Free branch does it directly; the paid branch inherits it from createRefundForRaceLeave.
    expect(remove).toContain("releaseScheduledRegistration(tx, raceId, targetUserId, lockedRoom)");
    expect(remove).toContain("seatReleased = leaveResult.registrationCancelled");
  });

  it("cancel-registration shares the helper instead of hand-rolling the decrement", () => {
    const races = read("src/routes/races.ts");
    const cancel = races.slice(
      races.indexOf('router.post("/rooms/:roomId/cancel-registration"'),
      races.indexOf("GET /api/races/my-active"),
    );

    expect(cancel).toContain("releaseScheduledRegistration(tx, roomId, userId, room)");
    expect(cancel).not.toContain("Math.max(0, room.registeredCount - 1)");
    // Only a genuinely absent registration is a 404 — an already-released seat is a success, so
    // the app's best-effort follow-up call after leave does not surface as an error.
    expect(cancel).toContain("if (!release.hadRegistration)");
  });
});

describe("host removal works on a scheduled room", () => {
  it("removes a registered player who has no participant row", () => {
    const remove = removeBlock();
    // The endpoint lists "scheduled" as removable but used to 404 on every scheduled room,
    // because those rooms have no race_participants rows before materialize-at-start.
    expect(remove).toContain("if (!participant) {");
    expect(remove).toContain("releaseScheduledRegistration(tx, raceId, targetUserId, lockedRoom)");
    expect(remove).toContain("if (!release?.hadRegistration)");
    // Still a 404 when the target is in neither table.
    expect(remove).toContain('res.status(404).json({ error: "Player not found in this room." })');
  });

  it("honours the same server-authoritative pre-start boundary as leaving", () => {
    const remove = removeBlock();
    expect(remove).toContain("Date.now() < scheduledStartMs");
    expect(remove).toContain("scheduledPreStart");
    // A room that tipped past its start inside the refund txn is a 409, not a 500.
    expect(remove).toContain('if (msg === "RACE_ALREADY_STARTED")');
  });

  it("reports occupancy with the counter that room mode actually uses", () => {
    const remove = removeBlock();
    expect(remove).toContain('room.status === "scheduled" ? registeredCount : currentPlayers');
    // The roster echoed back has to include registrations, or the client re-adds them.
    expect(remove).toContain("scheduledRoomRegistrationsTable");
    expect(remove).toContain("participantIds: remainingIds");
    expect(remove).toContain("registered_count: registeredCount");
  });

  it("tells Trending about the freed seat", () => {
    const remove = removeBlock();
    expect(remove).toContain("if (seatReleased) {");
    expect(remove).toContain("broadcastPreStartDeparture(raceId, targetUserId,");
  });
});

describe("clients are told about a departure live", () => {
  it("broadcasts to both the discovery channel and the room channel", () => {
    const races = read("src/routes/races.ts");
    const fn = races.slice(
      races.indexOf("function broadcastPreStartDeparture"),
      races.indexOf('router.post("/races/:id/leave"'),
    );

    expect(fn).toContain('triggerEvent(`public-live-race-${raceId}`, "race:player-left"');
    expect(fn).toContain('triggerEvent("public-rooms-available", "room:participant_left"');
    expect(fn).toContain('triggerEvent("public-rooms-available", "room:registration_cancelled"');
    expect(fn).toContain('triggerEvent(`public-live-race-${raceId}`, "room:registration_cancelled"');
    // Trending needs the authoritative count and the identity of who left, on every event.
    expect(fn).toContain("registered_count: opts.registeredCount");
    expect(fn).toContain("userId,");
  });

  it("is used by leave and by cancel-registration, so both emit the same shapes", () => {
    const races = read("src/routes/races.ts");
    const calls = races.split("broadcastPreStartDeparture(").length - 1;
    // definition + cancel-registration + registered-only leave + refunded leave + host removal
    expect(calls).toBeGreaterThanOrEqual(5);
  });
});
