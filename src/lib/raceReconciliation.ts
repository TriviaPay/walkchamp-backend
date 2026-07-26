/**
 * Race step reconciliation policy (§13, §14).
 *
 * Pure, DB-free, and deterministic so it can be unit-tested in isolation and re-run idempotently
 * (same input ⇒ same output). It reconciles a participant's PROVISIONAL live steps against their
 * VERIFIED health steps into an authoritative reconciled total plus a status + reason codes.
 *
 * It never blindly applies min(live, verified) or max(live, verified): both source values are
 * preserved and carried through, and the choice is bounded by configurable tolerances and the
 * approved anti-cheat policy. Anti-cheat thresholds live in config and are never exposed to clients.
 *
 * This module intentionally does NOT emit the terminal "finalized" status — that transition is the
 * settlement layer's responsibility (it stamps "finalized" once it consumes the reconciled total),
 * keeping "reconciliation computed" distinct from "result settled".
 */

export type ReconciliationStatus =
  | "pending"
  | "matched"
  | "within_tolerance"
  | "verification_delayed"
  | "review_required"
  | "finalized";

export interface ReconciliationTolerances {
  /** Absolute step delta treated as noise (default 100). */
  absoluteToleranceSteps: number;
  /** Fractional divergence treated as within tolerance (e.g. 0.03 = 3%). */
  percentTolerance: number;
  /** Divergence above this fraction always routes to manual review (e.g. 0.15 = 15%). */
  reviewThresholdPercent: number;
  /** Grace window (ms) after race end during which missing verification is "pending", not delayed. */
  verificationWindowMs: number;
}

export interface RaceReconciliationInput {
  /** Provisional live cumulative steps (race_participants.currentSteps). */
  liveSteps: number;
  /** Verified health cumulative steps, or null when verification has not been ingested yet. */
  verifiedSteps: number | null;
  /** Authoritative race end time (ms). */
  raceEndedAtMs: number;
  /** Current server time (ms). */
  nowMs: number;
  tolerances: ReconciliationTolerances;
}

export interface RaceReconciliationResult {
  liveSteps: number;
  verifiedSteps: number | null;
  /** Authoritative reconciled total selected by the policy. */
  reconciledSteps: number;
  /** verified - live (signed); null when no verification is available. */
  difference: number | null;
  /** |difference| / max(live, 1); null when no verification is available. */
  differencePercent: number | null;
  status: ReconciliationStatus;
  reasonCodes: string[];
  reconciledAtUtc: string;
}

/**
 * Reconcile one participant. Pure over its inputs (except the caller-supplied `nowMs`, which is an
 * input, not a wall-clock read), so re-running on unchanged data yields an identical result.
 */
export function reconcileParticipant(input: RaceReconciliationInput): RaceReconciliationResult {
  const { liveSteps, verifiedSteps, raceEndedAtMs, nowMs, tolerances } = input;
  const reconciledAtUtc = new Date(nowMs).toISOString();
  const base = { liveSteps, verifiedSteps, reconciledAtUtc };

  // ── No verification available yet ──────────────────────────────────────────
  if (verifiedSteps === null) {
    const withinWindow = nowMs - raceEndedAtMs <= tolerances.verificationWindowMs;
    if (withinWindow) {
      // Still inside the grace window — do not finalize; keep live provisional as the working total.
      return {
        ...base,
        reconciledSteps: liveSteps,
        difference: null,
        differencePercent: null,
        status: "pending",
        reasonCodes: ["awaiting_verification"],
      };
    }
    // Verification never arrived within the window. Settle on live truth. NEVER a disqualification.
    return {
      ...base,
      reconciledSteps: liveSteps,
      difference: null,
      differencePercent: null,
      status: "verification_delayed",
      reasonCodes: ["verification_window_elapsed", "fallback_to_live"],
    };
  }

  const difference = verifiedSteps - liveSteps;
  const differencePercent = Math.abs(difference) / Math.max(liveSteps, 1);

  // ── Exact match ─────────────────────────────────────────────────────────────
  if (difference === 0) {
    return {
      ...base,
      reconciledSteps: liveSteps,
      difference,
      differencePercent,
      status: "matched",
      reasonCodes: ["exact_match"],
    };
  }

  // ── Within tolerance band ────────────────────────────────────────────────────
  const withinAbsolute = Math.abs(difference) <= tolerances.absoluteToleranceSteps;
  const withinPercent = differencePercent <= tolerances.percentTolerance;
  if (withinAbsolute || withinPercent) {
    // Bounded, near-equal values: take the more conservative (lower) of the two. This is NOT a
    // blind min — it only applies once divergence is already known to be inside the tolerance band.
    return {
      ...base,
      reconciledSteps: Math.min(liveSteps, verifiedSteps),
      difference,
      differencePercent,
      status: "within_tolerance",
      reasonCodes: ["within_tolerance", difference > 0 ? "verified_higher" : "verified_lower"],
    };
  }

  // ── Divergence beyond tolerance ───────────────────────────────────────────────
  if (difference > 0) {
    // Verified exceeds live beyond tolerance — the classic "app killed, health backfilled" case.
    // Never silently trust a large upward verified jump before payout; route to review and keep the
    // conservative live total as the reconciled value until a human (or approved rule) resolves it.
    return {
      ...base,
      reconciledSteps: liveSteps,
      difference,
      differencePercent,
      status: "review_required",
      reasonCodes: ["verified_exceeds_live_beyond_tolerance", "possible_backfill"],
    };
  }

  // Verified is materially LOWER than live — live may have over-counted vs verified device truth.
  // Correct down to verified, but always require review before it touches prizes. A large downward
  // divergence additionally flags for explicit manual attention.
  const large = differencePercent > tolerances.reviewThresholdPercent;
  return {
    ...base,
    reconciledSteps: verifiedSteps,
    difference,
    differencePercent,
    status: "review_required",
    reasonCodes: large
      ? ["live_exceeds_verified", "large_divergence", "manual_review"]
      : ["live_exceeds_verified", "auto_correct_to_verified"],
  };
}

/**
 * Whether a reconciliation status is safe for settlement to CONSUME as the authoritative total.
 * "review_required" and "pending" are NOT finalizable — settlement falls back to live steps and
 * flags the participant for audit rather than paying out on an unresolved divergence.
 */
export function isFinalizable(status: ReconciliationStatus): boolean {
  return status === "matched" || status === "within_tolerance" || status === "verification_delayed";
}

export interface FinalizationDecision {
  /** true → settlement should defer (verification expected but not yet available within the window). */
  defer: boolean;
  /** true → stamp reconciliation_status = "finalized" and use reconciledSteps as authoritative. */
  finalize: boolean;
  /** The reconciliation status to persist (before the finalize stamp). */
  status: ReconciliationStatus;
  reconciledSteps: number;
  reasonCodes: string[];
}

/**
 * Map a reconciliation result to a finalization decision (§13/§15). A caller-supplied
 * `sessionConflict` forces review (never auto-finalize a multi-device conflict).
 */
export function finalizationDecision(
  result: RaceReconciliationResult,
  opts: { sessionConflict?: boolean } = {},
): FinalizationDecision {
  if (opts.sessionConflict) {
    return {
      defer: false,
      finalize: false,
      status: "review_required",
      reconciledSteps: result.reconciledSteps,
      reasonCodes: [...new Set([...result.reasonCodes, "session_conflict"])],
    };
  }
  if (result.status === "pending") {
    return { defer: true, finalize: false, status: "pending", reconciledSteps: result.reconciledSteps, reasonCodes: result.reasonCodes };
  }
  const finalize = isFinalizable(result.status);
  return { defer: false, finalize, status: result.status, reconciledSteps: result.reconciledSteps, reasonCodes: result.reasonCodes };
}
