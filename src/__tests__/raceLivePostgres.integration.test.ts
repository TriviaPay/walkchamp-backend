// Integration tests for the Postgres-write side of the redis-live design (Phase 2): the
// sequence-fenced checkpointer and on-demand participant hydration. These run against a REAL
// ephemeral Postgres + Redis, because the fence semantics and the redis↔postgres handoff can't
// be verified with mocks. Self-skips when postgres/redis binaries aren't installed (CI-safe).
import { type ChildProcess, execSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

function has(bin: string): boolean {
  try { execSync(`which ${bin}`, { stdio: "ignore" }); return true; } catch { return false; }
}
const CAN_RUN = has("redis-server") && has("initdb") && has("postgres");

const REDIS_PORT = 6540 + (process.pid % 400);
const PG_PORT = 6600 + (process.pid % 400);
const PG_URL = `postgres://postgres@127.0.0.1:${PG_PORT}/postgres`;

const hoisted = vi.hoisted(() => ({ client: null as unknown as Redis }));
vi.mock("../lib/redis.js", () => ({
  getRedisLive: () => hoisted.client,
  getRedisQueue: () => hoisted.client,
  getRedisCache: () => hoisted.client,
  ensureRedisLiveConnected: async () => {},
  ensureRedisQueueConnected: async () => {},
  ensureRedisCacheConnected: async () => {},
}));

// Loaded dynamically in beforeAll AFTER DATABASE_RUNTIME_URL is set, so config/db bind to the
// test database rather than throwing on a missing URL.
type LiveMod = typeof import("../lib/raceLiveState.js");
type HydMod = typeof import("../lib/raceLiveHydration.js");
type RegMod = typeof import("../lib/raceRegistry.js");
let live: LiveMod;
let hyd: HydMod;
let reg: RegMod;
let admin: pg.Pool;

const DDL = `
CREATE TABLE IF NOT EXISTS profiles (id text PRIMARY KEY, username text);
CREATE TABLE IF NOT EXISTS race_rooms (
  id text PRIMARY KEY, status text NOT NULL DEFAULT 'in_progress', type text NOT NULL DEFAULT 'solo',
  target_steps integer NOT NULL DEFAULT 1000, current_players integer NOT NULL DEFAULT 0,
  started_at timestamptz, challenge_end_at timestamptz,
  live_state_mode text NOT NULL DEFAULT 'postgres', live_state_version integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS race_participants (
  id text PRIMARY KEY, race_room_id text NOT NULL, user_id text NOT NULL,
  status text NOT NULL DEFAULT 'joined', current_steps integer NOT NULL DEFAULT 0,
  finished_goal boolean NOT NULL DEFAULT false, finished_at timestamptz, finished_at_ms bigint,
  finish_rank integer, race_baseline_steps integer NOT NULL DEFAULT 0,
  last_step_sequence_id integer NOT NULL DEFAULT 0
);
`;

let pgDir: string | undefined;
let pgProc: ChildProcess | undefined;
let redisProc: ChildProcess | undefined;
const savedEnv = { db: process.env.DATABASE_RUNTIME_URL, live: process.env.REDIS_LIVE_URL };

function seed(userId: string, extra: Record<string, unknown> = {}) {
  return {
    userId, participantId: `p-${userId}`, username: `user-${userId}`,
    currentSteps: 0, raceBaselineSteps: 0, lastStepSequenceId: -1, finishedGoal: false, finishRank: null,
    ...extra,
  };
}

async function startPostgres() {
  pgDir = mkdtempSync(join(tmpdir(), "wc-pg-"));
  execSync(`initdb -D "${pgDir}" -A trust -U postgres`, { stdio: "ignore" });
  pgProc = spawn("postgres", ["-D", pgDir, "-p", String(PG_PORT), "-c", "listen_addresses=127.0.0.1", "-c", "fsync=off"], { stdio: "ignore" });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const c = new pg.Client({ connectionString: PG_URL });
      await c.connect(); await c.query("select 1"); await c.end();
      return;
    } catch {
      if (Date.now() > deadline) throw new Error("postgres did not start");
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

async function startRedis() {
  redisProc = spawn("redis-server", ["--port", String(REDIS_PORT), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
  const client = new Redis(REDIS_PORT, "127.0.0.1", { lazyConnect: false, maxRetriesPerRequest: 5, retryStrategy: (n) => (n > 20 ? null : 100) });
  hoisted.client = client;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("redis not ready")), 10_000);
    client.on("ready", () => { clearTimeout(t); resolve(); });
    client.on("error", () => {});
  });
}

describe.skipIf(!CAN_RUN)("redis-live ↔ Postgres (integration)", () => {
  beforeAll(async () => {
    await startRedis();
    await startPostgres();
    process.env.DATABASE_RUNTIME_URL = PG_URL;
    // Non-null so checkpointRedisRaces' `config.redis.liveUrl` gate opens (the redis client
    // itself is mocked, so the value only needs to be truthy).
    process.env.REDIS_LIVE_URL = `redis://127.0.0.1:${REDIS_PORT}`;
    admin = new pg.Pool({ connectionString: PG_URL });
    await admin.query(DDL);
    live = await import("../lib/raceLiveState.js");
    hyd = await import("../lib/raceLiveHydration.js");
    reg = await import("../lib/raceRegistry.js");
  }, 40_000);

  afterEach(async () => {
    await hoisted.client.flushall();
    await admin.query("TRUNCATE profiles, race_rooms, race_participants");
  });

  afterAll(async () => {
    await admin?.end().catch(() => {});
    await hoisted.client?.quit().catch(() => {});
    redisProc?.kill("SIGKILL");
    // Wait for postgres to actually exit before removing its datadir, else rmSync races the
    // still-writing process ("Directory not empty").
    if (pgProc && !pgProc.killed) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5_000);
        pgProc!.once("exit", () => { clearTimeout(t); resolve(); });
        pgProc!.kill("SIGQUIT"); // fast, clean shutdown
      });
    }
    try {
      if (pgDir) rmSync(pgDir, { recursive: true, force: true });
    } catch { /* best-effort temp cleanup */ }
    // Restore env so a dead test-DB URL doesn't leak into other test files.
    if (savedEnv.db === undefined) delete process.env.DATABASE_RUNTIME_URL; else process.env.DATABASE_RUNTIME_URL = savedEnv.db;
    if (savedEnv.live === undefined) delete process.env.REDIS_LIVE_URL; else process.env.REDIS_LIVE_URL = savedEnv.live;
  });

  const RACE = "race-pg-1";
  const cfg = (o = {}) => ({
    status: live.LIVE_RACE_STATE.ACTIVE, startedAtMs: 1_700_000_000_000, challengeEndAtMs: null,
    targetSteps: 1_000_000, type: "solo", liveStateVersion: 0, ...o,
  });
  const nowMs = 1_700_000_000_000 + 3_600_000;

  async function insertParticipant(userId: string, steps = 0) {
    await admin.query("INSERT INTO profiles(id, username) VALUES($1,$2) ON CONFLICT DO NOTHING", [userId, `user-${userId}`]);
    await admin.query(
      "INSERT INTO race_participants(id, race_room_id, user_id, current_steps, status) VALUES($1,$2,$3,$4,'joined')",
      [`p-${userId}`, RACE, userId, steps],
    );
  }
  const pgSteps = async (userId: string) =>
    Number((await admin.query("SELECT current_steps FROM race_participants WHERE user_id=$1", [userId])).rows[0].current_steps);

  it("checkpoints changed participants from redis to Postgres", async () => {
    await live.hydrateRace(RACE, cfg(), [seed("a"), seed("b")]);
    await insertParticipant("a", 0);
    await insertParticipant("b", 0);
    await reg.markRaceActive(RACE, nowMs + 60_000);

    await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 300, clientSeq: 1, deviceTotal: null, nowMs });
    await live.applyProgress({ raceId: RACE, userId: "b", requestedSteps: 100, clientSeq: 1, deviceTotal: null, nowMs });

    await hyd.checkpointRedisRaces();
    expect(await pgSteps("a")).toBe(300);
    expect(await pgSteps("b")).toBe(100);
  });

  it("fence: a stale checkpoint never overwrites a newer Postgres value", async () => {
    await live.hydrateRace(RACE, cfg(), [seed("a")]);
    await insertParticipant("a", 0);
    await reg.markRaceActive(RACE, nowMs + 60_000);

    await live.applyProgress({ raceId: RACE, userId: "a", requestedSteps: 350, clientSeq: 1, deviceTotal: null, nowMs });
    // Simulate a newer finish already persisted to Postgres (e.g. via persistRedisFinish).
    await admin.query("UPDATE race_participants SET current_steps=500 WHERE user_id='a'");

    await hyd.checkpointRedisRaces(); // redis says 350, PG says 500 → fence blocks the downgrade
    expect(await pgSteps("a")).toBe(500);
  });

  it("checkpoint is DB-silent for a race that has no dirty participants", async () => {
    await live.hydrateRace(RACE, cfg(), [seed("a")]);
    await insertParticipant("a", 42);
    await reg.markRaceActive(RACE, nowMs + 60_000);
    await live.drainDirtyParticipants(RACE); // clear the dirty bit from hydrate

    await hyd.checkpointRedisRaces();
    expect(await pgSteps("a")).toBe(42); // untouched
  });

  it("ensureParticipantHydrated adds a late/missing participant from Postgres", async () => {
    // Race hydrated with only 'a'; 'b' joins after start (exists in Postgres, not in redis).
    await live.hydrateRace(RACE, cfg(), [seed("a")]);
    await insertParticipant("b", 25);

    // Before: b is not in redis → applyProgress reports not_hydrated.
    const before = await live.applyProgress({ raceId: RACE, userId: "b", requestedSteps: 30, clientSeq: 1, deviceTotal: null, nowMs });
    expect(before.ok).toBe(false);

    expect(await hyd.ensureParticipantHydrated(RACE, "b")).toBe(true);

    // After: b is in redis (seeded at 25) and progress is accepted.
    const after = await live.applyProgress({ raceId: RACE, userId: "b", requestedSteps: 30, clientSeq: 1, deviceTotal: null, nowMs });
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.newSteps).toBe(30);
  });

  it("ensureParticipantHydrated returns false for a user absent from Postgres", async () => {
    await live.hydrateRace(RACE, cfg(), [seed("a")]);
    expect(await hyd.ensureParticipantHydrated(RACE, "ghost")).toBe(false);
  });
});
