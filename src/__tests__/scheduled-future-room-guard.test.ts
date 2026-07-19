import express from "express";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  selectRows: [] as unknown[][],
  txSelectRows: [] as unknown[][],
  transaction: vi.fn(),
  triggerEvent: vi.fn(),
  validateThemeOwnership: vi.fn(),
  setUserDefaultTrackTheme: vi.fn(),
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
    select: vi.fn(() => {
      const rows = mocks.selectRows.shift() ?? [];
      return selectQuery(rows);
    }),
    transaction: mocks.transaction,
  },
}));

vi.mock("../lib/config.js", () => ({
  config: {
    logLevel: "silent",
    features: {
      cashFeaturesEnabled: true,
      coinEntryChallengesEnabled: true,
    },
  },
}));

vi.mock("../middleware/requireAuth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { descopeUserId: string }).descopeUserId = "host-user";
    next();
  },
}));

vi.mock("../lib/raceIntegrity.js", () => ({
  deriveOpenRoomStatus: (currentPlayers: number, maxPlayers: number) =>
    currentPlayers >= maxPlayers ? "full" : "open",
  lockRaceRoom: vi.fn(),
  joinOrReviveParticipant: vi.fn(),
  lockScheduledRegistration: vi.fn(),
  registerOrReviveScheduledRegistration: vi.fn(),
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
  validateThemeOwnership: mocks.validateThemeOwnership,
  setUserDefaultTrackTheme: mocks.setUserDefaultTrackTheme,
}));

vi.mock("../lib/trackThemeMedia.js", () => ({
  TRACK_THEME_CODES: ["bg"],
  buildTrackThemeMedia: (code: string) => ({
    code,
    imageSet: null,
    imageUrl: `/api/track-themes/${code}/image`,
  }),
}));

import racesRouter from "../routes/races.js";

function updateBuilder() {
  const builder = {
    set: vi.fn(() => builder),
    where: vi.fn(async () => []),
  };
  return builder;
}

function insertBuilder<T>(rows: T[]) {
  const builder = {
    values: vi.fn(() => builder),
    returning: vi.fn(async () => rows),
  };
  return builder;
}

function makeTx(insertRows: unknown[][] = []) {
  return {
    execute: vi.fn(async () => []),
    select: vi.fn(() => {
      const rows = mocks.txSelectRows.shift() ?? [];
      return selectQuery(rows);
    }),
    update: vi.fn(() => updateBuilder()),
    insert: vi.fn(() => insertBuilder(insertRows.shift() ?? [])),
  };
}

const futureScheduledRoomConflict = {
  roomId: "44444444-4444-4444-8444-444444444444",
  roomStatus: "scheduled",
  type: "quick",
  entryType: "free",
  creatorId: "host-user",
  scheduledStartAt: new Date("2099-08-05T12:30:00Z"),
  challengeEndAt: new Date("2099-08-12T12:30:00Z"),
};

const createdFutureRoom = {
  id: "55555555-5555-4555-8555-555555555555",
  creatorId: "host-user",
  title: "Free Challenge",
  type: "quick",
  entryType: "free",
  entryAmountCents: 0,
  targetSteps: 10000,
  maxPlayers: 10,
  currentPlayers: 0,
  status: "scheduled",
  countryCode: null,
  teamACountry: null,
  teamACountryCode: null,
  teamBCountry: null,
  teamBCountryCode: null,
  inviteCode: null,
  isPrivate: false,
  prizePoolCents: 0,
  winnersPoolCents: 0,
  platformFeeCents: 0,
  coinEntryAmount: 0,
  coinPrizePool: 0,
  coinWinnersPool: 0,
  coinPlatformFee: 0,
  rewardsProcessed: false,
  spectatorCount: 0,
  goalType: "daily",
  trackLayout: "bg",
  rewardSplitJson: null,
  winnerCount: 0,
  unawardedAmountCents: 0,
  payoutFinalizedAt: null,
  startedAt: null,
  completedAt: null,
  scheduleType: "future",
  scheduledStartAt: new Date("2099-09-01T12:30:00Z"),
  challengeDurationDays: 7,
  challengeEndAt: new Date("2099-09-08T12:30:00Z"),
  registeredCount: 1,
  createdAt: new Date("2026-07-19T18:00:00Z"),
  updatedAt: new Date("2026-07-19T18:00:00Z"),
};

async function postHostScheduledRoom() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { info: () => void; warn: () => void; error: () => void } }).log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    next();
  });
  app.use("/api", racesRouter);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));

  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a port");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/races/host`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        entryType: "free",
        maxPlayers: 10,
        targetSteps: 10000,
        trackLayout: "bg",
        isPrivate: false,
        goalType: "daily",
        scheduledStartAtIso: "2099-09-01T12:30:00.000Z",
        challengeDurationDays: 7,
        timezone: "America/Chicago",
      }),
    });
    const text = await response.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
    return { status: response.status, json, text };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("scheduled future room creation guard", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.selectRows = [];
    mocks.txSelectRows = [];
  });

  it("uses the dedicated future-room conflict response and availability payload", () => {
    const racesRoute = readFileSync("src/routes/races.ts", "utf8");

    expect(racesRoute).toContain('const FUTURE_ROOM_CREATION_EXISTS_CODE = "FUTURE_ROOM_CREATION_EXISTS"');
    expect(racesRoute).toContain('const FUTURE_ROOM_CREATION_EXISTS_TITLE = "Cannot create room"');
    expect(racesRoute).toContain(
      "You already have a scheduled room. You can create a new future room only after your current scheduled room has been completed, cancelled, or closed.",
    );
    expect(racesRoute).toContain("futureRoomCreation");
    expect(racesRoute).toContain("canCreateFutureRoom: false");
    expect(racesRoute).toContain("canCreateFutureRoom: true");
  });

  it("only treats future scheduled non-sponsored rooms as blocking rooms", () => {
    const racesRoute = readFileSync("src/routes/races.ts", "utf8");
    const helper = racesRoute.slice(
      racesRoute.indexOf("async function getActiveFutureScheduledRoomForUser"),
      racesRoute.indexOf("// ── Shared helper: find an active non-sponsored race"),
    );

    expect(helper).toContain('eq(scheduledRoomRegistrationsTable.status, "registered")');
    expect(helper).toContain('eq(raceRoomsTable.status, "scheduled")');
    expect(helper).toContain('ne(raceRoomsTable.type, "sponsored")');
    expect(helper).toContain("scheduledStartAt} > ${now}");
    expect(helper).not.toContain('"completed"');
    expect(helper).not.toContain('"cancelled"');
    expect(helper).not.toContain('"closed"');
  });

  it("blocks creating another future room before the generic regular-race guard runs", async () => {
    mocks.validateThemeOwnership.mockResolvedValue(true);
    mocks.selectRows = [
      [futureScheduledRoomConflict],
    ];

    const result = await postHostScheduledRoom();

    expect(result.status, result.text).toBe(409);
    expect(result.json).toMatchObject({
      success: false,
      code: "FUTURE_ROOM_CREATION_EXISTS",
      title: "Cannot create room",
      message:
        "You already have a scheduled room. You can create a new future room only after your current scheduled room has been completed, cancelled, or closed.",
      scheduled_room: {
        room_id: futureScheduledRoomConflict.roomId,
        room_status: "scheduled",
        room_type: "quick",
        challenge_type: "free",
        current_user_role: "host",
        scheduled_start_at: "2099-08-05T12:30:00.000Z",
        challenge_end_at: "2099-08-12T12:30:00.000Z",
        next_screen: "waiting_room",
      },
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("re-checks inside the transaction to prevent duplicate future rooms from concurrent requests", async () => {
    mocks.validateThemeOwnership.mockResolvedValue(true);
    const tx = makeTx();
    mocks.transaction.mockImplementation(async (callback: (txArg: typeof tx) => Promise<unknown>) => callback(tx));
    mocks.selectRows = [
      [],
      [],
      [],
      [],
    ];
    mocks.txSelectRows = [
      [futureScheduledRoomConflict],
    ];

    const result = await postHostScheduledRoom();

    expect(result.status, result.text).toBe(409);
    expect(result.json).toMatchObject({
      success: false,
      code: "FUTURE_ROOM_CREATION_EXISTS",
      title: "Cannot create room",
      scheduled_room: {
        room_id: futureScheduledRoomConflict.roomId,
        next_screen: "waiting_room",
      },
    });
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("allows scheduled future room creation when the user has no active future scheduled room", async () => {
    mocks.validateThemeOwnership.mockResolvedValue(true);
    mocks.setUserDefaultTrackTheme.mockResolvedValue(true);
    const tx = makeTx([
      [createdFutureRoom],
      [],
    ]);
    mocks.transaction.mockImplementation(async (callback: (txArg: typeof tx) => Promise<unknown>) => callback(tx));
    mocks.selectRows = [
      [],
      [],
      [],
      [],
    ];
    mocks.txSelectRows = [
      [],
      [],
      [],
      [],
    ];

    const result = await postHostScheduledRoom();

    expect(result.status, result.text).toBe(201);
    expect(result.json).toMatchObject({
      raceId: createdFutureRoom.id,
      isScheduled: true,
      scheduledStartAt: "2099-09-01T12:30:00.000Z",
    });
    expect(tx.insert).toHaveBeenCalledTimes(2);
    expect(mocks.setUserDefaultTrackTheme).toHaveBeenCalledWith("host-user", "bg");
  });
});
