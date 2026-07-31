import { config } from "./config.js";

/**
 * Pure, integer-cent money math for the Unlimited Challenge. No floating point.
 *
 * - Total charge = entry fee + fixed $0.50 platform fee. The platform fee never enters the pool.
 * - Prize pool = sum of paid participants' entry-fee contributions (computed elsewhere as rows are
 *   added; this module only does the split).
 * - Equal split: every qualified finisher gets an equal share; leftover cents from integer division
 *   are distributed deterministically (winners sorted by a stable id; the first `remainder` get +1¢).
 */

export const UNLIMITED_PLATFORM_FEE_CENTS = 50;

/** Total the participant is charged: entry contribution + fixed platform fee. */
export function computeTotalChargeCents(entryFeeCents: number): number {
  return entryFeeCents + UNLIMITED_PLATFORM_FEE_CENTS;
}

export type EntryValidation = { ok: true } | { ok: false; error: string };

/** Validate an entry fee against the configured $10–$1000 bounds. */
export function validateEntryFeeCents(entryFeeCents: number): EntryValidation {
  const { minEntryFeeCents, maxEntryFeeCents } = config.unlimitedGoal;
  if (!Number.isInteger(entryFeeCents)) return { ok: false, error: "Entry fee must be a whole number of cents." };
  if (entryFeeCents < minEntryFeeCents) return { ok: false, error: `Entry fee must be at least $${minEntryFeeCents / 100}.` };
  if (entryFeeCents > maxEntryFeeCents) return { ok: false, error: `Entry fee must be at most $${maxEntryFeeCents / 100}.` };
  return { ok: true };
}

/** Validate a daily step goal against the configured production bounds plus explicit test options. */
export function validateDailyGoalSteps(dailyGoalSteps: number): EntryValidation {
  const { minDailyGoalSteps, maxDailyGoalSteps, testingDailyGoalSteps } = config.unlimitedGoal;
  if (!Number.isInteger(dailyGoalSteps)) return { ok: false, error: "Daily goal must be a whole number of steps." };
  if ((testingDailyGoalSteps as readonly number[]).includes(dailyGoalSteps)) return { ok: true };
  if (dailyGoalSteps < minDailyGoalSteps) return { ok: false, error: `Daily goal must be at least ${minDailyGoalSteps} steps.` };
  if (dailyGoalSteps > maxDailyGoalSteps) return { ok: false, error: `Daily goal must be at most ${maxDailyGoalSteps} steps.` };
  return { ok: true };
}

export function isAllowedDuration(durationDays: number): boolean {
  return (config.unlimitedGoal.allowedDurationDays as readonly number[]).includes(durationDays);
}

export interface EqualSplitAllocation {
  participantId: string;
  payoutCents: number;
}

/**
 * Split `prizePoolCents` equally among the given qualified finishers.
 *
 * base = floor(pool / N); remainder = pool % N. Winners are sorted by their stable participantId,
 * and the first `remainder` winners receive one extra cent — deterministic, fully allocates the pool
 * (sum of payouts === prizePoolCents), and independent of live ranking. Returns [] for 0 winners.
 */
export function computeEqualSplit(prizePoolCents: number, participantIds: string[]): EqualSplitAllocation[] {
  const n = participantIds.length;
  if (n === 0 || prizePoolCents <= 0) return [];
  const base = Math.floor(prizePoolCents / n);
  const remainder = prizePoolCents % n;
  const sorted = [...participantIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted.map((participantId, index) => ({
    participantId,
    payoutCents: base + (index < remainder ? 1 : 0),
  }));
}
