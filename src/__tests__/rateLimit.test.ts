import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const redisEval = vi.fn();

vi.mock("../lib/config", () => ({
  config: {
    features: {
      newRateLimiterEnabled: true,
    },
    rateLimit: {
      secret: "unit-test-rate-limit-secret",
    },
  },
}));

vi.mock("../lib/redis", () => ({
  getRedisCache: () => ({
    eval: redisEval,
  }),
}));

const { createRedisRateLimit, rateLimitByIp } = await import("../lib/rateLimit");

function mockReq(ip = "203.0.113.10"): Request {
  return {
    ip,
    headers: {
      authorization: "Bearer test-token",
      "x-walkchamp-device-id": "device-1",
    },
    log: {
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as Request;
}

function mockRes(): Response & { headers: Map<string, string>; statusSpy: ReturnType<typeof vi.fn>; jsonSpy: ReturnType<typeof vi.fn> } {
  const headers = new Map<string, string>();
  const jsonSpy = vi.fn();
  const statusSpy = vi.fn().mockReturnValue({ json: jsonSpy });
  return {
    headers,
    statusSpy,
    jsonSpy,
    setHeader: (key: string, value: string) => {
      headers.set(key.toLowerCase(), value);
      return undefined;
    },
    status: statusSpy,
  } as unknown as Response & { headers: Map<string, string>; statusSpy: ReturnType<typeof vi.fn>; jsonSpy: ReturnType<typeof vi.fn> };
}

describe("createRedisRateLimit", () => {
  beforeEach(() => {
    redisEval.mockReset();
  });

  it("sets modern and legacy rate-limit headers on Redis success", async () => {
    redisEval.mockResolvedValue([1, 0, 4]);
    const limiter = createRedisRateLimit({
      bucket: "unit",
      windowMs: 60_000,
      max: 5,
      failureMode: "closed",
      message: "limited",
      code: "LIMITED",
      key: rateLimitByIp,
      dimensions: ["ip"],
    });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await limiter(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.headers.get("ratelimit")).toBe('"unit";r=4;t=1');
    expect(res.headers.get("ratelimit-policy")).toBe('"unit";q=5;w=60');
    expect(res.headers.get("ratelimit-limit")).toBe("5");
    expect(res.headers.get("ratelimit-remaining")).toBe("4");
  });

  it("uses local emergency fallback when Redis fails on a closed limiter", async () => {
    redisEval.mockRejectedValue(new Error("redis down"));
    const limiter = createRedisRateLimit({
      bucket: "fallback",
      windowMs: 60_000,
      max: 1,
      failureMode: "closed",
      message: "limited",
      code: "LIMITED",
      key: rateLimitByIp,
      dimensions: ["ip"],
    });
    const next1 = vi.fn() as unknown as NextFunction;
    const next2 = vi.fn() as unknown as NextFunction;
    const req = mockReq("198.51.100.1");

    await limiter(req, mockRes(), next1);
    const res2 = mockRes();
    await limiter(req, res2, next2);

    expect(next1).toHaveBeenCalledOnce();
    expect(next2).not.toHaveBeenCalled();
    expect(res2.statusSpy).toHaveBeenCalledWith(429);
    expect(res2.jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      code: "LIMITED",
    }));
  });
});
