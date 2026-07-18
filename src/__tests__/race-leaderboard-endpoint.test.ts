import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import leaderboardRouter from "../routes/leaderboard.js";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
}));

vi.mock("../../db/src/index.js", () => ({
  db: {
    select: mocks.select,
  },
}));

vi.mock("../middleware/requireAuth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { descopeUserId: string }).descopeUserId = "user-1";
    next();
  },
}));

function queryReturning<T>(rows: T[]) {
  const query = {
    from: vi.fn(() => query),
    innerJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    groupBy: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(async () => rows),
  };
  return query;
}

async function getJson(path: string) {
  const app = express();
  app.use("/api", leaderboardRouter);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));

  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a port");
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      headers: { authorization: "Bearer test-token" },
    });
    return {
      status: response.status,
      json: await response.json() as unknown,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("GET /api/leaderboard/races", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns combined top-3 race wins from the endpoint response", async () => {
    mocks.select.mockReturnValueOnce(queryReturning([
      {
        id: "user-1",
        username: "runner_one",
        fullName: "Runner One",
        country: "US",
        countryCode: "US",
        countryFlag: "🇺🇸",
        avatarColor: "#00E676",
        avatarUrl: null,
        updatedAt: new Date("2026-07-18T00:00:00Z"),
        wins: 3,
      },
      {
        id: "user-2",
        username: "runner_two",
        fullName: "Runner Two",
        country: "US",
        countryCode: "US",
        countryFlag: "🇺🇸",
        avatarColor: "#00B4FF",
        avatarUrl: null,
        updatedAt: new Date("2026-07-18T00:00:00Z"),
        wins: 2,
      },
    ]));

    const { status, json } = await getJson("/api/leaderboard/races");

    expect(status).toBe(200);
    expect(json).toMatchObject({
      userRank: 1,
      userWins: 3,
      leaderboard: [
        {
          id: "user-1",
          username: "runner_one",
          wins: 3,
          rank: 1,
        },
        {
          id: "user-2",
          username: "runner_two",
          wins: 2,
          rank: 2,
        },
      ],
    });
  });
});
