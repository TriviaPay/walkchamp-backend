import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
    selectResults: [] as unknown[][],
    insertReturningResults: [] as unknown[][],
    inserts: [] as { table: unknown; values: unknown }[],
    updates: [] as { table: unknown; set: unknown }[],
  };

  function makeQuery(result: unknown[]) {
    const query = {
      from: vi.fn(() => query),
      leftJoin: vi.fn(() => query),
      where: vi.fn(() => query),
      limit: vi.fn(() => query),
      then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return query;
  }

  function makeInsert(table: unknown) {
    const insert = {
      values: vi.fn((values: unknown) => {
        state.inserts.push({ table, values });
        return insert;
      }),
      onConflictDoNothing: vi.fn(() => insert),
      returning: vi.fn(() => Promise.resolve(state.insertReturningResults.shift() ?? [])),
    };
    return insert;
  }

  function makeUpdate(table: unknown) {
    const update = {
      set: vi.fn((set: unknown) => {
        state.updates.push({ table, set });
        return update;
      }),
      where: vi.fn(() => Promise.resolve(undefined)),
    };
    return update;
  }

  return {
    state,
    db: {
      select: vi.fn(() => makeQuery(state.selectResults.shift() ?? [])),
      insert: vi.fn((table: unknown) => makeInsert(table)),
      update: vi.fn((table: unknown) => makeUpdate(table)),
    },
    sendPushToUser: vi.fn(),
    triggerEvent: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

vi.mock("../../db/src/index.js", () => ({ db: mocks.db }));
vi.mock("../routes/push.js", () => ({ sendPushToUser: mocks.sendPushToUser }));
vi.mock("../lib/pusher.js", () => ({ triggerEvent: mocks.triggerEvent }));
vi.mock("../lib/logger.js", () => ({ logger: mocks.logger }));
vi.mock("../lib/raceIntegrity.js", () => ({
  deriveOpenRoomStatus: vi.fn(),
  joinOrReviveParticipant: vi.fn(),
  lockRaceRoom: vi.fn(),
}));

async function loadScheduler() {
  return import("../lib/scheduler.js");
}

function resetMockState() {
  mocks.state.selectResults = [];
  mocks.state.insertReturningResults = [];
  mocks.state.inserts = [];
  mocks.state.updates = [];
  mocks.db.select.mockClear();
  mocks.db.insert.mockClear();
  mocks.db.update.mockClear();
  mocks.sendPushToUser.mockReset();
  mocks.triggerEvent.mockReset();
  mocks.logger.info.mockClear();
  mocks.logger.warn.mockClear();
  mocks.logger.error.mockClear();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runDailyGoalReminderTick", () => {
  beforeEach(() => {
    resetMockState();
    mocks.sendPushToUser.mockResolvedValue("sent");
  });

  it("skips users before 6 PM local time", async () => {
    const { runDailyGoalReminderTick } = await loadScheduler();
    mocks.state.selectResults = [
      [{ userId: "userA", dailyGoal: 10000, timezone: "UTC" }],
    ];

    const result = await runDailyGoalReminderTick(new Date("2026-07-06T17:59:00.000Z"));

    expect(result).toMatchObject({ scanned: 1, eligible: 0, sent: 0 });
    expect(mocks.sendPushToUser).not.toHaveBeenCalled();
    expect(mocks.db.insert).not.toHaveBeenCalled();
  });

  it("sends the daily goal reminder at 6 PM local time with the walk deep link", async () => {
    const { runDailyGoalReminderTick } = await loadScheduler();
    mocks.state.selectResults = [
      [{ userId: "userA", dailyGoal: 10000, timezone: "UTC" }],
      [{ userId: "userA", steps: 4500, date: "2026-07-06" }],
    ];
    mocks.state.insertReturningResults = [[{ id: "delivery1" }]];

    const result = await runDailyGoalReminderTick(new Date("2026-07-06T18:00:00.000Z"));

    expect(result).toMatchObject({ scanned: 1, eligible: 1, inserted: 1, sent: 1 });
    expect(mocks.sendPushToUser).toHaveBeenCalledWith(
      "userA",
      "Complete Your Daily Goal",
      "You still have time to complete your daily step goal today!",
      {
        type: "daily_goal_reminder",
        screen: "walk",
        localDate: "2026-07-06",
        todaySteps: 4500,
        dailyGoal: 10000,
      },
      {
        url: "walkchamp://walk",
        dedupeKey: "daily_goal_reminder:userA:2026-07-06",
      },
    );
    expect(mocks.state.updates[0].set).toMatchObject({ status: "sent" });
  });

  it("uses each user's timezone and treats missing step rows as zero", async () => {
    const { runDailyGoalReminderTick } = await loadScheduler();
    mocks.state.selectResults = [
      [
        { userId: "nyUser", dailyGoal: 8000, timezone: "America/New_York" },
        { userId: "utcUser", dailyGoal: 10000, timezone: "UTC" },
      ],
      [],
      [],
    ];
    mocks.state.insertReturningResults = [[{ id: "deliveryNy" }], [{ id: "deliveryUtc" }]];

    const result = await runDailyGoalReminderTick(new Date("2026-07-06T22:00:00.000Z"));

    expect(result).toMatchObject({ scanned: 2, eligible: 2, inserted: 2, sent: 2 });
    expect(mocks.sendPushToUser).toHaveBeenCalledTimes(2);
    expect(mocks.sendPushToUser).toHaveBeenNthCalledWith(
      1,
      "nyUser",
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ localDate: "2026-07-06", todaySteps: 0, dailyGoal: 8000 }),
      expect.objectContaining({ dedupeKey: "daily_goal_reminder:nyUser:2026-07-06" }),
    );
    expect(mocks.sendPushToUser).toHaveBeenNthCalledWith(
      2,
      "utcUser",
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ localDate: "2026-07-06", todaySteps: 0, dailyGoal: 10000 }),
      expect.objectContaining({ dedupeKey: "daily_goal_reminder:utcUser:2026-07-06" }),
    );
  });

  it("skips users who already completed their daily goal", async () => {
    const { runDailyGoalReminderTick } = await loadScheduler();
    mocks.state.selectResults = [
      [{ userId: "userA", dailyGoal: 10000, timezone: "UTC" }],
      [{ userId: "userA", steps: 10000, date: "2026-07-06" }],
    ];

    const result = await runDailyGoalReminderTick(new Date("2026-07-06T18:00:00.000Z"));

    expect(result).toMatchObject({ scanned: 1, eligible: 0, sent: 0 });
    expect(mocks.sendPushToUser).not.toHaveBeenCalled();
  });

  it("falls back to UTC when a stored timezone is invalid", async () => {
    const { runDailyGoalReminderTick } = await loadScheduler();
    mocks.state.selectResults = [
      [{ userId: "userA", dailyGoal: null, timezone: "Not/AZone" }],
      [],
    ];
    mocks.state.insertReturningResults = [[{ id: "delivery1" }]];

    const result = await runDailyGoalReminderTick(new Date("2026-07-06T18:00:00.000Z"));

    expect(result).toMatchObject({ scanned: 1, eligible: 1, inserted: 1, sent: 1 });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "userA", timezone: "Not/AZone" }),
      "[DailyGoalReminderJob] invalidTimezone",
    );
    expect(mocks.sendPushToUser).toHaveBeenCalledWith(
      "userA",
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ localDate: "2026-07-06", dailyGoal: 10000 }),
      expect.any(Object),
    );
  });

  it("does not send when notification delivery idempotency already exists", async () => {
    const { runDailyGoalReminderTick } = await loadScheduler();
    mocks.state.selectResults = [
      [{ userId: "userA", dailyGoal: 10000, timezone: "UTC" }],
      [{ userId: "userA", steps: 5000, date: "2026-07-06" }],
    ];
    mocks.state.insertReturningResults = [[]];

    const result = await runDailyGoalReminderTick(new Date("2026-07-06T18:00:00.000Z"));

    expect(result).toMatchObject({ scanned: 1, eligible: 1, inserted: 0, skipped: 1, sent: 0 });
    expect(mocks.sendPushToUser).not.toHaveBeenCalled();
  });
});

describe("runSchedulerTick daily goal reminder cadence", () => {
  beforeEach(() => {
    resetMockState();
    mocks.sendPushToUser.mockResolvedValue("sent");
  });

  it("runs the daily goal reminder scan at most once every 10 minutes", async () => {
    const { runSchedulerTick } = await loadScheduler();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T18:00:00.000Z"));

    mocks.state.selectResults = [
      [],
      [],
      [],
      [],
      [],
    ];

    await runSchedulerTick();

    vi.setSystemTime(new Date("2026-07-06T18:05:00.000Z"));
    await runSchedulerTick();

    expect(mocks.db.select).toHaveBeenCalledTimes(5);
  });
});
