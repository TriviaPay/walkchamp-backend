// HTTP-level tests for POST /api/races/:id/verify (§12 in-race verified submission). Uses the
// mocked-db + express-mount pattern (see race-leaderboard-endpoint.test.ts). The hybrid flag is
// enabled via env before the router is imported.
import express from "express";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn(), insert: vi.fn() }));

vi.mock("../../db/src/index.js", () => ({
  db: { select: mocks.select, update: mocks.update, insert: mocks.insert, transaction: vi.fn() },
}));
vi.mock("../middleware/requireAuth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { descopeUserId: string }).descopeUserId = "user-1";
    next();
  },
}));

function selectReturning<T>(rows: T[]) {
  const q = { from: () => q, where: () => q, limit: async () => rows } as Record<string, unknown>;
  return q;
}

let app: express.Express;

beforeAll(async () => {
  process.env.ENABLE_HYBRID_RECONCILIATION = "true";
  process.env.ADMIN_SERVICE_KEY = "test-admin-key";
  const racesRouter = (await import("../routes/races.js")).default;
  mocks.update.mockReturnValue({ set: () => ({ where: async () => undefined }) });
  mocks.insert.mockReturnValue({ values: () => ({ catch: () => undefined }) });
  app = express();
  app.use(express.json());
  // The real app attaches req.log via pino-http; provide a no-op logger for the mounted router.
  app.use((req, _res, next) => {
    const noop = () => {};
    (req as unknown as { log: unknown }).log = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
    next();
  });
  app.use("/api", racesRouter);
});

afterAll(() => {
  vi.restoreAllMocks();
});

async function get(path: string) {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: "Bearer t" } });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

async function post(path: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t", ...extraHeaders },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

const activeRoom = {
  status: "in_progress", startedAt: new Date(Date.now() - 60_000), completedAt: null,
  challengeEndAt: null, challengeDurationDays: 0, scheduledStartAt: null,
};
const activeParticipant = { status: "active", verifiedCumulativeSteps: null, verifiedMeasuredAt: null };

const validBody = {
  verifiedCumulativeSteps: 5000, source: "healthkit", measuredAtUtc: new Date().toISOString(),
};

describe("POST /races/:id/verify", () => {
  it("accepts a HealthKit verification for an active participant", async () => {
    mocks.select.mockReturnValueOnce(selectReturning([activeRoom])).mockReturnValueOnce(selectReturning([activeParticipant]));
    const { status, json } = await post("/api/races/r1/verify", validBody);
    expect(status).toBe(200);
    expect(json.accepted).toBe(true);
    expect(json.verifiedCumulativeSteps).toBe(5000);
  });

  it("accepts a Health Connect verification", async () => {
    mocks.select.mockReturnValueOnce(selectReturning([activeRoom])).mockReturnValueOnce(selectReturning([activeParticipant]));
    const { status, json } = await post("/api/races/r1/verify", { ...validBody, source: "health_connect" });
    expect(status).toBe(200);
    expect(json.accepted).toBe(true);
  });

  it("rejects an unsupported verification source (§3 pairing)", async () => {
    const { status } = await post("/api/races/r1/verify", { ...validBody, source: "android_step_counter" });
    expect(status).toBe(400);
  });

  it("rejects a negative total", async () => {
    const { status } = await post("/api/races/r1/verify", { ...validBody, verifiedCumulativeSteps: -1 });
    expect(status).toBe(400);
  });

  it("rejects a forfeited participant (§19)", async () => {
    mocks.select
      .mockReturnValueOnce(selectReturning([activeRoom]))
      .mockReturnValueOnce(selectReturning([{ status: "forfeited", verifiedCumulativeSteps: null, verifiedMeasuredAt: null }]));
    const { status, json } = await post("/api/races/r1/verify", validBody);
    expect(status).toBe(409);
    expect(json.participant_status).toBe("forfeited");
  });

  it("ignores a stale verification (older measurement than stored)", async () => {
    mocks.select
      .mockReturnValueOnce(selectReturning([activeRoom]))
      .mockReturnValueOnce(selectReturning([{ status: "active", verifiedCumulativeSteps: 8000, verifiedMeasuredAt: new Date(Date.now()) }]));
    const { status, json } = await post("/api/races/r1/verify", {
      ...validBody, verifiedCumulativeSteps: 9000, measuredAtUtc: new Date(Date.now() - 3_600_000).toISOString(),
    });
    expect(status).toBe(200);
    expect(json.accepted).toBe(false);
    expect(json.reason).toBe("stale_verification");
  });

  it("is monotonic — a lower verified total never lowers the stored value", async () => {
    mocks.select
      .mockReturnValueOnce(selectReturning([activeRoom]))
      .mockReturnValueOnce(selectReturning([{ status: "active", verifiedCumulativeSteps: 10000, verifiedMeasuredAt: new Date(Date.now() - 10_000) }]));
    const { status, json } = await post("/api/races/r1/verify", { ...validBody, verifiedCumulativeSteps: 6000 });
    expect(status).toBe(200);
    expect(json.accepted).toBe(true);
    expect(json.verifiedCumulativeSteps).toBe(10000); // max(10000, 6000)
  });

  it("404s for an unknown race", async () => {
    mocks.select.mockReturnValueOnce(selectReturning([])).mockReturnValueOnce(selectReturning([]));
    const { status } = await post("/api/races/rX/verify", validBody);
    expect(status).toBe(404);
  });
});

describe("POST /races/:id/verification-resolve (ops)", () => {
  const admin = { "x-service-key": "test-admin-key" };
  const heldParticipant = { currentSteps: 4000, verifiedCumulativeSteps: null, reconciliationStatus: "review_required" };

  it("requires the admin service key", async () => {
    const { status } = await post("/api/races/r1/verification-resolve", { userId: "u2", decision: "approve" });
    expect(status).toBe(401);
  });

  it("approves a held participant and finalizes", async () => {
    mocks.select.mockReturnValueOnce(selectReturning([heldParticipant]));
    mocks.select.mockReturnValue(selectReturning([])); // autoCompleteRace retry sees no in_progress room
    const { status, json } = await post("/api/races/r1/verification-resolve", { userId: "u2", decision: "approve", steps: 4200 }, admin);
    expect(status).toBe(200);
    expect(json.resolved).toBe(true);
    expect(json.decision).toBe("approve");
  });

  it("rejects (disqualifies) a held participant", async () => {
    mocks.select.mockReturnValueOnce(selectReturning([heldParticipant]));
    mocks.select.mockReturnValue(selectReturning([]));
    const { status, json } = await post("/api/races/r1/verification-resolve", { userId: "u2", decision: "reject" }, admin);
    expect(status).toBe(200);
    expect(json.decision).toBe("reject");
  });

  it("is a no-op for an already-finalized participant", async () => {
    mocks.select.mockReturnValueOnce(selectReturning([{ ...heldParticipant, reconciliationStatus: "finalized" }]));
    const { status, json } = await post("/api/races/r1/verification-resolve", { userId: "u2", decision: "approve" }, admin);
    expect(status).toBe(200);
    expect(json.resolved).toBe(false);
    expect(json.reason).toBe("already_finalized");
  });

  it("rejects an invalid decision", async () => {
    const { status } = await post("/api/races/r1/verification-resolve", { userId: "u2", decision: "bogus" }, admin);
    expect(status).toBe(400);
  });

  it("404s for an unknown participant", async () => {
    mocks.select.mockReturnValueOnce(selectReturning([]));
    const { status } = await post("/api/races/r1/verification-resolve", { userId: "ghost", decision: "approve" }, admin);
    expect(status).toBe(404);
  });
});

describe("GET /races/:id/result-status (frontend authority)", () => {
  const completedRoom = { status: "completed", settlementStatus: "paid" };
  const inProgressRoom = { status: "in_progress", settlementStatus: null };

  it("returns authoritative steps/rank/payout only when finalized", async () => {
    mocks.select
      .mockReturnValueOnce(selectReturning([completedRoom]))
      .mockReturnValueOnce(selectReturning([{ status: "completed", currentSteps: 12000, reconciledSteps: 12480, reconciliationStatus: "finalized" }]))
      .mockReturnValueOnce(selectReturning([{ rank: 2, steps: 12480, prizeCents: 5000, status: "verified" }]));
    const { status, json } = await get("/api/races/r1/result-status");
    expect(status).toBe(200);
    expect(json.verificationStatus).toBe("finalized");
    expect(json.steps).toBe(12480);
    expect(json.rank).toBe(2);
    expect(json.payoutCents).toBe(5000);
  });

  it("hides final fields and shows provisional live while under review", async () => {
    mocks.select
      .mockReturnValueOnce(selectReturning([{ status: "in_progress", settlementStatus: "review_required" }]))
      .mockReturnValueOnce(selectReturning([{ status: "active", currentSteps: 9000, reconciledSteps: null, reconciliationStatus: "review_required" }]))
      .mockReturnValueOnce(selectReturning([]));
    const { json } = await get("/api/races/r1/result-status");
    expect(json.verificationStatus).toBe("review_required");
    expect(json.steps).toBeNull();
    expect(json.rank).toBeNull();
    expect(json.payoutCents).toBeNull();
    expect(json.liveSteps).toBe(9000); // provisional only
  });

  it("reports 'live' with provisional steps while the race is in progress", async () => {
    mocks.select
      .mockReturnValueOnce(selectReturning([inProgressRoom]))
      .mockReturnValueOnce(selectReturning([{ status: "active", currentSteps: 4200, reconciledSteps: null, reconciliationStatus: "pending" }]))
      .mockReturnValueOnce(selectReturning([]));
    const { json } = await get("/api/races/r1/result-status");
    expect(json.verificationStatus).toBe("live");
    expect(json.steps).toBeNull();
    expect(json.liveSteps).toBe(4200);
  });

  it("404s for an unknown race", async () => {
    mocks.select.mockReturnValueOnce(selectReturning([])).mockReturnValueOnce(selectReturning([])).mockReturnValueOnce(selectReturning([]));
    const { status } = await get("/api/races/rX/result-status");
    expect(status).toBe(404);
  });
});
