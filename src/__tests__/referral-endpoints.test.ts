import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  selectRows: [] as unknown[][],
  txSelectRows: [] as unknown[][],
  transaction: vi.fn(),
  setSpy: vi.fn(),
}));

// Chainable, thenable query stub: every builder method returns the same object, and awaiting it
// (with or without .limit()/.for()) resolves to the queued rows.
function selectQuery(rows: unknown[]) {
  const p = Promise.resolve(rows);
  const q: Record<string, unknown> = {
    from: () => q,
    innerJoin: () => q,
    where: () => q,
    orderBy: () => q,
    for: () => q,
    limit: () => q,
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => p.then(res, rej),
  };
  return q;
}

function makeTx() {
  return {
    select: () => selectQuery(mocks.txSelectRows.shift() ?? []),
    update: () => ({
      set: (v: unknown) => {
        mocks.setSpy(v);
        return { where: async () => [] };
      },
    }),
  };
}

vi.mock("../../db/src/index.js", () => ({
  db: {
    select: () => selectQuery(mocks.selectRows.shift() ?? []),
    transaction: mocks.transaction,
  },
}));

vi.mock("../lib/referralBonusService.js", () => ({
  REFERRAL_BONUS_CENTS: 300,
  REFERRAL_BONUS_CURRENCY: "usd",
}));

vi.mock("../middleware/requireAuth.js", () => {
  const attach = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { descopeUserId: string }).descopeUserId = "me-user";
    next();
  };
  return { requireAuth: attach, requireJwtOnly: attach };
});

import referralRouter from "../routes/referral.js";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api", referralRouter);
  return a;
}

async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const server = app().listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const resp = await fetch(`http://127.0.0.1:${addr.port}/api${path}`, {
      method,
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await resp.text();
    let json: Record<string, unknown> | null = null;
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = null; }
    return { status: resp.status, json, text };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const referrer = { id: "friend-user", username: "friend", fullName: "Friend F", referralCode: "WCFRIEND" };

describe("GET /api/referral/validate", () => {
  afterEach(() => { vi.clearAllMocks(); mocks.selectRows = []; mocks.txSelectRows = []; });

  it("rejects an empty code without a lookup", async () => {
    const r = await call("GET", "/referral/validate?code=");
    expect(r.json).toEqual({ valid: false, reason: "empty" });
  });

  it("returns the referrer for a valid code", async () => {
    mocks.selectRows = [[referrer]];
    const r = await call("GET", "/referral/validate?code=WCFRIEND");
    expect(r.json).toMatchObject({ valid: true, referrer: { username: "friend", fullName: "Friend F" } });
  });

  it("returns not_found for an unknown code", async () => {
    mocks.selectRows = [[]];
    const r = await call("GET", "/referral/validate?code=NOPE");
    expect(r.json).toEqual({ valid: false, reason: "not_found" });
  });
});

describe("POST /api/referral/apply", () => {
  afterEach(() => { vi.clearAllMocks(); mocks.selectRows = []; mocks.txSelectRows = []; });

  function withTx() {
    const tx = makeTx();
    mocks.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
    return tx;
  }

  it("applies a code and stores the referrer's id", async () => {
    withTx();
    mocks.txSelectRows = [
      [{ id: "me-user", referredBy: null }], // me (for update)
      [referrer],                             // resolveReferrer
      [{ n: 0 }],                             // no prior cash entries
    ];
    const r = await call("POST", "/referral/apply", { code: "WCFRIEND" });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ applied: true, referrer: { username: "friend" } });
    expect(mocks.setSpy).toHaveBeenCalledWith(expect.objectContaining({ referredBy: "friend-user" }));
  });

  it("rejects when a code was already applied", async () => {
    withTx();
    mocks.txSelectRows = [[{ id: "me-user", referredBy: "WCOTHER" }]];
    const r = await call("POST", "/referral/apply", { code: "WCFRIEND" });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: "already_referred" });
    expect(mocks.setSpy).not.toHaveBeenCalled();
  });

  it("rejects an invalid code", async () => {
    withTx();
    mocks.txSelectRows = [[{ id: "me-user", referredBy: null }], []];
    const r = await call("POST", "/referral/apply", { code: "NOPE" });
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ error: "invalid_code" });
  });

  it("rejects after the first cash challenge (window closed)", async () => {
    withTx();
    mocks.txSelectRows = [
      [{ id: "me-user", referredBy: null }],
      [referrer],
      [{ n: 1 }], // already entered a cash challenge
    ];
    const r = await call("POST", "/referral/apply", { code: "WCFRIEND" });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: "window_closed" });
    expect(mocks.setSpy).not.toHaveBeenCalled();
  });

  it("rejects a missing code body", async () => {
    const r = await call("POST", "/referral/apply", {});
    expect(r.status).toBe(400);
  });
});

describe("GET /api/referral (dashboard)", () => {
  afterEach(() => { vi.clearAllMocks(); mocks.selectRows = []; mocks.txSelectRows = []; });

  it("summarizes the caller's referrals with credited/pending status", async () => {
    mocks.selectRows = [
      [{ id: "me-user", referralCode: "WCME" }], // me
      [
        { id: "u1", username: "alice", joinedAt: new Date("2026-07-01T00:00:00Z") },
        { id: "u2", username: "bob", joinedAt: new Date("2026-07-02T00:00:00Z") },
      ],
      [{ referredUserId: "u1", amountCents: 300, creditedAt: new Date("2026-07-03T00:00:00Z") }],
    ];
    const r = await call("GET", "/referral");
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({
      referralCode: "WCME",
      bonusAmount: 3,
      currency: "usd",
      summary: { totalReferred: 2, credited: 1, pending: 1, totalEarned: 3, totalEarnedMinor: 300 },
    });
    const referrals = (r.json as { referrals: Array<{ userId: string; status: string }> }).referrals;
    expect(referrals.find((x) => x.userId === "u1")?.status).toBe("credited");
    expect(referrals.find((x) => x.userId === "u2")?.status).toBe("pending");
  });
});
