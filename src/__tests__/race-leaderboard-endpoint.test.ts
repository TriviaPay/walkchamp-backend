import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import leaderboardRouter from "../routes/leaderboard.js";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("../../db/src/index.js", () => ({
  db: {
    select: mocks.select,
    execute: mocks.execute,
  },
}));

vi.mock("../middleware/requireAuth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { descopeUserId: string }).descopeUserId = "user-1";
    next();
  },
}));

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
    mocks.execute.mockResolvedValueOnce({ rows: [
      {
        id: "user-1",
        username: "runner_one",
        full_name: "Runner One",
        country: "US",
        country_code: "US",
        country_flag: "🇺🇸",
        avatar_color: "#00E676",
        avatar_url: null,
        updated_at: new Date("2026-07-18T00:00:00Z"),
        wins: 3,
        total_winning_cents: 2500,
        rank: 1,
      },
      {
        id: "user-2",
        username: "runner_two",
        full_name: "Runner Two",
        country: "US",
        country_code: "US",
        country_flag: "🇺🇸",
        avatar_color: "#00B4FF",
        avatar_url: null,
        updated_at: new Date("2026-07-18T00:00:00Z"),
        wins: 2,
        total_winning_cents: 0,
        rank: 2,
      },
    ] });

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
          totalWinning: 25,
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
