/**
 * Central step-source contract for the hybrid live + verified step architecture.
 *
 * The backend receives step totals and metadata from mobile clients — it never reads platform
 * health/sensor SDKs itself. This module is the single place that classifies where a step total
 * came from, so verified daily state, provisional live race progress, and verified race totals
 * are never treated as equivalent.
 *
 * Canonical sources:
 *   Verified daily          — "health_connect" (Android), "healthkit" (iOS)
 *   Provisional live race   — "android_step_counter" (Android TYPE_STEP_COUNTER), "ios_pedometer" (CMPedometer)
 *   Race verification       — "health_connect", "healthkit"
 *
 * Deprecated / ambiguous legacy names still present in the DB and in older clients are mapped to
 * a canonical value below rather than rejected, so existing clients keep functioning:
 *   ios_healthkit          -> healthkit
 *   android_health_connect -> health_connect
 *   android_counter        -> android_step_counter
 *   android_legacy_sensor  -> android_step_counter
 *   phone_sensor           -> android_step_counter   (provisional; NEVER verified)
 *   device_sensor          -> android_step_counter   (provisional; NEVER verified)
 *   sensor_estimate        -> android_step_counter   (provisional; NEVER verified)
 *
 * "simulation" is preserved verbatim (it drives the existing anti-cheat disqualification path)
 * and is never a verified source.
 */

export type VerifiedDailySource = "health_connect" | "healthkit";
export type ProvisionalLiveRaceSource = "android_step_counter" | "ios_pedometer";
export type RaceVerificationSource = "health_connect" | "healthkit";

export const VERIFIED_DAILY_SOURCES: readonly VerifiedDailySource[] = ["health_connect", "healthkit"];
export const PROVISIONAL_LIVE_SOURCES: readonly ProvisionalLiveRaceSource[] = [
  "android_step_counter",
  "ios_pedometer",
];
export const RACE_VERIFICATION_SOURCES: readonly RaceVerificationSource[] = ["health_connect", "healthkit"];

/** Backward-compatible mapping for legacy/ambiguous source names. */
const LEGACY_SOURCE_MAP: Record<string, string> = {
  ios_healthkit: "healthkit",
  android_health_connect: "health_connect",
  android_counter: "android_step_counter",
  android_legacy_sensor: "android_step_counter",
  phone_sensor: "android_step_counter",
  device_sensor: "android_step_counter",
  sensor_estimate: "android_step_counter",
};

/** Every value we recognise after normalization. */
const KNOWN_SOURCES = new Set<string>([
  "health_connect",
  "healthkit",
  "android_step_counter",
  "ios_pedometer",
  "simulation",
]);

/**
 * Map a raw client-supplied source to its canonical form. Returns null for empty input, and the
 * lower-cased raw value (unmapped) for unknown strings so callers can decide how strict to be.
 */
export function normalizeSource(raw?: string | null): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  return LEGACY_SOURCE_MAP[trimmed] ?? trimmed;
}

/** True only for sources that represent a verified health total (Health Connect / HealthKit). */
export function isVerifiedDailySource(source: string | null): boolean {
  const s = normalizeSource(source);
  return s === "health_connect" || s === "healthkit";
}

/** True for provisional live race sensors (Android step counter / iOS pedometer). */
export function isProvisionalLiveSource(source: string | null): boolean {
  const s = normalizeSource(source);
  return s === "android_step_counter" || s === "ios_pedometer";
}

/** True for sources permitted on a race-verification submission. */
export function isRaceVerificationSource(source: string | null): boolean {
  const s = normalizeSource(source);
  return s === "health_connect" || s === "healthkit";
}

/**
 * True for a source that is clearly not a real step source (fake/mock/random). These are safely
 * ignored on the daily endpoint rather than stored as verified state. "simulation" is excluded
 * here because it is a legitimate testing source handled by the race anti-cheat path.
 */
export function isRejectedDailySource(source: string | null): boolean {
  const s = normalizeSource(source);
  if (s === null) return false; // absent source is allowed (legacy clients)
  return !KNOWN_SOURCES.has(s);
}

/** Sources rejected specifically from canonical daily totals / leaderboards. */
export function isRejectedForDailyTotals(source: string | null): boolean {
  const s = normalizeSource(source);
  return isRejectedDailySource(s) || isProvisionalLiveSource(s) || s === "simulation";
}

/** Per-session daily classification driving step_sessions.is_verified_source. */
export function classifyDailySource(source: string | null): "verified" | "unverified" {
  return isVerifiedDailySource(source) ? "verified" : "unverified";
}

export type LiveStepSourceValue =
  | "healthkit"
  | "health_connect"
  | "android_step_counter"
  | "ios_pedometer"
  | "simulation"
  | "unknown";

/**
 * Map a raw client live source to the live_step_source enum. Absent ⇒ null; a present but
 * unrecognized value ⇒ "unknown" (so it can still be stored without violating the enum).
 */
export function toLiveStepSource(raw?: string | null): LiveStepSourceValue | null {
  const s = normalizeSource(raw);
  if (s === null) return null;
  if (
    s === "healthkit"
    || s === "health_connect"
    || s === "android_step_counter"
    || s === "ios_pedometer"
    || s === "simulation"
  ) {
    return s;
  }
  return "unknown";
}

/**
 * Roll a set of per-session daily classifications up to a day-level source_class:
 *   "verified"   — every contributing session was a verified health source
 *   "unverified" — every contributing session was provisional/unknown
 *   "mixed"      — a blend of both
 */
export function rollUpDailySourceClass(
  classes: ReadonlyArray<"verified" | "unverified">,
): "verified" | "mixed" | "unverified" {
  if (classes.length === 0) return "unverified";
  const hasVerified = classes.includes("verified");
  const hasUnverified = classes.includes("unverified");
  if (hasVerified && hasUnverified) return "mixed";
  return hasVerified ? "verified" : "unverified";
}
