import express from "express";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// USD cash-challenge lifecycle: paid challenges can't be cancelled after creation; host + participants
// may LEAVE (pre-start refund / post-start no refund, server-time boundary); leaving never cancels
// the challenge and never reassigns the host (creator name preserved — no ghost host).

const races = readFileSync("src/routes/races.ts", "utf8");
const refund = readFileSync("src/lib/refundService.ts", "utf8");
const uService = readFileSync("src/lib/unlimitedChallengeService.ts", "utf8");
const uRouter = readFileSync("src/routes/unlimitedChallenge.ts", "utf8");

describe("paid challenges cannot be cancelled after creation", () => {
  it("races /cancel rejects USD rooms with PAID_CHALLENGE_CANNOT_BE_CANCELLED", () => {
    expect(races).toContain('code: "PAID_CHALLENGE_CANNOT_BE_CANCELLED"');
    expect(races).toContain("Cash challenges cannot be cancelled after creation.");
    expect(races).toContain("if (room.entryAmountCents > 0)");
  });
  it("unlimited has no cancel endpoint", () => {
    expect(uRouter).not.toContain("/cancel");
  });
});

describe("races leave — server-time boundary, paid host may leave, creator preserved", () => {
  it("uses a server-authoritative pre-start boundary (not just status)", () => {
    expect(races).toContain("const startAtMs = room.startedAt?.getTime() ?? room.scheduledStartAt?.getTime() ?? null");
    expect(races).toContain("startAtMs === null || Date.now() < startAtMs");
  });
  it("only a FREE open room forces the host to cancel; paid host may leave", () => {
    expect(races).toContain("if (isPreStart && isHost && !isPaid)");
  });
  it("returns authoritative refund fields and never cancels the challenge", () => {
    expect(races).toContain("activeChallengeReleased: true");
    expect(races).toContain("challengeStatus: room.status"); // unchanged
    expect(races).toContain("refundEligible: true");
    expect(races).toContain("refundEligible: false"); // post-start
  });
  it("has NO ghost host — creator/host identity is left untouched", () => {
    expect(races).not.toContain("walk_champ_admin");
    expect(races).not.toContain("displayHostLeftAt");
    expect(races).not.toContain("ghostHost");
  });
});

describe("refundService — paid host refundable, server-time boundary", () => {
  it("HOST_MUST_CANCEL only applies to FREE rooms", () => {
    expect(refund).toContain("room.creatorId === input.userId && room.entryAmountCents === 0");
  });
  it("a scheduled room past its start instant is non-refundable (server time)", () => {
    expect(refund).toContain("room.scheduledStartAt && Date.now() >= room.scheduledStartAt.getTime()");
  });
  it("the participant-refund helper is reusable across race + unlimited", () => {
    expect(refund).toContain("export async function createRefundForRaceParticipantTx");
    expect(refund).toContain("input.sourceType ?? \"race\"");
  });
});

describe("unlimited leave — pre-start refund, idempotent, pool/count accounting", () => {
  it("entry is debited refundable so the pre-start refund can return the fee", () => {
    expect(uService).toContain("refundableAmountCents: input.entryFeeCents");
    expect(uService).toContain("refundableAmountCents: challenge.entryFeeCents");
  });
  it("pre-start boundary uses server time and an idempotent refund key", () => {
    expect(uService).toContain('challenge.status === "waiting" && Date.now() < challenge.startAtUtc.getTime()');
    expect(uService).toContain("`unlimited_leave:${challengeId}:${userId}`");
  });
  it("pre-start leave decrements pool + count; post-start keeps them", () => {
    expect(uService).toContain("GREATEST(${unlimitedChallengesTable.prizePoolCents} - ${participant.entryContributionCents}, 0)");
    // The count decrement is computed in JS (Math.max clamps at 0) rather than SQL GREATEST,
    // because nextCount is also returned as participantCount. That is safe only because the
    // challenge row is read FOR UPDATE inside the same transaction — assert both halves.
    expect(uService).toContain("const nextCount = Math.max(challenge.paidParticipantCount - 1, 0)");
    expect(uService).toContain("paidParticipantCount: nextCount");
    expect(uService).toContain('.limit(1).for("update")');
    expect(uService).toContain("Post-start: contribution stays in the pool");
  });
  it("host leaving preserves hostUserId (no reassignment / no ghost)", () => {
    expect(uService).not.toContain("walk_champ_admin");
    expect(uService).not.toContain("displayHostLeftAt");
  });
});

// ── HTTP: paid-cancel rejection (guard runs before any mutation) ──────────────
const mocks = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("../../db/src/index.js", () => ({ db: { select: mocks.select, transaction: vi.fn(), update: vi.fn(), insert: vi.fn() } }));
vi.mock("../middleware/requireAuth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { descopeUserId: string }).descopeUserId = "host-1";
    next();
  },
}));
function selectReturning<T>(rows: T[]) {
  const q = { from: () => q, where: () => q, limit: async () => rows } as Record<string, unknown>;
  return q;
}
let app: express.Express;
beforeAll(async () => {
  const racesRouter = (await import("../routes/races.js")).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const noop = () => {};
    (req as unknown as { log: unknown }).log = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
    next();
  });
  app.use("/api", racesRouter);
});
afterAll(() => vi.restoreAllMocks());

async function post(path: string, body: unknown) {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe("POST /races/:id/cancel (HTTP)", () => {
  it("rejects a paid room owned by the host with PAID_CHALLENGE_CANNOT_BE_CANCELLED", async () => {
    mocks.select.mockReturnValueOnce(selectReturning([{ id: "r1", creatorId: "host-1", entryAmountCents: 1000, status: "open" }]));
    const { status, json } = await post("/api/races/r1/cancel", {});
    expect(status).toBe(409);
    expect(json.code).toBe("PAID_CHALLENGE_CANNOT_BE_CANCELLED");
  });
  it("rejects a non-host with 403 (before the paid check)", async () => {
    mocks.select.mockReturnValueOnce(selectReturning([{ id: "r1", creatorId: "someone-else", entryAmountCents: 1000, status: "open" }]));
    const { status } = await post("/api/races/r1/cancel", {});
    expect(status).toBe(403);
  });
  it("404s for an unknown race", async () => {
    mocks.select.mockReturnValueOnce(selectReturning([]));
    const { status } = await post("/api/races/rX/cancel", {});
    expect(status).toBe(404);
  });
});
