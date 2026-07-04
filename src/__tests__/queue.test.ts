import { describe, expect, it } from "vitest";
import {
  getQueueRetentionPolicy,
  queueConnectionOptions,
} from "../lib/queue";
import { config } from "../lib/config";

describe("queue configuration", () => {
  it("makes producer connections fail fast when Redis is unavailable", () => {
    const options = queueConnectionOptions("producer", "redis://queue:6379/2");

    expect(options.enableOfflineQueue).toBe(false);
    expect(options.maxRetriesPerRequest).toBe(1);
    expect(options.commandTimeout).toBe(config.runtime.queueEnqueueTimeoutMs);
  });

  it("allows worker connections to retry indefinitely", () => {
    const options = queueConnectionOptions("worker", "redis://queue:6379/2");

    expect(options.enableOfflineQueue).toBe(true);
    expect(options.maxRetriesPerRequest).toBeNull();
    expect(options.commandTimeout).toBeUndefined();
  });

  it("bounds completed and failed BullMQ job retention by count and age", () => {
    expect(getQueueRetentionPolicy()).toEqual({
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: { age: 604_800, count: 10_000 },
    });
  });
});
