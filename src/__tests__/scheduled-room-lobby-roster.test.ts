import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  selectRows: [] as unknown[][],
  triggerEvent: vi.fn(),
}));

// Awaitable at any point in the chain — the race detail route ends some queries on
// .orderBy()/.where() and others on .limit().
function selectQuery(rows: unknown[]) {
  const query: Record<string, unknown> = {
    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
  };
  for (const method of ["from", "innerJoin", "leftJoin", "where", "orderBy", "groupBy", "limit"]) {
    query[method] = vi.fn(() => query);
  }
  return query;
}

vi.mock("../../db/src/index.js", () => ({
  db: {
    select: vi.fn(() => selectQuery(mocks.selectRows.shift() ?? [])),
    transaction: vi.fn(),
  },
}));

vi.mock("../lib/config.js", () => ({
  config: {
    logLevel: "silent",
    features: { cashFeaturesEnabled: true, coinEntryChallengesEnabled: true },
    waitingRoom: { openWindowMinutes: 30, openWindowMs: 30 * 60_000, minimumParticipants: 2 },
    redis: { liveUrl: null },
  },
}));

vi.mock("../middleware/requireAuth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { descopeUserId: string }).descopeUserId = "joiner-user";
    next();
  },
}));

vi.mock("../lib/pusher.js", () => ({
  triggerEvent: mocks.triggerEvent.mockResolvedValue(undefined),
}));

vi.mock("../lib/raceIntegrity.js", () => ({
  deriveOpenRoomStatus: (currentPlayers: number, maxPlayers: number) =>
    currentPlayers >= maxPlayers ? "full" : "open",
  lockRaceRoom: vi.fn(),
  joinOrReviveParticipant: vi.fn(),
  lockScheduledRegistration: vi.fn(),
  registerOrReviveScheduledRegistration: vi.fn(),
  isRaceParticipant: vi.fn(),
}));

vi.mock("../lib/cashChallengePayments.js", () => ({
  creditCashChallengePrizes: vi.fn(),
  debitCashChallengeEntry: vi.fn(),
  hasCompletedEntryPayment: vi.fn(),
}));

vi.mock("../lib/referralBonusService.js", () => ({
  grantReferralBonusForCashChallenge: vi.fn(),
}));

vi.mock("../routes/trackThemes.js", () => ({
  validateThemeOwnership: vi.fn(),
  setUserDefaultTrackTheme: vi.fn(),
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

const RACE_ID = "ae72c168-1137-441f-885e-e759137255dc";

const scheduledRoom = {
  id: RACE_ID,
  creatorId: "host-user",
  title: "Scheduled Challenge",
  type: "quick",
  entryType: "free",
  entryAmountCents: 0,
  targetSteps: 10000,
  maxPlayers: 10,
  currentPlayers: 0,
  status: "scheduled",
  countryCode: null,
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
  minimumParticipants: 2,
  payoutFinalizedAt: null,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  roomExpiresAt: null,
  scheduleType: "future",
  scheduledStartAt: new Date("2099-09-01T12:30:00Z"),
  challengeDurationDays: 7,
  challengeEndAt: new Date("2099-09-08T12:30:00Z"),
  registeredCount: 2,
  createdAt: new Date("2026-07-19T18:00:00Z"),
  updatedAt: new Date("2026-07-19T18:00:00Z"),
};

const registrationRows = [
  {
    registrationId: "reg-host",
    userId: "host-user",
    username: "krishnakommara",
    country: "IN",
    countryFlag: "🇮🇳",
    avatarColor: "#00E676",
    avatarUrl: "https://cdn.example.com/host.png",
    updatedAt: new Date("2026-07-01T00:00:00Z"),
  },
  {
    registrationId: "reg-joiner",
    userId: "joiner-user",
    username: "rppp1119",
    country: "US",
    countryFlag: "🇺🇸",
    avatarColor: "#2979FF",
    avatarUrl: null,
    updatedAt: new Date("2026-07-02T00:00:00Z"),
  },
];

async function getRaceDetail() {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
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
    const response = await fetch(`http://127.0.0.1:${address.port}/api/races/${RACE_ID}`, {
      headers: { authorization: "Bearer test-token" },
    });
    return { status: response.status, json: await response.json() as Record<string, any> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("GET /api/races/:id — scheduled room roster", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.selectRows = [];
  });

  it("returns registered users as participants when race_participants is still empty", async () => {
    mocks.selectRows = [
      [scheduledRoom],   // room lookup
      [],                // race_participants (empty until materialize-at-start)
      registrationRows,  // scheduled_room_registrations
      [],                // friends
      [],                // friend requests
      [],                // active titles
      [],                // track theme media
    ];

    const { status, json } = await getRaceDetail();

    expect(status).toBe(200);
    expect(json.participants).toHaveLength(2);
    expect(json.participants.length).toBe(json.race.registeredCount);
    expect(json.race.participantCount).toBe(2);
    expect(json.race.participant_count).toBe(2);

    const host = json.participants.find((p: any) => p.userId === "host-user");
    const joiner = json.participants.find((p: any) => p.userId === "joiner-user");
    expect(json.participants[0].userId).toBe("host-user"); // host first
    expect(host).toMatchObject({
      username: "krishnakommara",
      avatarUrl: "https://cdn.example.com/host.png",
      country: "IN",
      countryFlag: "🇮🇳",
      isHost: true,
      isCurrentUser: false,
      status: "registered",
      currentSteps: 0,
    });
    expect(joiner).toMatchObject({
      username: "rppp1119",
      country: "US",
      isHost: false,
      isCurrentUser: true,
      friendStatus: "self",
    });

    // Aliases the Waiting Room also reads
    expect(json.registrations).toHaveLength(2);
    expect(json.registeredParticipants).toHaveLength(2);
  });

  it("does not duplicate a user present in both tables", async () => {
    mocks.selectRows = [
      [scheduledRoom],
      [{
        id: "participant-host",
        userId: "host-user",
        currentSteps: 0,
        status: "joined",
        rank: null,
        finishedGoal: false,
        finishedAt: null,
        username: "krishnakommara",
        country: "IN",
        countryFlag: "🇮🇳",
        avatarColor: "#00E676",
        avatarUrl: null,
        updatedAt: new Date("2026-07-01T00:00:00Z"),
      }],
      registrationRows,
      [],
      [],
      [],
      [],
    ];

    const { status, json } = await getRaceDetail();

    expect(status).toBe(200);
    expect(json.participants).toHaveLength(2);
    expect(json.participants.filter((p: any) => p.userId === "host-user")).toHaveLength(1);
    expect(json.participants.find((p: any) => p.userId === "host-user").id).toBe("participant-host");
  });

  it("leaves non-scheduled rooms on the race_participants roster only", async () => {
    mocks.selectRows = [
      [{ ...scheduledRoom, status: "open", currentPlayers: 1, registeredCount: 0 }],
      [],       // race_participants
      [],       // friends/requests/titles are skipped when the roster is empty
      [],       // track theme media
    ];

    const { status, json } = await getRaceDetail();

    expect(status).toBe(200);
    expect(json.participants).toHaveLength(0);
    expect(json.registrations).toHaveLength(0);
    expect(json.race.participantCount).toBe(1);
  });
});
