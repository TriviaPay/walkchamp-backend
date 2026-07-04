import type { NextFunction, Request, Response } from "express";
import { createHmac } from "node:crypto";
import type { AuthenticatedRequest } from "../middleware/requireAuth.js";
import { config } from "./config.js";
import { ensureRedisCacheConnected, getRedisCache } from "./redis.js";

type FailureMode = "open" | "closed";
type RateLimitDimension = "key" | "ip" | "actor" | "token" | "device" | "target";
type RateLimitEnforcement = "enforce" | "monitor";

type RateLimitOptions = {
  bucket: string;
  windowMs: number;
  max: number;
  failureMode: FailureMode;
  enforcement?: RateLimitEnforcement;
  message: string;
  code: string;
  key(req: Request): string;
  dimensions?: RateLimitDimension[];
  target?: (req: Request) => string | null;
};

type RateLimitResult = {
  allowed: boolean;
  dimension: string;
  retryAfterSeconds: number;
  remaining: number;
};

type LocalBucket = {
  tat: number;
  expiresAt: number;
};

const GCRA_SCRIPT = `
local tat = tonumber(redis.call("GET", KEYS[1]) or "0")
local now = tonumber(ARGV[1])
local emission = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local limit = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local allowed_at = tat - burst + emission
if now < allowed_at then
  return {0, allowed_at - now, 0}
end

local new_tat = math.max(tat, now) + emission
redis.call("SET", KEYS[1], new_tat, "PX", ttl)

local remaining = math.floor((burst - (new_tat - now)) / emission)
if remaining < 0 then remaining = 0 end
if remaining > limit then remaining = limit end
return {1, 0, remaining}
`;

const localBuckets = new Map<string, LocalBucket>();

function requestIdOf(req: Request): string | null {
  return (req as Request & { id?: string }).id ?? null;
}

function sanitizeIdentifier(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) return null;
  return normalized.replace(/[^a-zA-Z0-9_.:@|-]/g, "_");
}

function hmacFingerprint(value: string): string {
  const secret = config.rateLimit.secret ?? "missing-rate-limit-secret";
  return createHmac("sha256", secret).update(value).digest("base64url").slice(0, 32);
}

function bearerTokenOf(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token ? token : null;
}

function deviceIdOf(req: Request): string | null {
  const raw = req.headers["x-walkchamp-device-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  return sanitizeIdentifier(value);
}

function targetOf(options: RateLimitOptions, req: Request): string | null {
  if (!options.target) return null;
  const value = options.target(req);
  return value ? sanitizeIdentifier(value) : null;
}

function dimensionKeys(options: RateLimitOptions, req: Request): Array<{ dimension: string; key: string }> {
  const dimensions = options.dimensions?.length ? options.dimensions : ["key"];
  const keys: Array<{ dimension: string; key: string }> = [];

  for (const dimension of dimensions) {
    if (dimension === "key") {
      keys.push({ dimension, key: sanitizeIdentifier(options.key(req)) ?? "unknown" });
    } else if (dimension === "ip") {
      keys.push({ dimension, key: sanitizeIdentifier(rateLimitByIp(req)) ?? "unknown" });
    } else if (dimension === "actor") {
      const actorId = (req as AuthenticatedRequest).descopeUserId;
      if (actorId) keys.push({ dimension, key: `user:${sanitizeIdentifier(actorId) ?? "unknown"}` });
    } else if (dimension === "token") {
      const token = bearerTokenOf(req);
      if (token) keys.push({ dimension, key: `token:${hmacFingerprint(token)}` });
    } else if (dimension === "device") {
      const deviceId = deviceIdOf(req);
      if (deviceId) keys.push({ dimension, key: `device:${hmacFingerprint(deviceId)}` });
    } else if (dimension === "target") {
      const target = targetOf(options, req);
      if (target) keys.push({ dimension, key: `target:${hmacFingerprint(target.toLowerCase())}` });
    }
  }

  if (keys.length === 0) {
    keys.push({ dimension: "key", key: sanitizeIdentifier(options.key(req)) ?? "unknown" });
  }

  return keys;
}

async function consumeRedisGcra(
  redisKey: string,
  windowMs: number,
  max: number,
): Promise<RateLimitResult> {
  await ensureRedisCacheConnected();
  const redis = getRedisCache();
  const nowMs = Date.now();
  const emissionMs = Math.max(1, Math.ceil(windowMs / max));
  const ttlMs = windowMs + emissionMs;
  const result = await redis.eval(
    GCRA_SCRIPT,
    1,
    redisKey,
    String(nowMs),
    String(emissionMs),
    String(windowMs),
    String(max),
    String(ttlMs),
  ) as [number, number, number];

  return {
    allowed: result[0] === 1,
    dimension: "redis",
    retryAfterSeconds: Math.max(1, Math.ceil((result[1] ?? 0) / 1000)),
    remaining: Math.max(0, result[2] ?? 0),
  };
}

function consumeLocalGcra(
  redisKey: string,
  windowMs: number,
  max: number,
): RateLimitResult {
  const nowMs = Date.now();
  const emissionMs = Math.max(1, Math.ceil(windowMs / max));
  const existing = localBuckets.get(redisKey);
  const bucket = existing && existing.expiresAt > nowMs
    ? existing
    : { tat: 0, expiresAt: nowMs + windowMs + emissionMs };

  const allowedAt = bucket.tat - windowMs + emissionMs;
  if (nowMs < allowedAt) {
    localBuckets.set(redisKey, bucket);
    return {
      allowed: false,
      dimension: "local",
      retryAfterSeconds: Math.max(1, Math.ceil((allowedAt - nowMs) / 1000)),
      remaining: 0,
    };
  }

  bucket.tat = Math.max(bucket.tat, nowMs) + emissionMs;
  bucket.expiresAt = nowMs + windowMs + emissionMs;
  localBuckets.set(redisKey, bucket);

  return {
    allowed: true,
    dimension: "local",
    retryAfterSeconds: 1,
    remaining: Math.max(0, Math.min(max, Math.floor((windowMs - (bucket.tat - nowMs)) / emissionMs))),
  };
}

function cleanupLocalBuckets(): void {
  const nowMs = Date.now();
  for (const [key, bucket] of localBuckets) {
    if (bucket.expiresAt <= nowMs) {
      localBuckets.delete(key);
    }
  }
}

setInterval(cleanupLocalBuckets, 10 * 60_000).unref?.();

export async function enforceRedisRateLimit(
  options: Omit<RateLimitOptions, "message" | "code">,
  req: Request,
): Promise<RateLimitResult> {
  const keys = dimensionKeys(options as RateLimitOptions, req);
  let tightest: RateLimitResult | null = null;

  for (const item of keys) {
    const redisKey = `rate-limit:${options.bucket}:${item.dimension}:${item.key}`;
    const result = config.features.newRateLimiterEnabled
      ? await consumeRedisGcra(redisKey, options.windowMs, options.max)
      : consumeLocalGcra(redisKey, options.windowMs, options.max);
    const withDimension = { ...result, dimension: item.dimension };

    if (!withDimension.allowed) return withDimension;
    if (!tightest || withDimension.remaining < tightest.remaining) {
      tightest = withDimension;
    }
  }

  return tightest ?? {
    allowed: true,
    dimension: "none",
    retryAfterSeconds: Math.max(1, Math.ceil(options.windowMs / 1000)),
    remaining: options.max,
  };
}

function setRateLimitHeaders(res: Response, options: RateLimitOptions, result: RateLimitResult): void {
  const resetSeconds = result.retryAfterSeconds;
  res.setHeader("Retry-After", String(resetSeconds));
  res.setHeader("RateLimit", `"${options.bucket}";r=${result.remaining};t=${resetSeconds}`);
  res.setHeader("RateLimit-Policy", `"${options.bucket}";q=${options.max};w=${Math.ceil(options.windowMs / 1000)}`);
  res.setHeader("RateLimit-Limit", String(options.max));
  res.setHeader("RateLimit-Remaining", String(result.remaining));
  res.setHeader("RateLimit-Reset", String(resetSeconds));
  res.setHeader("X-RateLimit-Remaining", String(result.remaining));
}

export function createRedisRateLimit(options: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await enforceRedisRateLimit(options, req);
      setRateLimitHeaders(res, options, result);

      if (!result.allowed) {
        req.log.warn({
          bucket: options.bucket,
          dimension: result.dimension,
          enforcement: options.enforcement ?? "enforce",
        }, "Rate limit exceeded");

        if (options.enforcement === "monitor") {
          return next();
        }

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
        const localResults = dimensionKeys(options, req)
          .map((item) => ({
            item,
            result: consumeLocalGcra(
              `local-rate-limit:${options.bucket}:${item.dimension}:${item.key}`,
              options.windowMs,
              options.max,
            ),
          }));
        const denied = localResults.find((entry) => !entry.result.allowed);
        const result = denied?.result ?? localResults
          .map((entry) => entry.result)
          .sort((a, b) => a.remaining - b.remaining)[0];

        if (result) {
          setRateLimitHeaders(res, options, result);
        }

        if (denied && options.enforcement !== "monitor") {
          return res.status(429).json({
            error: options.message,
            code: options.code,
            requestId: requestIdOf(req),
          });
        }

        return next();
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
