import express from "express";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  txSelectRows: [] as unknown[][],
  transaction: vi.fn(),
  triggerEvent: vi.fn(),
  lockRaceRoom: vi.fn(),
  lockScheduledRegistration: vi.fn(),
  registerOrReviveScheduledRegistration: vi.fn(),
}));

function selectQuery(rows: unknown[]) {
  const query = {
    from: vi.fn(() => query),
    innerJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(async () => rows),
  };
  return query;
}

vi.mock("../../db/src/index.js", () => ({
  db: {
    select: vi.fn(() => selectQuery([])),
    transaction: mocks.transaction,
  },
}));

vi.mock("../lib/config.js", () => ({
  config: {
    logLevel: "silent",
    features: { cashFeaturesEnabled: true, coinEntryChallengesEnabled: true },
  },
}));

vi.mock("../middleware/requireAuth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { descopeUserId: string }).descopeUserId = "racer-user";
    next();
  },
}));

vi.mock("../lib/raceIntegrity.js", () => ({
  deriveOpenRoomStatus: (currentPlayers: number, maxPlayers: number) =>
    currentPlayers >= maxPlayers ? "full" : "open",
  lockRaceRoom: mocks.lockRaceRoom,
  joinOrReviveParticipant: vi.fn(),
  lockScheduledRegistration: mocks.lockScheduledRegistration,
  registerOrReviveScheduledRegistration: mocks.registerOrReviveScheduledRegistration,
}));

vi.mock("../lib/cashChallengePayments.js", () => ({
  creditCashChallengePrizes: vi.fn(),
  debitCashChallengeEntry: vi.fn(),
  hasCompletedEntryPayment: vi.fn(),
}));

vi.mock("../lib/referralBonusService.js", () => ({
  grantReferralBonusForCashChallenge: vi.fn(),
}));

vi.mock("../lib/pusher.js", () => ({
  triggerEvent: mocks.triggerEvent.mockResolvedValue(undefined),
}));

vi.mock("../routes/trackThemes.js", () => ({
  validateThemeOwnership: vi.fn(),
  setUserDefaultTrackTheme: vi.fn(),
}));

vi.mock("../lib/trackThemeMedia.js", () => ({
  TRACK_THEME_CODES: ["bg"],
  buildTrackThemeMedia: (code: string) => ({ code, imageSet: null, imageUrl: `/api/track-themes/${code}/image` }),
}));

import racesRouter from "../routes/races.js";

function makeTx() {
  const updateBuilder = () => {
    const b = { set: vi.fn(() => b), where: vi.fn(async () => []) };
    return b;
  };
  return {
    execute: vi.fn(async () => []),
    select: vi.fn(() => selectQuery(mocks.txSelectRows.shift() ?? [])),
    update: vi.fn(() => updateBuilder()),
  };
}

const sponsoredRoom = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "sponsored",
  status: "scheduled",
  registeredCount: 3,
  maxPlayers: 100,
};

const sponsoredConflict = {
  roomId: "22222222-2222-4222-8222-222222222222",
  roomStatus: "in_progress",
  type: "sponsored",
  entryType: "free",
  creatorId: "someone-else",
  scheduledStartAt: new Date("2099-08-05T12:30:00Z"),
  challengeEndAt: new Date("2099-08-12T12:30:00Z"),
};

async function postRegister(roomId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { info: () => void; warn: () => void; error: () => void } }).log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    };
    next();
  });
  app.use("/api", racesRouter);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/rooms/${roomId}/register`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const text = await response.text();
    let json: Record<string, unknown> | null = null;
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = null; }
    return { status: response.status, json, text };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("sponsored event single-registration guard", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.txSelectRows = [];
  });

  it("defines the dedicated sponsored conflict response and helper filters", () => {
    const src = readFileSync("src/routes/races.ts", "utf8");
    expect(src).toContain('const SPONSORED_EVENT_REGISTRATION_EXISTS_CODE = "SPONSORED_EVENT_REGISTRATION_EXISTS"');
    expect(src).toContain(
      "You can register for only one Sponsored Event at a time. Leave your current Sponsored Event or wait until it has been completed before registering for another.",
    );
    const helper = src.slice(
      src.indexOf("async function getActiveSponsoredRegistrationForUser"),
      src.indexOf("// ── Shared helper: find an active non-sponsored race"),
    );
    expect(helper).toContain('eq(raceRoomsTable.type, "sponsored")');
    expect(helper).toContain('inArray(raceRoomsTable.status, ["open", "full", "in_progress"])');
    expect(helper).toContain('eq(scheduledRoomRegistrationsTable.status, "registered")');
    expect(helper).toContain('eq(raceRoomsTable.status, "scheduled")');
  });

  it("blocks registering for a sponsored event while already in one", async () => {
    const tx = makeTx();
    mocks.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
    mocks.lockRaceRoom.mockResolvedValue(sponsoredRoom);
    mocks.txSelectRows = [[sponsoredConflict]]; // active participant in another sponsored event

    const result = await postRegister(sponsoredRoom.id);

    expect(result.status, result.text).toBe(409);
    expect(result.json).toMatchObject({
      success: false,
      code: "SPONSORED_EVENT_REGISTRATION_EXISTS",
      title: "Already in a Sponsored Event",
      sponsored_event: {
        room_id: sponsoredConflict.roomId,
        room_status: "in_progress",
        room_type: "sponsored",
        current_user_role: "participant",
        next_screen: "waiting_room",
      },
    });
    expect(mocks.registerOrReviveScheduledRegistration).not.toHaveBeenCalled();
  });

  it("allows registering when the user is in no other sponsored event", async () => {
    const tx = makeTx();
    mocks.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
    mocks.lockRaceRoom.mockResolvedValue(sponsoredRoom);
    mocks.lockScheduledRegistration.mockResolvedValue(null);
    mocks.registerOrReviveScheduledRegistration.mockResolvedValue({ changed: true });
    mocks.txSelectRows = [[], []]; // no participating + no scheduled sponsored registration

    const result = await postRegister(sponsoredRoom.id);

    expect(result.status, result.text).toBe(200);
    expect(result.json).toMatchObject({ success: true, registered: true, registered_count: 4 });
    expect(mocks.registerOrReviveScheduledRegistration).toHaveBeenCalledTimes(1);
  });
});
