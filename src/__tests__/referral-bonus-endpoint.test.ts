import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  selectRows: [] as unknown[][],
  txSelectRows: [] as unknown[][],
  transaction: vi.fn(),
  debitCashChallengeEntry: vi.fn(),
  grantReferralBonusForCashChallenge: vi.fn(),
  triggerEvent: vi.fn(),
  lockRaceRoom: vi.fn(),
  joinOrReviveParticipant: vi.fn(),
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
    (req as express.Request & { descopeUserId: string }).descopeUserId = "referred-user";
    next();
  },
}));

vi.mock("../lib/raceIntegrity.js", () => ({
  deriveOpenRoomStatus: (currentPlayers: number, maxPlayers: number) =>
    currentPlayers >= maxPlayers ? "full" : "open",
  lockRaceRoom: mocks.lockRaceRoom,
  joinOrReviveParticipant: mocks.joinOrReviveParticipant,
  lockScheduledRegistration: vi.fn(),
  registerOrReviveScheduledRegistration: vi.fn(),
}));

vi.mock("../lib/cashChallengePayments.js", () => ({
  creditCashChallengePrizes: vi.fn(),
  debitCashChallengeEntry: mocks.debitCashChallengeEntry,
  hasCompletedEntryPayment: vi.fn(),
}));

vi.mock("../lib/referralBonusService.js", () => ({
  grantReferralBonusForCashChallenge: mocks.grantReferralBonusForCashChallenge,
}));

vi.mock("../lib/pusher.js", () => ({
  triggerEvent: mocks.triggerEvent.mockResolvedValue(undefined),
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

function makeTx() {
  return {
    execute: vi.fn(async () => []),
    select: vi.fn(() => {
      const rows = mocks.txSelectRows.shift() ?? [];
      return selectQuery(rows);
    }),
    update: vi.fn(() => updateBuilder()),
    insert: vi.fn(() => insertBuilder([])),
  };
}

const paidRoom = {
  id: "11111111-1111-4111-8111-111111111111",
  creatorId: "host-user",
  title: "$3 Challenge",
  type: "quick",
  entryType: "paid_3",
  entryAmountCents: 300,
  targetSteps: 5000,
  maxPlayers: 10,
  currentPlayers: 1,
  status: "open",
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
  scheduleType: "now",
  scheduledStartAt: null,
  challengeDurationDays: 0,
  challengeEndAt: null,
  registeredCount: 0,
  createdAt: new Date("2026-07-18T19:00:00Z"),
  updatedAt: new Date("2026-07-18T19:00:00Z"),
};

const scheduledRoom = {
  ...paidRoom,
  id: "22222222-2222-4222-8222-222222222222",
  title: "Scheduled Free Challenge",
  entryType: "free",
  entryAmountCents: 0,
  currentPlayers: 0,
  status: "scheduled",
  scheduledStartAt: new Date("2026-08-05T12:30:00Z"),
  registeredCount: 0,
};

const conflictingRegularRace = {
  roomId: "33333333-3333-4333-8333-333333333333",
  roomStatus: "scheduled",
  type: "quick",
  entryType: "coins_battle",
  entryAmountCents: 0,
  targetSteps: 10000,
  trackLayout: "bg",
  creatorId: "other-host",
  currentPlayers: 0,
  challengeDurationDays: 7,
  challengeEndAt: null,
  startedAt: null,
  scheduledStartAt: new Date("2026-07-31T12:30:00Z"),
  participantCurrentSteps: null,
  participantBaselineSteps: null,
};

async function postJoinPaid() {
  return postJson(`/api/races/${paidRoom.id}/join-paid`);
}

async function postRegisterScheduledRoom() {
  return postJson(`/api/rooms/${scheduledRoom.id}/register`);
}

async function postJson(path: string) {
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
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
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

function arrangeSuccessfulPaidJoin() {
  const tx = makeTx();
  mocks.transaction.mockImplementation(async (callback: (txArg: typeof tx) => Promise<unknown>) => callback(tx));
  mocks.lockRaceRoom.mockResolvedValue({ ...paidRoom });
  mocks.joinOrReviveParticipant.mockResolvedValue({
    changed: true,
    reason: "inserted",
    participant: {
      id: "participant-1",
      raceRoomId: paidRoom.id,
      userId: "referred-user",
      status: "joined",
    },
  });
  mocks.selectRows = [
    [], // regular race conflict participant check
    [], // regular race conflict scheduled-registration check
    [{ ...paidRoom }],
    [{ id: "referred-user", isAdult: true, paidRaceEnabled: true, accountStatus: "active", countryCode: "US" }],
    [{ id: "wallet-1", userId: "referred-user", availableBalanceCents: 1000 }],
    [{ countryCode: "US" }],
  ];
  mocks.txSelectRows = [
    [], // in-transaction regular race conflict participant check
    [], // in-transaction regular race conflict scheduled-registration check
  ];
  return tx;
}

describe("POST /api/races/:id/join-paid referral bonus trigger", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.selectRows = [];
    mocks.txSelectRows = [];
  });

  it("triggers the referral bonus after a successful first paid cash challenge join", async () => {
    arrangeSuccessfulPaidJoin();
    mocks.debitCashChallengeEntry.mockResolvedValue({ ok: true, balanceCents: 700 });
    mocks.grantReferralBonusForCashChallenge.mockResolvedValue({
      credited: true,
      awardId: "award-1",
      referrerUserId: "referrer-user",
      referredUserId: "referred-user",
    });

    const result = await postJoinPaid();

    expect(result.status, result.text).toBe(201);
    expect(mocks.debitCashChallengeEntry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "referred-user",
      raceRoomId: paidRoom.id,
      entryFeeCents: 300,
    }));
    expect(mocks.grantReferralBonusForCashChallenge).toHaveBeenCalledWith(expect.anything(), {
      referredUserId: "referred-user",
      raceRoomId: paidRoom.id,
    });
  });

  it("does not trigger the referral bonus when the cash challenge debit fails", async () => {
    arrangeSuccessfulPaidJoin();
    mocks.debitCashChallengeEntry.mockResolvedValue({ ok: false, error: "Insufficient balance.", balanceCents: 100 });

    const result = await postJoinPaid();

    expect(result.status).toBe(402);
    expect(result.json).toMatchObject({ error: "Insufficient balance." });
    expect(mocks.grantReferralBonusForCashChallenge).not.toHaveBeenCalled();
  });
});

describe("POST /api/rooms/:roomId/register regular race guard", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.selectRows = [];
    mocks.txSelectRows = [];
  });

  it("returns the Already Registered modal payload for another regular race registration", async () => {
    const tx = makeTx();
    mocks.transaction.mockImplementation(async (callback: (txArg: typeof tx) => Promise<unknown>) => callback(tx));
    mocks.lockRaceRoom.mockResolvedValue({ ...scheduledRoom });
    mocks.txSelectRows = [
      [conflictingRegularRace], // in-transaction regular race participant conflict
    ];

    const result = await postRegisterScheduledRoom();

    expect(result.status, result.text).toBe(409);
    expect(result.json).toMatchObject({
      success: false,
      code: "REGULAR_RACE_REGISTRATION_EXISTS",
      title: "Already Registered",
      message: "You are already registered for another race. Please withdraw from or complete your current race before registering for a new one.",
      active_race: {
        room_id: conflictingRegularRace.roomId,
        is_sponsored: false,
      },
    });
  });
});
