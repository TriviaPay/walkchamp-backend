import { beforeEach, describe, expect, it, vi } from "vitest";

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
      innerJoin: vi.fn(() => query),
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
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(undefined).then(resolve, reject),
    };
    return insert;
  }

  function makeUpdate(table: unknown) {
    const update = {
      set: vi.fn((set: unknown) => {
        state.updates.push({ table, set });
        return update;
      }),
      where: vi.fn(() => update),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(undefined).then(resolve, reject),
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
    sendPushToUsers: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
});

vi.mock("../../db/src/index.js", () => ({ db: mocks.db }));
vi.mock("../routes/push.js", () => ({
  sendPushToUser: vi.fn(),
  sendPushToUsers: mocks.sendPushToUsers,
}));
vi.mock("../lib/logger.js", () => ({ logger: mocks.logger }));

async function loadService() {
  return import("../lib/pushNotificationService.js");
}

function resetMockState() {
  mocks.state.selectResults = [];
  mocks.state.insertReturningResults = [];
  mocks.state.inserts = [];
  mocks.state.updates = [];
  mocks.db.select.mockClear();
  mocks.db.insert.mockClear();
  mocks.db.update.mockClear();
  mocks.sendPushToUsers.mockReset();
  mocks.logger.info.mockClear();
  mocks.logger.warn.mockClear();
}

describe("notifyGroupsOnDailyGoalCompletion", () => {
  beforeEach(() => {
    resetMockState();
    mocks.sendPushToUsers.mockResolvedValue({
      requestedUserIds: ["userB"],
      eligibleUserIds: ["userB"],
      batches: [{ userIds: ["userB"], status: "sent" }],
    });
  });

  it("sends to the other member in a 2-member group", async () => {
    const { notifyGroupsOnDailyGoalCompletion } = await loadService();
    mocks.state.selectResults = [
      [{ username: "Alice" }],
      [{ groupId: "group1", groupName: "Morning Crew" }],
      [{ userId: "userA" }, { userId: "userB" }],
      [],
      [],
    ];
    mocks.state.insertReturningResults = [[{ id: "event1" }]];

    const result = await notifyGroupsOnDailyGoalCompletion({
      completedUserId: "userA",
      currentSteps: 10000,
      goalSteps: 10000,
      localDate: "2026-07-06",
      timezone: "America/New_York",
    });

    expect(result).toMatchObject({ groupsFound: 1, eventsCreated: 1, sentGroups: 1 });
    expect(mocks.sendPushToUsers).toHaveBeenCalledWith(
      ["userB"],
      "🏆 Daily Goal Completed",
      "Alice completed their daily goal in Morning Crew!",
      expect.objectContaining({
        type: "group_daily_goal_completed",
        groupId: "group1",
        completedUserId: "userA",
        deepLink: "walkchamp://walking-groups/group1",
        dedupeKey: "group_daily_goal_completed:userA:group1:2026-07-06",
      }),
      expect.objectContaining({
        url: "walkchamp://walking-groups/group1",
        dedupeKey: "group_daily_goal_completed:userA:group1:2026-07-06",
      }),
    );
    expect(mocks.state.inserts[0].values).toMatchObject({
      completedUserId: "userA",
      groupId: "group1",
      recipientUserIds: ["userB"],
      dataPayload: expect.objectContaining({
        dedupeKey: "group_daily_goal_completed:userA:group1:2026-07-06",
      }),
      status: "pending",
    });
    expect(mocks.state.inserts[1].values).toEqual([
      expect.objectContaining({ userId: "userB", type: "group_daily_goal_completed" }),
    ]);
  });

  it("sends to the other 9 members in a 10-member group", async () => {
    const { notifyGroupsOnDailyGoalCompletion } = await loadService();
    const members = Array.from({ length: 10 }, (_, index) => ({ userId: `user${index}` }));
    mocks.state.selectResults = [
      [{ username: "User Zero" }],
      [{ groupId: "group10", groupName: "Big Team" }],
      members,
      [],
      [],
    ];
    mocks.state.insertReturningResults = [[{ id: "event10" }]];
    mocks.sendPushToUsers.mockResolvedValue({
      requestedUserIds: members.slice(1).map((m) => m.userId),
      eligibleUserIds: members.slice(1).map((m) => m.userId),
      batches: [{ userIds: members.slice(1).map((m) => m.userId), status: "sent" }],
    });

    const result = await notifyGroupsOnDailyGoalCompletion({
      completedUserId: "user0",
      currentSteps: 12000,
      goalSteps: 10000,
      localDate: "2026-07-06",
      timezone: "UTC",
    });

    expect(result.sentGroups).toBe(1);
    expect(mocks.sendPushToUsers).toHaveBeenCalledWith(
      members.slice(1).map((m) => m.userId),
      expect.any(String),
      expect.any(String),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("creates one event and send per active group", async () => {
    const { notifyGroupsOnDailyGoalCompletion } = await loadService();
    mocks.state.selectResults = [
      [{ username: "Alice" }],
      [
        { groupId: "group1", groupName: "Morning Crew" },
        { groupId: "group2", groupName: "Evening Crew" },
        { groupId: "group3", groupName: "Weekend Crew" },
      ],
      [{ userId: "userA" }, { userId: "userB" }],
      [],
      [],
      [{ userId: "userA" }, { userId: "userC" }],
      [],
      [],
      [{ userId: "userA" }, { userId: "userD" }],
      [],
      [],
    ];
    mocks.state.insertReturningResults = [[{ id: "event1" }], [{ id: "event2" }], [{ id: "event3" }]];
    mocks.sendPushToUsers
      .mockResolvedValueOnce({
        requestedUserIds: ["userB"],
        eligibleUserIds: ["userB"],
        batches: [{ userIds: ["userB"], status: "sent" }],
      })
      .mockResolvedValueOnce({
        requestedUserIds: ["userC"],
        eligibleUserIds: ["userC"],
        batches: [{ userIds: ["userC"], status: "sent" }],
      })
      .mockResolvedValueOnce({
        requestedUserIds: ["userD"],
        eligibleUserIds: ["userD"],
        batches: [{ userIds: ["userD"], status: "sent" }],
      });

    const result = await notifyGroupsOnDailyGoalCompletion({
      completedUserId: "userA",
      currentSteps: 11000,
      goalSteps: 10000,
      localDate: "2026-07-06",
      timezone: "UTC",
    });

    expect(result).toMatchObject({ groupsFound: 3, eventsCreated: 3, sentGroups: 3 });
    expect(mocks.sendPushToUsers).toHaveBeenCalledTimes(3);
    expect(mocks.sendPushToUsers).toHaveBeenNthCalledWith(
      1,
      ["userB"],
      expect.any(String),
      expect.stringContaining("Morning Crew"),
      expect.objectContaining({ groupId: "group1" }),
      expect.objectContaining({ url: "walkchamp://walking-groups/group1" }),
    );
    expect(mocks.sendPushToUsers).toHaveBeenNthCalledWith(
      2,
      ["userC"],
      expect.any(String),
      expect.stringContaining("Evening Crew"),
      expect.objectContaining({ groupId: "group2" }),
      expect.objectContaining({ url: "walkchamp://walking-groups/group2" }),
    );
    expect(mocks.sendPushToUsers).toHaveBeenNthCalledWith(
      3,
      ["userD"],
      expect.any(String),
      expect.stringContaining("Weekend Crew"),
      expect.objectContaining({ groupId: "group3" }),
      expect.objectContaining({ url: "walkchamp://walking-groups/group3" }),
    );
  });

  it("skips duplicate events when the idempotency insert conflicts", async () => {
    const { notifyGroupsOnDailyGoalCompletion } = await loadService();
    mocks.state.selectResults = [
      [{ username: "Alice" }],
      [{ groupId: "group1", groupName: "Morning Crew" }],
      [{ userId: "userA" }, { userId: "userB" }],
      [],
      [],
    ];
    mocks.state.insertReturningResults = [[]];

    const result = await notifyGroupsOnDailyGoalCompletion({
      completedUserId: "userA",
      currentSteps: 10000,
      goalSteps: 10000,
      localDate: "2026-07-06",
      timezone: "UTC",
    });

    expect(result).toMatchObject({ eventsCreated: 0, skippedDuplicate: 1, sentGroups: 0 });
    expect(mocks.sendPushToUsers).not.toHaveBeenCalled();
  });

  it("excludes activity-disabled and blocked recipients", async () => {
    const { notifyGroupsOnDailyGoalCompletion } = await loadService();
    mocks.state.selectResults = [
      [{ username: "Alice" }],
      [{ groupId: "group1", groupName: "Morning Crew" }],
      [{ userId: "userA" }, { userId: "userB" }, { userId: "userC" }],
      [{ userId: "userB", receiveFriendActivityNotifications: false }],
      [{ blockerId: "userC", blockedId: "userA" }],
    ];
    mocks.state.insertReturningResults = [[{ id: "event1" }]];

    const result = await notifyGroupsOnDailyGoalCompletion({
      completedUserId: "userA",
      currentSteps: 10000,
      goalSteps: 10000,
      localDate: "2026-07-06",
      timezone: "UTC",
    });

    expect(result).toMatchObject({ eventsCreated: 1, skippedNoRecipients: 1, sentGroups: 0 });
    expect(mocks.sendPushToUsers).not.toHaveBeenCalled();
    expect(mocks.state.inserts[0].values).toMatchObject({
      recipientUserIds: [],
      status: "skipped_no_recipients",
    });
  });
});
