import { describe, expect, it } from "vitest";
import {
  evaluateRedisRuntime,
  parseRedisInfo,
  redisConfigPairsToObject,
} from "../lib/redisRuntimeValidation";

describe("redis runtime validation helpers", () => {
  it("normalizes CONFIG GET pairs", () => {
    expect(redisConfigPairsToObject([
      "maxmemory",
      "268435456",
      "maxmemory-policy",
      "allkeys-lfu",
    ])).toEqual({
      maxmemory: "268435456",
      "maxmemory-policy": "allkeys-lfu",
    });
  });

  it("parses INFO output", () => {
    expect(parseRedisInfo("# Memory\r\nused_memory:1024\r\nmaxmemory:2048\r\n")).toEqual({
      used_memory: "1024",
      maxmemory: "2048",
    });
  });

  it("accepts the expected cache Redis policy", () => {
    const status = evaluateRedisRuntime(
      "cache",
      { maxmemory: "268435456", "maxmemory-policy": "allkeys-lfu" },
      { used_memory: "1024" },
      { evicted_keys: "0" },
    );

    expect(status.ok).toBe(true);
    expect(status.errors).toEqual([]);
  });

  it("rejects queue Redis eviction and missing AOF", () => {
    const status = evaluateRedisRuntime(
      "queue",
      {
        maxmemory: "268435456",
        "maxmemory-policy": "allkeys-lfu",
        appendonly: "no",
        appendfsync: "always",
      },
      { used_memory: "1024" },
      { evicted_keys: "2" },
    );

    expect(status.ok).toBe(false);
    expect(status.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("noeviction"),
      expect.stringContaining("appendonly"),
      expect.stringContaining("appendfsync"),
      expect.stringContaining("evicted"),
    ]));
  });

  it("marks queue Redis above 85 percent memory as critical", () => {
    const status = evaluateRedisRuntime(
      "queue",
      {
        maxmemory: "100",
        "maxmemory-policy": "noeviction",
        appendonly: "yes",
        appendfsync: "everysec",
      },
      { used_memory: "86" },
      { evicted_keys: "0" },
    );

    expect(status.ok).toBe(false);
    expect(status.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("85%"),
    ]));
  });
});
