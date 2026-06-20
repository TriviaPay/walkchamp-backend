import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "../middleware/requireAuth";
import { getRedis } from "./redis";

type FailureMode = "open" | "closed";

type RateLimitOptions = {
  bucket: string;
  windowMs: number;
  max: number;
  failureMode: FailureMode;
  message: string;
  code: string;
  key(req: Request): string;
};

type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
};

function requestIdOf(req: Request): string | null {
  return (req as Request & { id?: string }).id ?? null;
}

async function incrementBucket(
  redisKey: string,
  windowMs: number,
  max: number,
): Promise<RateLimitResult> {
  const redis = getRedis();
  const count = await redis.incr(redisKey);

  let ttlMs = await redis.pttl(redisKey);
  if (count === 1 || ttlMs < 0) {
    await redis.pexpire(redisKey, windowMs);
    ttlMs = windowMs;
  }

  return {
    allowed: count <= max,
    retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
    remaining: Math.max(0, max - count),
  };
}

export async function enforceRedisRateLimit(
  options: Omit<RateLimitOptions, "message" | "code">,
  req: Request,
): Promise<RateLimitResult> {
  const key = options.key(req);
  const redisKey = `rate-limit:${options.bucket}:${key}`;
  return incrementBucket(redisKey, options.windowMs, options.max);
}

export function createRedisRateLimit(options: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await enforceRedisRateLimit(options, req);
      res.setHeader("X-RateLimit-Remaining", String(result.remaining));
      res.setHeader("Retry-After", String(result.retryAfterSeconds));

      if (!result.allowed) {
        return res.status(429).json({
          error: options.message,
          code: options.code,
          requestId: requestIdOf(req),
        });
      }

      return next();
    } catch (err) {
      req.log.error({ err, bucket: options.bucket }, "Redis rate limiter failed");

      if (options.failureMode === "closed") {
        return res.status(503).json({
          error: "Rate limiting is temporarily unavailable.",
          code: "RATE_LIMIT_BACKEND_UNAVAILABLE",
          requestId: requestIdOf(req),
        });
      }

      return next();
    }
  };
}

export function rateLimitByIp(req: Request): string {
  return req.ip || "unknown";
}

export function rateLimitByActorOrIp(req: Request): string {
  const actorId = (req as AuthenticatedRequest).descopeUserId;
  if (actorId) return `user:${actorId}`;
  return `ip:${rateLimitByIp(req)}`;
}
