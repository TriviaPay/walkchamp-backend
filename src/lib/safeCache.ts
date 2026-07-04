import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "./config.js";
import { getRedisCache } from "./redis.js";
import { logger } from "./logger.js";

type CachePolicy = {
  namespace: string;
  baseTtlMs: number;
  staleTtlMs: number;
  jitterRatio?: number;
  negativeTtlMs?: number;
  lockTtlMs?: number;
  maxWaiters?: number;
  maxWaitMs?: number;
};

type CacheEnvelope<T> = {
  value: T | null;
  negative: boolean;
  expiresAt: number;
  staleUntil: number;
};

const inflight = new Map<string, { promise: Promise<unknown>; waiters: number }>();

function normalizePart(value: string | number | boolean | null | undefined): string {
  return encodeURIComponent(String(value ?? "null").trim().toLowerCase());
}

export function buildCacheKey(policy: Pick<CachePolicy, "namespace">, parts: Record<string, string | number | boolean | null | undefined>): string {
  const normalized = Object.entries(parts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${normalizePart(key)}=${normalizePart(value)}`)
    .join("&");
  return `cache:${policy.namespace}:${normalized}`;
}

function jitteredTtl(baseTtlMs: number, jitterRatio = 0.1): number {
  const bounded = Math.max(0, Math.min(jitterRatio, 0.5));
  const spread = baseTtlMs * bounded;
  return Math.max(1, Math.round(baseTtlMs - spread + Math.random() * spread * 2));
}

async function readEnvelope<T>(key: string): Promise<CacheEnvelope<T> | null> {
  const redis = getRedisCache();
  const raw = await redis.get(key);
  if (!raw) return null;
  return JSON.parse(raw) as CacheEnvelope<T>;
}

async function writeEnvelope<T>(key: string, envelope: CacheEnvelope<T>, ttlMs: number): Promise<void> {
  await getRedisCache().set(key, JSON.stringify(envelope), "PX", ttlMs);
}

async function tryAcquireLock(lockKey: string, owner: string, ttlMs: number): Promise<boolean> {
  const result = await getRedisCache().set(lockKey, owner, "PX", ttlMs, "NX");
  return result === "OK";
}

async function releaseLock(lockKey: string, owner: string): Promise<void> {
  const redis = getRedisCache();
  const current = await redis.get(lockKey);
  if (current === owner) {
    await redis.del(lockKey);
  }
}

export async function getOrCompute<T>(
  policy: CachePolicy,
  keyParts: Record<string, string | number | boolean | null | undefined>,
  compute: () => Promise<T | null>,
): Promise<T | null> {
  if (!config.features.cacheGetOrComputeEnabled) {
    return compute();
  }

  const key = buildCacheKey(policy, keyParts);
  const now = Date.now();

  try {
    const cached = await readEnvelope<T>(key);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const lockKey = `${key}:lock`;
    const owner = randomUUID();
    const maxWaiters = policy.maxWaiters ?? 50;
    const maxWaitMs = policy.maxWaitMs ?? 250;
    const existing = inflight.get(key);
    if (existing) {
      if (existing.waiters >= maxWaiters) {
        if (cached && cached.staleUntil > now) return cached.value;
        return compute();
      }
      existing.waiters += 1;
      try {
        return await existing.promise as T | null;
      } finally {
        existing.waiters -= 1;
      }
    }

    const promise = (async () => {
      const acquired = await tryAcquireLock(lockKey, owner, policy.lockTtlMs ?? 2_000);
      if (!acquired) {
        if (cached && cached.staleUntil > now) return cached.value;
        await delay(maxWaitMs);
        const afterWait = await readEnvelope<T>(key);
        if (afterWait && afterWait.staleUntil > Date.now()) return afterWait.value;
      }

      try {
        const value = await compute();
        const isNegative = value === null;
        const ttlMs = isNegative
          ? policy.negativeTtlMs ?? Math.min(policy.baseTtlMs, 30_000)
          : jitteredTtl(policy.baseTtlMs, policy.jitterRatio);
        const envelope: CacheEnvelope<T> = {
          value,
          negative: isNegative,
          expiresAt: Date.now() + ttlMs,
          staleUntil: Date.now() + ttlMs + policy.staleTtlMs,
        };
        await writeEnvelope(key, envelope, ttlMs + policy.staleTtlMs);
        return value;
      } finally {
        await releaseLock(lockKey, owner).catch(() => {});
      }
    })();

    inflight.set(key, { promise, waiters: 0 });
    try {
      return await promise;
    } finally {
      inflight.delete(key);
    }
  } catch (err) {
    logger.warn({ err, namespace: policy.namespace }, "[SafeCache] bypassing cache after failure");
    return compute();
  }
}
