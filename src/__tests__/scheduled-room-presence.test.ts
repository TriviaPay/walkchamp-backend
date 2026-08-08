import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

// Queue of result sets, consumed in the order the route issues its selects.
const mocks = vi.hoisted(() => ({
  selectRows: [] as unknown[][],
  queries: 0,
}));

vi.mock("../../db/src/index.js", () => {
  const query = () => {
    mocks.queries += 1;
    const rows = mocks.selectRows.shift() ?? [];
    const q: Record<string, unknown> = {
      then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    for (const m of ["from", "innerJoin", "leftJoin", "where", "orderBy", "groupBy", "limit"]) {
      q[m] = vi.fn(() => q);
    }
    return q;
  };
  return {
    db: {
      select: vi.fn(query),
      selectDistinct: vi.fn(query),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: vi.fn(async () => []) })) })),
    },
  };
});

vi.mock("../middleware/requireAuth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { descopeUserId: string }).descopeUserId = "registrant-user";
    next();
  },
}));

vi.mock("../middleware/requireActiveAccount.js", () => ({
  requireActiveAccount: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../lib/pusher.js", () => ({ triggerEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/featureFlags.js", () => ({ isFeatureEnabled: vi.fn().mockResolvedValue(false) }));
vi.mock("../lib/config.js", () => ({ config: { logLevel: "silent" } }));

import presenceRouter from "../routes/presence.js";

const RACE_ID = "ae72c168-1137-441f-885e-e759137255dc";

async function getOnline() {
  const app = express();
  app.use("/api", presenceRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a port");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/presence/races/${RACE_ID}/online`, {
      headers: { authorization: "Bearer test-token" },
    });
    return { status: response.status, json: await response.json() as Record<string, any> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("GET /api/presence/races/:raceId/online — scheduled rooms", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.selectRows = [];
    mocks.queries = 0;
  });

  it("grants access to a scheduled registrant with no race_participants row", async () => {
    mocks.selectRows = [
      [],                                   // participant access — empty for a future room
      [],                                   // spectator access
      [{ id: "reg-1" }],                    // scheduled registration access
      [],                                   // participants roster
      [{ userId: "host-user" }, { userId: "registrant-user" }], // registrants roster
      [{ userId: "host-user" }],            // presence rows (only the host is online)
    ];

    const { status, json } = await getOnline();

    expect(status).toBe(200);
    expect(json.userIds).toEqual(["host-user"]);
  });

  it("still 403s a user with no participation, spectate, or registration", async () => {
    mocks.selectRows = [[], [], []];

    const { status, json } = await getOnline();

    expect(status).toBe(403);
    expect(json.error).toBe("Race access required");
  });

  it("unions participants and registrants without querying presence for an empty roster", async () => {
    mocks.selectRows = [
      [{ id: "p-1" }],                      // participant access
      [],                                   // spectator access
      [],                                   // registration access
      [],                                   // participants roster — empty
      [],                                   // registrants roster — empty
    ];

    const { status, json } = await getOnline();

    expect(status).toBe(200);
    expect(json.userIds).toEqual([]);
    // 3 access probes + 2 roster reads, and no presence query for an empty roster.
    expect(mocks.queries).toBe(5);
  });
});
