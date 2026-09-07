import express from "express";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn() }));

vi.mock("../../db/src/index.js", () => ({
  db: {
    select: mocks.select,
    insert: mocks.insert,
    transaction: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock("../middleware/requireAuth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { descopeUserId: string }).descopeUserId = "user-1";
    next();
  },
}));

function selectReturning<T>(rows: T[]) {
  const query = {
    from: () => query,
    where: () => query,
    limit: async () => rows,
  };
  return query;
}

let app: express.Express;

beforeAll(async () => {
  process.env.LIVEKIT_URL = "wss://livekit.example.test";
  process.env.LIVEKIT_API_KEY = "test-api-key";
  process.env.LIVEKIT_API_SECRET = "test-api-secret-with-enough-entropy";
  mocks.insert.mockReturnValue({ values: () => ({ catch: () => undefined }) });

  const entitlementsRouter = (await import("../routes/entitlements.js")).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const noop = () => {};
    (req as unknown as { log: unknown }).log = {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
      trace: noop,
      fatal: noop,
    };
    next();
  });
  app.use("/api", entitlementsRouter);
});

beforeEach(() => {
  mocks.select.mockReset();
});

afterAll(() => {
  delete process.env.LIVEKIT_URL;
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
  vi.restoreAllMocks();
});

async function post(path: string) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { authorization: "Bearer test" },
    });
    return {
      status: response.status,
      json: await response.json() as Record<string, unknown>,
    };
  } finally {
    server.close();
  }
}

function mockStreak(status: string, participantStatus?: string, hasMicPass = false) {
  mocks.select
    .mockReturnValueOnce(selectReturning([]))
    .mockReturnValueOnce(selectReturning([{ id: "streak-1", status }]));
  if (participantStatus !== undefined) {
    mocks.select.mockReturnValueOnce(selectReturning([{ status: participantStatus }]));
    if (!["left", "forfeited", "withdrawn", "removed", "cancelled", "canceled", "disqualified"].includes(participantStatus)) {
      mocks.select.mockReturnValueOnce(selectReturning(hasMicPass ? [{ id: "mic-pass-1" }] : []));
    }
  } else {
    mocks.select.mockReturnValueOnce(selectReturning([]));
  }
}

describe("Streak Challenge voice token", () => {
  it("grants publish audio to an active Streak participant with Mic Pass", async () => {
    mockStreak("active", "active", true);
    const { status, json } = await post("/api/races/streak-1/voice-token");
    expect(status).toBe(200);
    expect(json).toMatchObject({
      room_name: "race_streak-1",
      can_publish_audio: true,
      url: "wss://livekit.example.test",
    });
    expect(typeof json.token).toBe("string");
  });

  it("issues listen-only access when the active Streak participant has no Mic Pass", async () => {
    mockStreak("starting", "goal_completed_today", false);
    const { status, json } = await post("/api/races/streak-1/voice-token");
    expect(status).toBe(200);
    expect(json.can_publish_audio).toBe(false);
  });

  it("issues listen-only access to an inactive Streak participant", async () => {
    mockStreak("settling", "forfeited");
    const { status, json } = await post("/api/races/streak-1/voice-token");
    expect(status).toBe(200);
    expect(json.can_publish_audio).toBe(false);
  });

  it("rejects a Streak non-participant without consulting classic spectate sessions", async () => {
    mockStreak("active");
    const { status, json } = await post("/api/races/streak-1/voice-token");
    expect(status).toBe(403);
    expect(json.code).toBe("VOICE_NOT_AUTHORIZED");
    expect(mocks.select).toHaveBeenCalledTimes(3);
  });

  it("rejects a non-live Streak Challenge", async () => {
    mockStreak("waiting");
    const { status, json } = await post("/api/races/streak-1/voice-token");
    expect(status).toBe(403);
    expect(json.code).toBe("RACE_NOT_LIVE");
  });

  it("returns RACE_NOT_FOUND when neither race table contains the id", async () => {
    mocks.select
      .mockReturnValueOnce(selectReturning([]))
      .mockReturnValueOnce(selectReturning([]));
    const { status, json } = await post("/api/races/missing/voice-token");
    expect(status).toBe(404);
    expect(json.code).toBe("RACE_NOT_FOUND");
  });

  it("supports the canonical Streak alias with the same room and response", async () => {
    mockStreak("active", "active", true);
    const { status, json } = await post("/api/streak-challenges/streak-1/voice-token");
    expect(status).toBe(200);
    expect(json).toMatchObject({ room_name: "race_streak-1", can_publish_audio: true });
  });

  it("preserves classic active-participant Mic Pass behavior", async () => {
    mocks.select
      .mockReturnValueOnce(selectReturning([{ id: "classic-1", status: "in_progress" }]))
      .mockReturnValueOnce(selectReturning([{ status: "joined" }]))
      .mockReturnValueOnce(selectReturning([{ id: "mic-pass-1" }]));
    const { status, json } = await post("/api/races/classic-1/voice-token");
    expect(status).toBe(200);
    expect(json).toMatchObject({ room_name: "race_classic-1", can_publish_audio: true });
  });
});
