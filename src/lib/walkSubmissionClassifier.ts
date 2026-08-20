import { config } from "./config.js";
import { getRedisWalkControl, isWalkCanaryUser, type WalkIngestMode } from "./walkRedisIngest.js";

export type WalkClassificationInput = {
  userId: string;
  accountStatus: string | null | undefined;
  verifiedSource: boolean;
  hasAbsoluteTotal: boolean;
  deviceId: string | null;
  localDateValid: boolean;
  timezoneValid: boolean;
  hasActiveUnlimitedDay: boolean;
};

export type WalkSubmissionClassification = {
  path: "postgres" | "redis_shadow" | "redis" | "retry";
  reason: string;
  epoch?: number;
  mode?: WalkIngestMode;
};

export async function classifyWalkSubmission(input: WalkClassificationInput): Promise<WalkSubmissionClassification> {
  if (!input.verifiedSource) return { path: "postgres", reason: "unverified_source" };
  if (!input.hasAbsoluteTotal) return { path: "postgres", reason: "delta_submission" };
  if (!input.deviceId || !/^[A-Za-z0-9._-]{1,128}$/.test(input.deviceId)) {
    return { path: "postgres", reason: "missing_or_invalid_device_id" };
  }
  if (!input.localDateValid || !input.timezoneValid) return { path: "postgres", reason: "invalid_context" };
  if (input.accountStatus !== "active") return { path: "postgres", reason: "account_not_active" };
  if (input.hasActiveUnlimitedDay) return { path: "postgres", reason: "active_unlimited_contract" };
  if (!config.features.redisWalkShadowWrite) return { path: "postgres", reason: "shadow_disabled" };
  const control = await getRedisWalkControl();
  if (!control) return config.features.redisWalkServe
    ? { path: "retry", reason: "control_unavailable" }
    : { path: "postgres", reason: "control_unavailable" };
  if (control.mode === "rehydrating") return { path: "retry", reason: "authority_rehydrating", ...control };
  if (control.mode === "redis_shadow") return { path: "redis_shadow", reason: "shadow", ...control };
  if (control.mode === "redis" && config.features.redisWalkServe && isWalkCanaryUser(input.userId)) {
    return { path: "redis", reason: "eligible_canary", ...control };
  }
  return { path: "postgres", reason: `control_${control.mode}` };
}
