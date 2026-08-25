import { createHash } from "node:crypto";
import { config } from "./config.js";

export const PROTECTED_ADJUDICATION = {
  PENDING: "pending_verification",
  RECONCILING: "reconciling",
  REVIEW: "review_required",
  FINALIZED: "finalized",
  VOIDED: "voided",
} as const;

export type ProtectedPolicySnapshot = {
  policyVersion: string;
  minimumDurationMinutes: number;
  closeResultAbsoluteSteps: number;
  closeResultPercent: number;
  reconciliationAbsoluteSteps: number;
  reconciliationPercent: number;
  verificationGraceMs: number;
  reviewWindowMs: number;
  maxContinuousOfflineMs: number;
  maxOfflineRaceFraction: number;
  finalEvidenceUploadGraceMs: number;
  heartbeatIntervalMs: number;
};

export function currentProtectedPolicySnapshot(): ProtectedPolicySnapshot {
  const p = config.protectedRace;
  return {
    policyVersion: p.policyVersion,
    minimumDurationMinutes: p.minimumDurationMinutes,
    closeResultAbsoluteSteps: p.closeResultAbsoluteSteps,
    closeResultPercent: p.closeResultPercent,
    reconciliationAbsoluteSteps: p.reconciliationAbsoluteSteps,
    reconciliationPercent: p.reconciliationPercent,
    verificationGraceMs: p.verificationGraceMs,
    reviewWindowMs: p.reviewWindowMs,
    maxContinuousOfflineMs: p.maxContinuousOfflineMs,
    maxOfflineRaceFraction: p.maxOfflineRaceFraction,
    finalEvidenceUploadGraceMs: p.finalEvidenceUploadGraceMs,
    heartbeatIntervalMs: p.heartbeatIntervalMs,
  };
}

export function isProtectedPrizeCandidate(input: {
  entryAmountCents?: number | null;
  entryType?: string | null;
  type?: string | null;
}): boolean {
  return (input.entryAmountCents ?? 0) > 0
    || input.entryType === "coins_battle"
    || input.type === "sponsored";
}

export function validateProtectedDuration(durationMinutes: number): { ok: true } | { ok: false; code: string; minimumMinutes: number } {
  const minimumMinutes = config.protectedRace.minimumDurationMinutes;
  return Number.isInteger(durationMinutes) && durationMinutes >= minimumMinutes
    ? { ok: true }
    : { ok: false, code: "PROTECTED_RACE_DURATION_TOO_SHORT", minimumMinutes };
}

export function reconciliationThreshold(qualifyingSteps: number, policy: ProtectedPolicySnapshot): number {
  return Math.max(
    policy.reconciliationAbsoluteSteps,
    Math.ceil(Math.max(0, qualifyingSteps) * policy.reconciliationPercent),
  );
}

export function classifyReconciliation(
  provisionalSteps: number,
  qualifyingSteps: number,
  policy: ProtectedPolicySnapshot,
): "CLEAR" | "RECONCILIATION_REVIEW" {
  return Math.abs(provisionalSteps - qualifyingSteps) > reconciliationThreshold(qualifyingSteps, policy)
    ? "RECONCILIATION_REVIEW"
    : "CLEAR";
}

export function classifyOffline(input: {
  maxContinuousOfflineMs: number;
  cumulativeOfflineMs: number;
  raceDurationMs: number;
  policy: ProtectedPolicySnapshot;
}): "CLEAR" | "OFFLINE_REVIEW" {
  const cumulativeLimit = input.raceDurationMs * input.policy.maxOfflineRaceFraction;
  return input.maxContinuousOfflineMs > input.policy.maxContinuousOfflineMs
    || input.cumulativeOfflineMs > cumulativeLimit
    ? "OFFLINE_REVIEW"
    : "CLEAR";
}

export function classifyContinuity(input: {
  bindingChanged: boolean;
  sourceChanged: boolean;
  permissionStatus: string | null | undefined;
}): { continuityStatus: "HEALTHY" | "USER_CONTINUITY_BREACH"; reviewReasons: string[] } {
  const permissionRevoked = input.permissionStatus === "revoked" || input.permissionStatus === "denied";
  return {
    continuityStatus: input.bindingChanged || permissionRevoked ? "USER_CONTINUITY_BREACH" : "HEALTHY",
    reviewReasons: [
      ...(input.bindingChanged || permissionRevoked ? ["CONTINUITY_REVIEW"] : []),
      ...(input.sourceChanged ? ["SOURCE_REVIEW"] : []),
    ],
  };
}

export function closeResultThreshold(lowerQualifyingSteps: number, policy: ProtectedPolicySnapshot): number {
  return Math.max(
    policy.closeResultAbsoluteSteps,
    Math.ceil(Math.max(0, lowerQualifyingSteps) * policy.closeResultPercent),
  );
}

/**
 * Assign deterministic close-result group ids. Adjacent prize-relevant positions inside the close
 * threshold are one transitive tie group. Callers preserve the real step totals in evidence; the
 * group id only controls payout grouping.
 */
export function closeResultGroups(
  standings: Array<{ userId: string; qualifyingSteps: number }>,
  paidPositionCount: number,
  policy: ProtectedPolicySnapshot,
): Map<string, string> {
  const sorted = [...standings].sort((a, b) => b.qualifyingSteps - a.qualifyingSteps || a.userId.localeCompare(b.userId));
  const groups = new Map<string, string>();
  let group = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0) group += 1;
    else {
      const upper = sorted[i - 1];
      const lower = sorted[i];
      const boundaryIsPrizeRelevant = i <= paidPositionCount;
      const close = upper.qualifyingSteps - lower.qualifyingSteps
        <= closeResultThreshold(lower.qualifyingSteps, policy);
      if (!boundaryIsPrizeRelevant || !close) group += 1;
    }
    groups.set(sorted[i].userId, `close-${group}`);
  }
  return groups;
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`).join(",")}}`;
  }
  throw new Error("Unsupported canonical payload value");
}

export function canonicalPayloadHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalValue(payload), "utf8").digest("base64url");
}

export function protectedPolicyFromStored(raw: unknown): ProtectedPolicySnapshot {
  const current = currentProtectedPolicySnapshot();
  if (!raw || typeof raw !== "object") return current;
  const value = raw as Partial<ProtectedPolicySnapshot>;
  const numeric = <K extends keyof ProtectedPolicySnapshot>(key: K): ProtectedPolicySnapshot[K] => {
    const candidate = value[key];
    return (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
      ? candidate
      : current[key]) as ProtectedPolicySnapshot[K];
  };
  return {
    policyVersion: typeof value.policyVersion === "string" && value.policyVersion ? value.policyVersion : current.policyVersion,
    minimumDurationMinutes: numeric("minimumDurationMinutes"),
    closeResultAbsoluteSteps: numeric("closeResultAbsoluteSteps"),
    closeResultPercent: numeric("closeResultPercent"),
    reconciliationAbsoluteSteps: numeric("reconciliationAbsoluteSteps"),
    reconciliationPercent: numeric("reconciliationPercent"),
    verificationGraceMs: numeric("verificationGraceMs"),
    reviewWindowMs: numeric("reviewWindowMs"),
    maxContinuousOfflineMs: numeric("maxContinuousOfflineMs"),
    maxOfflineRaceFraction: numeric("maxOfflineRaceFraction"),
    finalEvidenceUploadGraceMs: numeric("finalEvidenceUploadGraceMs"),
    heartbeatIntervalMs: numeric("heartbeatIntervalMs"),
  };
}
