// Integration tests for the redis-live core (Phase 2). These exercise the REAL Lua
// applyProgress script and helpers against a real ephemeral redis-server, because the Lua
// (sequence dedup, baseline/backfill, cumulative clamp, atomic goal-cross + ordinal) cannot be
// verified by mocks. Self-skips when redis-server is not installed (CI without redis).
import { type ChildProcess, execSync, spawn } from "node:child_process";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

function redisServerAvailable(): boolean {
  try {
    execSync("which redis-server", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const HAS_REDIS = redisServerAvailable();

// The mocked redis module hands raceLiveState our test client.
const hoisted = vi.hoisted(() => ({ client: null as unknown as Redis }));
vi.mock("../lib/redis.js", () => ({
  getRedisLive: () => hoisted.client,
  ensureRedisLiveConnected: async () => {},
}));

// Imported after the mock is registered.
import * as live from "../lib/raceLiveState.js";
import type { LiveParticipantSeed, LiveRaceConfig } from "../lib/raceLiveState.js";

const T0 = 1_700_000_000_000; // fixed race start (ms)
const LATE = T0 + 3_600_000; // 1h later → large cumulative budget, avoids clamp in most tests

function cfg(overrides: Partial<LiveRaceConfig> = {}): LiveRaceConfig {
  return {
    status: live.LIVE_RACE_STATE.ACTIVE,
    startedAtMs: T0,
    challengeEndAtMs: null,
    targetSteps: 1000,
    type: "solo",
    liveStateVersion: 0,
    ...overrides,
  };
}
function seed(userId: string, overrides: Partial<LiveParticipantSeed> = {}): LiveParticipantSeed {
  return {
    userId,
    participantId: `p-${userId}`,
    username: `user-${userId}`,
    currentSteps: 0,
    raceBaselineSteps: 0,
    lastStepSequenceId: -1,
    finishedGoal: false,
    finishRank: null,
    ...overrides,
  };
}

describe.skipIf(!HAS_REDIS)("raceLiveState (integration, real redis)", () => {
  let server: ChildProcess;
  let redis: Redis;
  const RACE = "race-1";

  beforeAll(async () => {
    const port = 6500 + (process.pid % 1000); // per-process, avoids collisions across runs
    server = spawn(
      "redis-server",
      ["--port", String(port), "--save", "", "--appendonly", "no", "--maxmemory-policy", "noeviction"],
      { stdio: "ignore" },
    );
    redis = new Redis(port, "127.0.0.1", { lazyConnect: false, maxRetriesPerRequest: 5, retryStrategy: (n) => (n > 20 ? null : 100) });
    hoisted.client = redis;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("redis did not become ready")), 10_000);
      redis.on("ready", () => { clearTimeout(timer); resolve(); });
      redis.on("error", () => { /* retry until ready or timeout */ });
    });
  }, 15_000);

  afterEach(async () => {
    await redis.flushall();
  });

  afterAll(async () => {
    await redis?.quit().catch(() => {});
    server?.kill("SIGKILL");
  });

  async function ok(res: live.ApplyProgressResult) {
    expect(res.ok).toBe(true);
    return res as Extract<live.ApplyProgressResult, { ok: true }>;
  }

  it("accepts a normal update and builds standings from the ZSET", async () => {
    await live.hydrateRace(RACE, cfg(), [seed("a"), seed("b")]);
    const r = await ok(await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 100, clientSeq: 1, deviceTotal: null, nowMs: LATE }));
    expect(r.accepted).toBe(true);
    expect(r.newSteps).toBe(100);

    const board = await live.getStandingsWithNames(RACE, 20);
    expect(board.map((s) => [s.userId, s.raceSteps, s.rank])).toEqual([
      ["a", 100, 1],
      ["b", 0, 2],
    ]);
    expect(board[0].username).toBe("user-a");
  });

  it("dedups stale/duplicate sequence ids", async () => {
    await live.hydrateRace(RACE, cfg(), [seed("a")]);
    await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 100, clientSeq: 5, deviceTotal: null, nowMs: LATE });
    const stale = await ok(await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 300, clientSeq: 3, deviceTotal: null, nowMs: LATE }));
    expect(stale.accepted).toBe(false);
    expect(stale.reason).toBe("stale_sequence");
    expect(stale.newSteps).toBe(100); // unchanged
  });

  it("is monotonic — a lower report never lowers steps", async () => {
    await live.hydrateRace(RACE, cfg(), [seed("a")]);
    await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 100, clientSeq: 1, deviceTotal: null, nowMs: LATE });
    const lower = await ok(await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 50, clientSeq: 2, deviceTotal: null, nowMs: LATE }));
    expect(lower.newSteps).toBe(100);
  });

  it("clamps an implausible jump to the cumulative budget and flags reconciliation", async () => {
    await live.hydrateRace(RACE, cfg({ targetSteps: 1_000_000 }), [seed("a")]);
    // elapsed 0 → maxCum = ceil(0*6) + burst(200) = 200
    const r = await ok(await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 100_000, clientSeq: 1, deviceTotal: null, nowMs: T0 }));
    expect(r.pendingReconciliation).toBe(true);
    expect(r.newSteps).toBe(live.LIVE_STEP_BURST); // 200
    expect(r.justFinished).toBe(false);
  });

  it("registers a device baseline then derives backend progress", async () => {
    await live.hydrateRace(RACE, cfg({ targetSteps: 1_000_000 }), [seed("a")]);
    // First sync with deviceTotal registers baseline; race steps stay 0.
    const reg = await ok(await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 0, clientSeq: 1, deviceTotal: 5000, nowMs: LATE }));
    expect(reg.newSteps).toBe(0);
    // Later sync: derived = 5200 - 5000 = 200.
    const derived = await ok(await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 0, clientSeq: 2, deviceTotal: 5200, nowMs: LATE }));
    expect(derived.newSteps).toBe(200);
  });

  it("crosses the goal with a monotonic acceptance ordinal and records pending finishes", async () => {
    await live.hydrateRace(RACE, cfg({ targetSteps: 1000 }), [seed("a"), seed("b")]);
    const fa = await ok(await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 1000, clientSeq: 1, deviceTotal: null, nowMs: LATE }));
    expect(fa.justFinished).toBe(true);
    expect(fa.finishOrdinal).toBe(1);
    const fb = await ok(await live.applyProgress({ raceId: RACE, userId: "b", requestedSteps: 1000, clientSeq: 1, deviceTotal: null, nowMs: LATE }));
    expect(fb.finishOrdinal).toBe(2);

    const pending = await live.getPendingFinishes(RACE);
    expect(pending).toEqual([
      { userId: "a", ordinal: 1 },
      { userId: "b", ordinal: 2 },
    ]);

    // A further tick from an already-finished user does not re-finish.
    const again = await ok(await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 1100, clientSeq: 2, deviceTotal: null, nowMs: LATE }));
    expect(again.justFinished).toBe(false);
    expect(again.finishedGoal).toBe(true);

    await live.markFinishOfficial(RACE, "a");
    expect(await live.getPendingFinishes(RACE)).toEqual([{ userId: "b", ordinal: 2 }]);
  });

  it("orders live standings finishers-first by acceptance ordinal", async () => {
    await live.hydrateRace(RACE, cfg({ targetSteps: 100 }), [seed("a"), seed("b"), seed("c")]);
    await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 100, clientSeq: 1, deviceTotal: null, nowMs: LATE }); // ordinal 1
    await live.applyProgress({ raceId: RACE, userId: "b", requestedSteps: 100, clientSeq: 1, deviceTotal: null, nowMs: LATE }); // ordinal 2
    await live.applyProgress({ raceId: RACE, userId: "c", requestedSteps: 50, clientSeq: 1, deviceTotal: null, nowMs: LATE }); // unfinished

    const board = await live.getStandingsWithNames(RACE, 20);
    expect(board.map((s) => s.userId)).toEqual(["a", "b", "c"]);
    expect(board.map((s) => [s.finishedGoal, s.finishRank])).toEqual([
      [true, 1],
      [true, 2],
      [false, null],
    ]);
  });

  it("rejects updates once the race is frozen for finalization", async () => {
    await live.hydrateRace(RACE, cfg(), [seed("a")]);
    await live.setRaceState(RACE, live.LIVE_RACE_STATE.FROZEN);
    const r = await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 100, clientSeq: 1, deviceTotal: null, nowMs: LATE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_active");
  });

  it("resumes the ordinal counter past already-finished participants on rehydrate", async () => {
    // A rehydrated race where 'a' already finished rank 1; 'b' still active.
    await live.hydrateRace(RACE, cfg({ targetSteps: 1000 }), [
      seed("a", { currentSteps: 1000, finishedGoal: true, finishRank: 1 }),
      seed("b", { currentSteps: 500 }),
    ]);
    const fb = await ok(await live.applyProgress({ raceId: RACE, userId: "b", requestedSteps: 1000, clientSeq: 1, deviceTotal: null, nowMs: LATE }));
    expect(fb.justFinished).toBe(true);
    expect(fb.finishOrdinal).toBe(2); // not 1 — counter resumed from max existing rank
  });

  it("snapshots all participants and drains the dirty set", async () => {
    await live.hydrateRace(RACE, cfg({ targetSteps: 1_000_000 }), [seed("a"), seed("b")]);
    await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 300, clientSeq: 1, deviceTotal: null, nowMs: LATE });
    await live.applyProgress({ raceId: RACE, userId: "b", requestedSteps: 100, clientSeq: 1, deviceTotal: null, nowMs: LATE });

    const snap = await live.snapshotRace(RACE);
    expect(new Map(snap.map((s) => [s.userId, s.steps]))).toEqual(new Map([["a", 300], ["b", 100]]));

    const dirty = await live.drainDirtyParticipants(RACE);
    expect(dirty.sort()).toEqual(["a", "b"]);
    expect(await live.drainDirtyParticipants(RACE)).toEqual([]); // drained
  });

  it("coalesces broadcasts via a cross-process lease", async () => {
    await live.hydrateRace(RACE, cfg(), [seed("a")]);
    expect(await live.tryAcquireBroadcastLease(RACE, 1000)).toBe(true);
    expect(await live.tryAcquireBroadcastLease(RACE, 1000)).toBe(false); // still leased
  });

  it("returns not_hydrated for an unknown participant/race", async () => {
    const r = await live.applyProgress({ raceId: "nope", userId: "x", requestedSteps: 10, clientSeq: 1, deviceTotal: null, nowMs: LATE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_hydrated");
  });

  // ── §7/§8/§17: session, sequence, offline replay ──────────────────────────────
  it("a new session preserves accepted progress and bypasses the stale-sequence guard", async () => {
    await live.hydrateRace(RACE, cfg({ targetSteps: 1_000_000 }), [seed("a")]);
    await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 500, clientSeq: 1, deviceTotal: null, nowMs: LATE, sessionId: "s1", liveSource: "android_step_counter" });
    // New session restarts the client counter at 1 — normally a stale reject, but the session change
    // legitimately restarts it. Progress is preserved (never lowered).
    const rotated = await ok(await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 0, clientSeq: 1, deviceTotal: null, nowMs: LATE, sessionId: "s2" }));
    expect(rotated.accepted).toBe(true);
    expect(rotated.newSteps).toBe(500); // preserved, not reset to 0
    // The new session then advances normally.
    const adv = await ok(await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 600, clientSeq: 2, deviceTotal: null, nowMs: LATE, sessionId: "s2" }));
    expect(adv.newSteps).toBe(600);
  });

  it("Android reboot: a new session re-registers the device baseline without lowering progress", async () => {
    await live.hydrateRace(RACE, cfg({ targetSteps: 1_000_000 }), [seed("a")]);
    await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 0, clientSeq: 1, deviceTotal: 5000, nowMs: LATE, sessionId: "s1" });
    await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 0, clientSeq: 2, deviceTotal: 5300, nowMs: LATE, sessionId: "s1" }); // derived 300
    // Reboot: device counter reset, new session, new (unrelated) device total. Baseline re-registers
    // from the new total; race progress is preserved at 300 (monotonic max), never derived downward.
    const reboot = await ok(await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 0, clientSeq: 1, deviceTotal: 80, nowMs: LATE, sessionId: "s2" }));
    expect(reboot.newSteps).toBe(300);
    const after = await ok(await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 0, clientSeq: 2, deviceTotal: 380, nowMs: LATE, sessionId: "s2" }));
    expect(after.newSteps).toBe(300); // derived 380-80=300, still preserved
  });

  it("offline replay compaction keeps the highest cumulative value (1000, 1250, retry 1000 ⇒ 1250)", async () => {
    await live.hydrateRace(RACE, cfg({ targetSteps: 1_000_000 }), [seed("a")]);
    const a = await ok(await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 1000, clientSeq: 1, deviceTotal: null, nowMs: LATE }));
    expect(a.newSteps).toBe(1000);
    const b = await ok(await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 1250, clientSeq: 2, deviceTotal: null, nowMs: LATE }));
    expect(b.newSteps).toBe(1250);
    const retryA = await ok(await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 1000, clientSeq: 1, deviceTotal: null, nowMs: LATE }));
    expect(retryA.accepted).toBe(false); // stale sequence
    expect(retryA.newSteps).toBe(1250); // final accepted total unchanged
  });

  it("persists live source + session id on the participant hash", async () => {
    await live.hydrateRace(RACE, cfg(), [seed("a")]);
    await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 100, clientSeq: 1, deviceTotal: null, nowMs: LATE, sessionId: "sess-xyz", liveSource: "ios_pedometer" });
    const [hash] = await live.getParticipantsState(RACE, ["a"]);
    expect(hash.liveSessionId).toBe("sess-xyz");
    expect(hash.liveSource).toBe("ios_pedometer");
  });
});
