/**
 * Unlimited provisional live progress — Redis only.
 *
 * Never writes step_daily_totals, never marks days verified, never settles prizes.
 * Key: ul:prov:{challengeId}:{userId}:{challengeDayKey}
 */

import { getRedisLive, ensureRedisLiveConnected } from "./redis.js";
import { logger } from "./logger.js";
import {
  isProvisionalLiveSource,
  normalizeSource,
} from "./stepSources.js";

const TTL_SECONDS = 60 * 60 * 48; // 48h — covers timezone edge + late day

export type UnlimitedProvisionalLiveState = {
  provisionalSteps: number;
  source: "android_step_counter" | "ios_pedometer";
  sessionId: string;
  sequence: number;
  measuredAtUtc: string;
  updatedAtUtc: string;
  verificationStatus: "verification_delayed" | "syncing";
};

function key(challengeId: string, userId: string, challengeDayKey: string): string {
  return `ul:prov:${challengeId}:${userId}:${challengeDayKey}`;
}

export async function getUnlimitedProvisionalLive(
  challengeId: string,
  userId: string,
  challengeDayKey: string,
): Promise<UnlimitedProvisionalLiveState | null> {
  try {
    await ensureRedisLiveConnected();
    const redis = getRedisLive();
    const raw = await redis.hgetall(key(challengeId, userId, challengeDayKey));
    if (!raw || !raw.provisionalSteps) return null;
    const steps = Math.max(0, Math.floor(Number(raw.provisionalSteps) || 0));
    const source = normalizeSource(raw.source);
    if (!isProvisionalLiveSource(source)) return null;
    return {
      provisionalSteps: steps,
      source: source as "android_step_counter" | "ios_pedometer",
      sessionId: raw.sessionId || "",
      sequence: Math.max(0, Math.floor(Number(raw.sequence) || 0)),
      measuredAtUtc: raw.measuredAtUtc || raw.updatedAtUtc || new Date().toISOString(),
      updatedAtUtc: raw.updatedAtUtc || new Date().toISOString(),
      verificationStatus:
        raw.verificationStatus === "syncing" ? "syncing" : "verification_delayed",
    };
  } catch (err) {
    logger.warn({ err, challengeId, userId }, "[UnlimitedProvisional] get failed");
    return null;
  }
}

export type ApplyUnlimitedProvisionalResult =
  | {
      accepted: true;
      state: UnlimitedProvisionalLiveState;
      unchanged: boolean;
    }
  | {
      accepted: false;
      reason:
        | "invalid_source"
        | "stale_sequence"
        | "stale_steps"
        | "session_conflict"
        | "redis_error";
      state: UnlimitedProvisionalLiveState | null;
    };

/**
 * Atomic-ish monotonic update: higher same-session sequence + steps wins.
 * Different session with higher steps may replace if previous session is stale
 * (one-active-session policy: new session must not be lower than accepted steps).
 */
export async function applyUnlimitedProvisionalLive(params: {
  challengeId: string;
  userId: string;
  challengeDayKey: string;
  provisionalCumulativeSteps: number;
  source: string;
  measuredAtUtc: string;
  sessionId: string;
  sequence: number;
}): Promise<ApplyUnlimitedProvisionalResult> {
  const source = normalizeSource(params.source);
  if (!isProvisionalLiveSource(source)) {
    return { accepted: false, reason: "invalid_source", state: null };
  }

  const nextSteps = Math.max(0, Math.floor(params.provisionalCumulativeSteps));
  const nextSeq = Math.max(0, Math.floor(params.sequence));
  const sessionId = String(params.sessionId || "").trim();
  if (!sessionId) {
    return { accepted: false, reason: "invalid_source", state: null };
  }

  const existing = await getUnlimitedProvisionalLive(
    params.challengeId,
    params.userId,
    params.challengeDayKey,
  );

  if (existing) {
    if (existing.sessionId === sessionId) {
      if (nextSeq < existing.sequence) {
        return { accepted: false, reason: "stale_sequence", state: existing };
      }
      if (nextSeq === existing.sequence && nextSteps <= existing.provisionalSteps) {
        return { accepted: true, unchanged: true, state: existing };
      }
      if (nextSteps < existing.provisionalSteps) {
        return { accepted: false, reason: "stale_steps", state: existing };
      }
    } else {
      // New session: preserve higher accepted same-day progress; only accept if >= existing.
      if (nextSteps < existing.provisionalSteps) {
        return { accepted: false, reason: "session_conflict", state: existing };
      }
    }
  }

  const nowIso = new Date().toISOString();
  const state: UnlimitedProvisionalLiveState = {
    provisionalSteps: nextSteps,
    source: source as "android_step_counter" | "ios_pedometer",
    sessionId,
    sequence: nextSeq,
    measuredAtUtc: params.measuredAtUtc || nowIso,
    updatedAtUtc: nowIso,
    verificationStatus: "verification_delayed",
  };

  try {
    await ensureRedisLiveConnected();
    const redis = getRedisLive();
    const k = key(params.challengeId, params.userId, params.challengeDayKey);
    await redis.hset(k, {
      provisionalSteps: String(state.provisionalSteps),
      source: state.source,
      sessionId: state.sessionId,
      sequence: String(state.sequence),
      measuredAtUtc: state.measuredAtUtc,
      updatedAtUtc: state.updatedAtUtc,
      verificationStatus: state.verificationStatus,
    });
    await redis.expire(k, TTL_SECONDS);
    return { accepted: true, unchanged: false, state };
  } catch (err) {
    logger.warn({ err, challengeId: params.challengeId }, "[UnlimitedProvisional] apply failed");
    return { accepted: false, reason: "redis_error", state: existing };
  }
}

/** Batch-load provisional steps for many users on one challenge day map. */
export async function loadUnlimitedProvisionalMap(
  challengeId: string,
  entries: Array<{ userId: string; challengeDayKey: string }>,
): Promise<Map<string, UnlimitedProvisionalLiveState>> {
  const out = new Map<string, UnlimitedProvisionalLiveState>();
  await Promise.all(
    entries.map(async (e) => {
      const s = await getUnlimitedProvisionalLive(
        challengeId,
        e.userId,
        e.challengeDayKey,
      );
      if (s) out.set(`${e.userId}|${e.challengeDayKey}`, s);
    }),
  );
  return out;
}

export function displayedFromLanes(
  verified: number,
  provisional: number | null | undefined,
): number {
  const v = Math.max(0, Math.floor(verified));
  const p =
    provisional == null ? 0 : Math.max(0, Math.floor(provisional));
  return Math.max(v, p);
}

export function progressSourceFromLanes(
  verified: number,
  provisional: number | null | undefined,
): "verified" | "provisional" | "mixed" | "unavailable" {
  const v = Math.max(0, Math.floor(verified));
  const p =
    provisional == null ? 0 : Math.max(0, Math.floor(provisional));
  if (v <= 0 && p <= 0) return "unavailable";
  if (p > v) return v > 0 ? "mixed" : "provisional";
  if (v > 0) return "verified";
  return "unavailable";
}
