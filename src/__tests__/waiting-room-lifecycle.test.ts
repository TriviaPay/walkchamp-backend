import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Contract tests (source-grep, repo convention) pinning the shared Waiting Room lifecycle
// invariants that live inside large route/service files. Pure canStart logic is covered in
// waitingRoom.test.ts; these lock the wiring, atomicity, refunds, and API surface.

const races = readFileSync("src/routes/races.ts", "utf8");
const waitingRoom = readFileSync("src/lib/waitingRoom.ts", "utf8");
const waitingRoomJobs = readFileSync("src/lib/waitingRoomJobs.ts", "utf8");
const scheduler = readFileSync("src/lib/scheduler.ts", "utf8");
const worker = readFileSync("src/worker.ts", "utf8");
const schema = readFileSync("db/src/schema/races.ts", "utf8");
const refundService = readFileSync("src/lib/refundService.ts", "utf8");

describe("schema + migration", () => {
  it("adds mode / roomExpiresAt / cancellationReason / cancelledAt / minimumParticipants columns", () => {
    expect(schema).toContain('mode: text("mode")');
    expect(schema).toContain('roomExpiresAt: timestamp("room_expires_at"');
    expect(schema).toContain('cancellationReason: text("cancellation_reason")');
    expect(schema).toContain('cancelledAt: timestamp("cancelled_at"');
    expect(schema).toContain('minimumParticipants: integer("minimum_participants")');
  });

  it("adds starting + expired race statuses", () => {
    expect(schema).toContain('"starting"');
    expect(schema).toContain('"expired"');
  });
});

describe("room creation sets lifecycle fields + enqueues a durable job", () => {
  it("open-window rooms freeze a 30-minute roomExpiresAt from config", () => {
    expect(races).toContain('mode: isScheduledFuture ? "scheduled" : "open_window"');
    expect(races).toContain("new Date(Date.now() + config.waitingRoom.openWindowMs)");
    expect(races).toContain("minimumParticipants: config.waitingRoom.minimumParticipants");
  });

  it("enqueues the durable lifecycle job on every create path", () => {
    // POST /races/host, POST /races, POST /races/quick-join-free
    expect((races.match(/enqueueWaitingRoomLifecycleJobs\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe("atomic start via a compare-and-set claim", () => {
  it("activateRoomAndStart claims into the transient 'starting' status then commits with CAS", () => {
    expect(races).toContain("export async function activateRoomAndStart");
    expect(races).toContain('status: "starting"');
    expect(races).toContain('inArray(raceRoomsTable.status, opts.fromStatuses)');
    // Final activation only commits from the claimed "starting" state.
    expect(races).toContain('and(eq(raceRoomsTable.id, raceId), eq(raceRoomsTable.status, "starting"))');
    // Charge failure reverts the claim so the room isn't stuck.
    expect(races).toContain("revertClaim");
  });

  it("host /start rejects scheduled rooms and expired windows, and enforces the minimum", () => {
    expect(races).toContain("Scheduled races start automatically at their scheduled time.");
    expect(races).toContain("room.roomExpiresAt && Date.now() >= room.roomExpiresAt.getTime()");
    expect(races).toContain("room.minimumParticipants ?? config.waitingRoom.minimumParticipants");
  });
});

describe("scheduled auto-start + open-window expiry", () => {
  it("scheduler runs the shared reconciliation (no more inline open-the-room)", () => {
    expect(scheduler).toContain("reconcileWaitingRooms(now)");
    expect(scheduler).not.toContain("async function startScheduledRoom");
  });

  it("evaluateScheduledStart auto-starts to ACTIVE or cancels on min-not-met", () => {
    expect(waitingRoomJobs).toContain("export async function evaluateScheduledStart");
    expect(waitingRoomJobs).toContain('fromStatuses: ["scheduled"], materializeRegistrations: true');
    expect(waitingRoomJobs).toContain('reason: "MINIMUM_PARTICIPANTS_NOT_MET"');
  });

  it("expireOpenWindow distinguishes min-not-met vs host-did-not-start, never auto-starts", () => {
    expect(waitingRoomJobs).toContain("export async function expireOpenWindow");
    expect(waitingRoomJobs).toContain("HOST_DID_NOT_START_BEFORE_EXPIRATION");
    expect(waitingRoomJobs).toContain('terminalStatus: "expired"');
  });

  it("reconciler recovers scheduled-due, expired, and stuck-starting rooms", () => {
    expect(waitingRoomJobs).toContain("export async function reconcileWaitingRooms");
    expect(waitingRoomJobs).toContain('eq(raceRoomsTable.status, "starting")'); // stuck recovery
  });

  it("durable jobs run on a dedicated worker with idempotent jobIds", () => {
    expect(worker).toContain('startQueueWorker("scheduled-jobs"');
    expect(waitingRoom).toContain('jobId: `wr-expire:${room.id}`');
    expect(waitingRoom).toContain('jobId: `wr-start:${room.id}`');
  });
});

describe("terminal transition, refunds, and exactly-once signalling", () => {
  it("terminateWaitingRoom refunds paid rooms once and CAS-transitions free rooms", () => {
    expect(waitingRoom).toContain("export async function terminateWaitingRoom");
    expect(waitingRoom).toContain("createRefundBatchForRaceCancellation");
    expect(waitingRoom).toContain('inArray(raceRoomsTable.status, ["open", "full", "scheduled"])');
  });

  it("refund idempotency key is stable so retries never double-refund", () => {
    expect(refundService).toContain("`race_cancel:${input.raceId}:${uid}`");
  });

  it("notifications are deduped per room/terminal event", () => {
    expect(waitingRoom).toContain("dedupeKey: `${terminalEvent}:${roomId}`");
  });

  it("host cancel routes through the shared terminal path with HOST_CANCELLED", () => {
    expect(races).toContain("terminateWaitingRoom(raceId, {");
    expect(races).toContain('reason: "HOST_CANCELLED"');
  });
});

describe("API surface + join guards", () => {
  it("GET race detail exposes canStart + minimum/expiry fields (camelCase + snake aliases)", () => {
    expect(races).toContain("canStart: computeCanStart(room)");
    expect(races).toContain("room_expires_at: room.roomExpiresAt");
    expect(races).toContain("cancellation_reason: room.cancellationReason");
    expect(races).toContain("minimum_participants:");
  });

  it("joins are rejected once the open-window has expired", () => {
    expect(races).toContain("This Waiting Room has expired.");
  });
});

describe("refunds unchanged for post-start forfeit (separate case)", () => {
  it("forfeit still returns no refund and does not settle the race", () => {
    expect(races).toContain('refund: { eligible: false, type: "none", cashAmountMinor: 0, coinAmount: 0 }');
    expect(races).not.toContain("winner_by_forfeit");
  });
});
