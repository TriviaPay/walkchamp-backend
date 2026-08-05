import { Router } from "express";
import { db } from "../../db/src/index.js";
import {
  raceRoomsTable,
  raceParticipantsTable,
  raceStepSyncLogsTable,
  verificationDecisionAuditTable,
  profilesTable,
  walletsTable,
  walletTransactionsTable,
  raceResultsTable,
  liveRaceCommentsTable,
  liveRaceReactionsTable,
  friendsTable,
  friendRequestsTable,
  userTitlesTable,
  achievementDefinitionsTable,
  roomInvitesTable,
  userPresenceTable,
  blockedUsersTable,
  scheduledRoomRegistrationsTable,
  coinBalancesTable,
  cashChallengeConsentsTable,
  raceTrackThemesTable,
  unlimitedChallengesTable,
  unlimitedChallengeParticipantsTable,
} from "../../db/src/schema/index.js";
import { eq, and, desc, asc, sql, ne, inArray, notInArray, or, lt } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import { z } from "zod";
import { generateInviteCode } from "../lib/inviteCodes.js";
import { triggerEvent } from "../lib/pusher.js";
import { logger } from "../lib/logger.js";
import { config } from "../lib/config.js";
import { setUserDefaultTrackTheme, validateThemeOwnership } from "./trackThemes.js";
import { grantCoinReward, getRaceWinRewardCode, grantVariableCoinReward } from "../lib/coinRewardService.js";
import { evaluateAndNotify } from "./achievementHooks.js";
import { requireAdminKey } from "../middleware/requireAdminKey.js";
import { recordCoinLedgerEntry } from "../lib/coinsService.js";
import {
  deriveOpenRoomStatus,
  type DbTx,
  isRaceParticipant,
  joinOrReviveParticipant,
  lockRaceRoom,
  lockScheduledRegistration,
  registerOrReviveScheduledRegistration,
} from "../lib/raceIntegrity.js";
import {
  buildLiveRaceProgressContext,
  formatProgressSyncResponse,
  getLiveRaceStandings,
  type LiveRaceProgressContext,
} from "../lib/raceLeaderboardService.js";
import {
  getRaceConfig,
  applyProgress,
  getStandingsWithNames,
  getParticipantCount,
  getParticipantRank,
  markFinishOfficial,
  isRaceHydrated,
  setRaceState,
  snapshotRace,
  getPendingFinishes,
  getParticipantsState,
  clearRaceLiveState,
  removeParticipantLiveState,
  tryAcquireBroadcastLease,
  LIVE_RACE_STATE,
} from "../lib/raceLiveState.js";
import { triggerLiveActivityUpdate } from "../lib/liveActivityUpdateService.js";
import { liveActivityTokensTable } from "../../db/src/schema/index.js";
import {
  buildCashChallengeQuote,
  buildRewardSplitCents as buildCashRewardSplitCents,
  calcEntryPoolCents,
  calcPerPlayerFees,
  cashChallengeUnsupportedForCurrencyBody,
  formatQuoteForApi,
  isAllowedEntryAmountCents,
  isCashChallengeUnsupportedForCountry,
  resolvePaymentProvider,
} from "../lib/cashChallengeFees.js";
import {
  creditCashChallengePrizes,
  debitCashChallengeEntry,
  hasCompletedEntryPayment,
} from "../lib/cashChallengePayments.js";
import { grantReferralBonusForCashChallenge } from "../lib/referralBonusService.js";
import {
  markRaceActive,
  activeRaceCount,
  listActiveRaces,
  reconcileActive,
  type ActiveRaceEntry,
} from "../lib/raceRegistry.js";
import { resolveLiveStateModeForNewRace, initializeRaceLiveState, ensureRaceHydrated, ensureParticipantHydrated } from "../lib/raceLiveHydration.js";
import { computeIsAdult } from "../lib/dateOfBirth.js";
import {
  createRefundBatchForRaceCancellation,
  createRefundForRaceLeave,
} from "../lib/refundService.js";
import { buildTrackThemeMedia, TRACK_THEME_CODES, type TrackThemeMedia } from "../lib/trackThemeMedia.js";
import { createPendingSponsoredGiftCardAwards } from "../lib/sponsoredGiftCards.js";
import {
  getSponsoredAwardedWinnerCount,
  getSponsoredPrizePoolCents,
  getSponsoredWinnerCount,
  SPONSORED_EVENT_PRIZE_PER_WINNER_CENTS,
  SPONSORED_EVENT_TARGET_STEPS,
} from "../lib/sponsoredEventRules.js";
import { getWinnerSlotCount, selectWinners, type Completer } from "../lib/raceSettlement.js";
import { toLiveStepSource } from "../lib/stepSources.js";
import { reconcileParticipant, finalizationDecision } from "../lib/raceReconciliation.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { sendNotification } from "./notifications.js";
import { computeCanStart, terminateWaitingRoom, enqueueWaitingRoomLifecycleJobs } from "../lib/waitingRoom.js";
import { getUnlimitedBlockingMembership } from "../lib/challengeMembership.js";

const router = Router();
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/**
 * Fixed-player classic races (free / coins / cash, challengeDurationDays = 0):
 * stay live for 24h from start unless enough winners finish earlier.
 * Not used for Unlimited, multi-day duration challenges, or sponsored (3h).
 */
const FIXED_RACE_MAX_DURATION_MS = MS_PER_DAY;

class PaidJoinRollback extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body: Record<string, string>,
  ) {
    super(String(body.error ?? "Paid join failed."));
  }
}

const REGULAR_RACE_REGISTRATION_EXISTS_CODE = "REGULAR_RACE_REGISTRATION_EXISTS";
const REGULAR_RACE_REGISTRATION_EXISTS_TITLE = "Already Registered";
const REGULAR_RACE_REGISTRATION_EXISTS_MESSAGE =
  "You are already registered for another race. Please withdraw from or complete your current race before registering for a new one.";
const FUTURE_ROOM_CREATION_EXISTS_CODE = "FUTURE_ROOM_CREATION_EXISTS";
const FUTURE_ROOM_CREATION_EXISTS_TITLE = "Cannot create room";
const FUTURE_ROOM_CREATION_EXISTS_MESSAGE =
  "You already have a scheduled room. You can create a new future room only after your current scheduled room has been completed, cancelled, or closed.";
const SPONSORED_EVENT_REGISTRATION_EXISTS_CODE = "SPONSORED_EVENT_REGISTRATION_EXISTS";
const SPONSORED_EVENT_REGISTRATION_EXISTS_TITLE = "Already in a Sponsored Event";
const SPONSORED_EVENT_REGISTRATION_EXISTS_MESSAGE =
  "You can register for only one Sponsored Event at a time. Leave your current Sponsored Event or wait until it has been completed before registering for another.";

// ── In-memory spectator tracking (resets on server restart) ──────────────────
const spectatorSeen = new Map<string, Map<string, number>>();
function registerSpectator(raceId: string, userId: string): number {
  if (!spectatorSeen.has(raceId)) spectatorSeen.set(raceId, new Map());
  const map = spectatorSeen.get(raceId)!;
  map.set(userId, Date.now());
  const cutoff = Date.now() - 2 * 60_000;
  let count = 0;
  for (const ts of map.values()) { if (ts > cutoff) count++; }
  return count;
}

// ── Startup recovery: complete any races where all participants are already done ─
// Called once from app.ts after routes are mounted. Races now end when winners
// are decided or all participants have finished/forfeited — not on a timer.
export async function recoverStaleRaces(): Promise<void> {
  // Wait briefly so DB connection pool is ready before we hammer it at startup
  await new Promise((r) => setTimeout(r, 2_000));
  try {
    const stale = await db
      .select({
        id: raceRoomsTable.id,
        type: raceRoomsTable.type,
        currentPlayers: raceRoomsTable.currentPlayers,
        startingParticipantCount: raceRoomsTable.startingParticipantCount,
        winnerSlotCount: raceRoomsTable.winnerSlotCount,
        challengeDurationDays: raceRoomsTable.challengeDurationDays,
        challengeEndAt: raceRoomsTable.challengeEndAt,
        startedAt: raceRoomsTable.startedAt,
        scheduledStartAt: raceRoomsTable.scheduledStartAt,
      })
      .from(raceRoomsTable)
      .where(eq(raceRoomsTable.status, "in_progress"));

    for (const race of stale) {
      // Sponsored events: complete immediately if all participants have forfeited (no active racers).
      if (race.type === "sponsored") {
        const sponsoredActive = await db
          .select({ userId: raceParticipantsTable.userId })
          .from(raceParticipantsTable)
          .where(and(
            eq(raceParticipantsTable.raceRoomId, race.id),
            ne(raceParticipantsTable.status, "left"),
            ne(raceParticipantsTable.status, "forfeited"),
          ));
        if (sponsoredActive.length === 0) {
          logger.info({ raceId: race.id }, "[recoverStaleRaces] sponsored — all forfeited, completing");
          autoCompleteRace(race.id, "all_forfeited").catch(() => {});
        }
        // If some participants are still active, leave the race to the 3-hour timer.
        continue;
      }
      if (isDurationChallengeRoom(race)) {
        // All-forfeit safety net (crash recovery): if NOBODY is left in the race (everyone
        // forfeited/left/disqualified), complete now with all_forfeited instead of waiting days
        // for the challenge end date. Matches the /leave early-completion path.
        const durationActive = await db
          .select({ userId: raceParticipantsTable.userId })
          .from(raceParticipantsTable)
          .where(and(
            eq(raceParticipantsTable.raceRoomId, race.id),
            ne(raceParticipantsTable.status, "left"),
            ne(raceParticipantsTable.status, "forfeited"),
            ne(raceParticipantsTable.status, "disqualified"),
          ));
        if (durationActive.length === 0) {
          logger.info({ raceId: race.id }, "[recoverStaleRaces] duration challenge — all forfeited, completing");
          autoCompleteRace(race.id, "all_forfeited").catch(() => {});
          continue;
        }
        const completion = canAutoCompleteDurationChallenge(race, "duration_expired");
        if (completion.allowed) {
          logger.info({ raceId: race.id, challengeEndAt: completion.challengeEndAt?.toISOString() ?? null }, "[recoverStaleRaces] duration expired — completing");
          autoCompleteRace(race.id, "duration_expired").catch(() => {});
          continue;
        }
        // Fall through: winner slots can still finalize multi-day rooms early.
      }
      // Classic fixed races also use 24h from start when nobody filled winner slots.
      if (!isDurationChallengeRoom(race) && race.type !== "sponsored" && race.startedAt) {
        const elapsed = Date.now() - race.startedAt.getTime();
        if (elapsed >= FIXED_RACE_MAX_DURATION_MS) {
          autoCompleteRace(race.id, "race_duration_expired").catch(() => {});
          continue;
        }
      }
      // Complete any race where:
      // (a) all active participants finished — OR
      // (b) enough winner slots are already filled (safety net for missed early-trigger).
      // Fetch per-user (not per-row) to handle duplicate participant rows:
      // a user counts as "done" if ANY of their active rows has finishedGoal=true.
      const activeRows = await db
        .select({ userId: raceParticipantsTable.userId, finishedGoal: raceParticipantsTable.finishedGoal })
        .from(raceParticipantsTable)
        .where(and(
          eq(raceParticipantsTable.raceRoomId, race.id),
          ne(raceParticipantsTable.status, "left"),
          ne(raceParticipantsTable.status, "forfeited"),
        ));
      const userDone = new Map<string, boolean>();
      for (const p of activeRows) {
        userDone.set(p.userId, (userDone.get(p.userId) ?? false) || p.finishedGoal);
      }
      const totalCount = userDone.size;
      const finishedCount = [...userDone.values()].filter(Boolean).length;
      const allDone = totalCount > 0 && finishedCount === totalCount;
      const winnersNeeded =
        typeof race.winnerSlotCount === "number" && race.winnerSlotCount > 0
          ? race.winnerSlotCount
          : getWinnerSlotCount(
              race.startingParticipantCount
                ?? race.currentPlayers
                ?? totalCount,
            ) || numWinners(race.currentPlayers ?? totalCount);
      const enoughWinnersDecided = !allDone && totalCount > 0 && winnersNeeded > 0 && finishedCount >= winnersNeeded;
      if (allDone) {
        autoCompleteRace(race.id, "all_finished_or_forfeited").catch(() => {});
      } else if (enoughWinnersDecided) {
        logger.info({ raceId: race.id, finishedCount, winnersNeeded }, "[recoverStaleRaces] winner slots filled — completing");
        autoCompleteRace(race.id, "winners_decided_recovery").catch(() => {});
      }
    }
  } catch {
    // best-effort, do not crash server
  }
}

// ── Periodic safety net: complete races where all participants are done ────────
// Called every 15s from app.ts. Completes races where everyone has finished or
// forfeited. Fixed-player free/coins/cash races (non-duration) end after 24h from
// start if winners are not decided earlier. Duration challenges run until
// challengeEndAt. Sponsored stays at 3 hours. Unlimited is a separate system.
export async function cleanupOverdueRaces(opts?: { force?: boolean }): Promise<void> {
  try {
    // Fast-path gate: when the durable registry confidently reports zero active races,
    // skip the Postgres scan entirely so Neon compute can suspend while idle. `null`
    // means the registry is unavailable → fail open and scan. `force` bypasses the gate
    // for the hourly backstop, which also reconciles the registry to DB truth.
    if (!opts?.force) {
      const active = await activeRaceCount();
      if (active === 0) return;
    }

    const stale = await db
      .select({
        id: raceRoomsTable.id,
        startedAt: raceRoomsTable.startedAt,
        type: raceRoomsTable.type,
        currentPlayers: raceRoomsTable.currentPlayers,
        startingParticipantCount: raceRoomsTable.startingParticipantCount,
        winnerSlotCount: raceRoomsTable.winnerSlotCount,
        challengeDurationDays: raceRoomsTable.challengeDurationDays,
        challengeEndAt: raceRoomsTable.challengeEndAt,
        scheduledStartAt: raceRoomsTable.scheduledStartAt,
      })
      .from(raceRoomsTable)
      .where(eq(raceRoomsTable.status, "in_progress"));

    // Reconcile the registry to DB truth: drops finalized races (so the gate can close)
    // and (re)adds any in-progress race missing from it (so a missed start-hook self-heals).
    const activeEntries: ActiveRaceEntry[] = stale.map((r) => {
      const isSponsored = r.type === "sponsored";
      const isDuration = isDurationChallengeRoom(r);
      const timeoutAtMs = isSponsored
        ? (r.startedAt?.getTime() ?? Date.now()) + 3 * 60 * 60_000
        : isDuration
          ? (r.challengeEndAt?.getTime()
              ?? (r.startedAt?.getTime() ?? Date.now()) + FIXED_RACE_MAX_DURATION_MS)
          : (r.startedAt?.getTime() ?? Date.now()) + FIXED_RACE_MAX_DURATION_MS;
      return { id: r.id, timeoutAtMs };
    });
    await reconcileActive(activeEntries);

    for (const race of stale) {
      const isSponsored = race.type === "sponsored";
      const isDurationChallenge = isDurationChallengeRoom(race);
      // Sponsored = 3h; multi-day duration = challengeEndAt; classic fixed free/coins/cash = 24h.
      if (race.startedAt) {
        const elapsed = Date.now() - race.startedAt.getTime();
        const timeoutMs = isSponsored
          ? 3 * 60 * 60_000
          : isDurationChallenge
            ? null
            : FIXED_RACE_MAX_DURATION_MS;
        const reason = isSponsored ? "sponsored_duration_expired" : "race_duration_expired";
        if (timeoutMs !== null && elapsed >= timeoutMs) {
          autoCompleteRace(race.id, reason).catch((err) => {
            logger.error({ raceId: race.id, elapsedMs: elapsed, err }, `cleanupOverdueRaces: ${reason} autoCompleteRace failed`);
          });
          continue;
        }
      }
      // Sponsored events: also complete early if all participants have forfeited.
      if (isSponsored) {
        const sponsoredActive = await db
          .select({ userId: raceParticipantsTable.userId })
          .from(raceParticipantsTable)
          .where(and(
            eq(raceParticipantsTable.raceRoomId, race.id),
            ne(raceParticipantsTable.status, "left"),
            ne(raceParticipantsTable.status, "forfeited"),
          ));
        if (sponsoredActive.length === 0) {
          logger.info({ raceId: race.id }, "[cleanupOverdueRaces] sponsored — all forfeited, completing");
          autoCompleteRace(race.id, "all_forfeited").catch((err) => {
            logger.error({ raceId: race.id, err }, "cleanupOverdueRaces: sponsored all_forfeited autoCompleteRace failed");
          });
        }
        continue;
      }
      if (isDurationChallenge) {
        const completion = canAutoCompleteDurationChallenge(race, "duration_expired");
        if (completion.allowed) {
          logger.info({ raceId: race.id, challengeEndAt: completion.challengeEndAt?.toISOString() ?? null }, "[cleanupOverdueRaces] duration expired — completing");
          autoCompleteRace(race.id, "duration_expired").catch((err) => {
            logger.error({ raceId: race.id, err }, "cleanupOverdueRaces: duration_expired autoCompleteRace failed");
          });
          continue;
        }
        // Fall through: winner slots can still finalize multi-day rooms early.
      }
      // Complete races where:
      // (a) all active participants finished — OR
      // (b) enough winner slots are filled (finishedCount >= numWinners) — safety net
      //     for when the per-sync early-winner trigger fired but autoCompleteRace failed.
      // Group by userId to handle duplicate participant rows correctly.
      const activeRows = await db
        .select({ userId: raceParticipantsTable.userId, finishedGoal: raceParticipantsTable.finishedGoal })
        .from(raceParticipantsTable)
        .where(and(
          eq(raceParticipantsTable.raceRoomId, race.id),
          ne(raceParticipantsTable.status, "left"),
          ne(raceParticipantsTable.status, "forfeited"),
        ));
      const userDone = new Map<string, boolean>();
      for (const p of activeRows) {
        userDone.set(p.userId, (userDone.get(p.userId) ?? false) || p.finishedGoal);
      }
      const totalCount = userDone.size;
      const finishedCount = [...userDone.values()].filter(Boolean).length;
      const allDone = totalCount > 0 && finishedCount === totalCount;
      // Prefer frozen start-time winner slots (2→1, 3→2, 4–10→3).
      const winnersNeeded =
        typeof race.winnerSlotCount === "number" && race.winnerSlotCount > 0
          ? race.winnerSlotCount
          : getWinnerSlotCount(
              race.startingParticipantCount
                ?? race.currentPlayers
                ?? totalCount,
            ) || numWinners(race.currentPlayers ?? totalCount);
      const enoughWinnersDecided = !allDone && totalCount > 0 && winnersNeeded > 0 && finishedCount >= winnersNeeded;
      if (allDone) {
        autoCompleteRace(race.id, "all_finished_or_forfeited").catch((err) => {
          logger.error({ raceId: race.id, err }, "cleanupOverdueRaces: all_finished autoCompleteRace failed");
        });
      } else if (enoughWinnersDecided) {
        logger.info({ raceId: race.id, finishedCount, winnersNeeded }, "[cleanupOverdueRaces] winner slots filled — completing");
        autoCompleteRace(race.id, "winners_decided_periodic").catch((err) => {
          logger.error({ raceId: race.id, finishedCount, winnersNeeded, err }, "cleanupOverdueRaces: winners_decided_periodic autoCompleteRace failed");
        });
      }
    }
  } catch (err) {
    logger.error({ err }, "cleanupOverdueRaces: DB query failed");
  }
}

// ── Feature flags ─────────────────────────────────────────────────────────────
/** Controlled by CASH_FEATURES_ENABLED + FEATURE_CASH_FEATURES env vars (see config.ts). */
const ENABLE_CASH_CHALLENGES = config.features.cashFeaturesEnabled;
const ENABLE_COIN_ENTRY_CHALLENGES = config.features.coinEntryChallengesEnabled;

// ── Helpers ───────────────────────────────────────────────────────────────────

function entryAmountCents(entryType: string): number {
  const map: Record<string, number> = {
    free: 0,
    paid_1: 100,
    paid_3: 300,
    paid_5: 500,
    paid_usd: 0, // resolved from customEntryAmountCents in request body
  };
  return map[entryType] ?? 0;
}

function entryTypeLabel(entryType: string): string {
  const map: Record<string, string> = {
    free: "Free",
    paid_1: "$1",
    paid_3: "$3",
    paid_5: "$5",
    paid_usd: "USD Entry",
  };
  return map[entryType] ?? entryType;
}

function deriveChallengeEndAt(room: Pick<typeof raceRoomsTable.$inferSelect, "challengeEndAt" | "challengeDurationDays" | "startedAt" | "scheduledStartAt">): Date | null {
  if (room.challengeEndAt) return room.challengeEndAt;
  if (room.challengeDurationDays <= 0) return null;

  const start = room.startedAt ?? room.scheduledStartAt;
  if (!start) return null;
  return new Date(start.getTime() + room.challengeDurationDays * MS_PER_DAY);
}

function buildChallengeTimeFields(room: Pick<typeof raceRoomsTable.$inferSelect, "challengeEndAt" | "challengeDurationDays" | "startedAt" | "scheduledStartAt">) {
  const challengeEndAt = deriveChallengeEndAt(room);
  const timeLeftSeconds = challengeEndAt
    ? Math.max(0, Math.floor((challengeEndAt.getTime() - Date.now()) / 1000))
    : null;
  const daysLeft = timeLeftSeconds === null ? null : Math.ceil(timeLeftSeconds / 86400);

  return {
    startedAt: room.startedAt?.toISOString() ?? null,
    started_at: room.startedAt?.toISOString() ?? null,
    challengeDurationDays: room.challengeDurationDays,
    challenge_duration_days: room.challengeDurationDays,
    challengeEndAt: challengeEndAt?.toISOString() ?? null,
    challenge_end_at: challengeEndAt?.toISOString() ?? null,
    timeLeftSeconds,
    time_left_seconds: timeLeftSeconds,
    daysLeft,
    days_left: daysLeft,
  };
}

const MANUAL_COMPLETION_REASONS = new Set(["admin_force_complete", "manual_force_complete"]);
// Reasons that bypass the duration-challenge end-date wait. In addition to explicit admin/manual
// force-completes: all_forfeited (nobody left racing) and winner-slot fills (2→1, 3→2, 4–10→3)
// so fixed-player matches can settle as soon as enough finishers exist — including multi-day rooms.
const FORCED_COMPLETION_REASONS = new Set([
  ...MANUAL_COMPLETION_REASONS,
  "all_forfeited",
  "all_finished_or_forfeited",
  "winners_finalized",
  "winners_decided_periodic",
  "winners_decided_recovery",
]);

/**
 * Multi-day "fixed days" challenges (weekly/monthly: 7/30). Classic fixed-player
 * free/coins/cash races use challengeDurationDays 0 (or legacy daily=1) and end by
 * winner slots or 24h from start — not a calendar duration wait.
 */
function isDurationChallengeRoom(room: Pick<typeof raceRoomsTable.$inferSelect, "type" | "challengeDurationDays">): boolean {
  return room.type !== "sponsored" && room.challengeDurationDays > 1;
}

function canAutoCompleteDurationChallenge(
  room: Pick<typeof raceRoomsTable.$inferSelect, "type" | "challengeDurationDays" | "challengeEndAt" | "startedAt" | "scheduledStartAt">,
  endedReason: string,
): { allowed: boolean; challengeEndAt: Date | null } {
  if (!isDurationChallengeRoom(room)) return { allowed: true, challengeEndAt: null };
  if (FORCED_COMPLETION_REASONS.has(endedReason)) return { allowed: true, challengeEndAt: deriveChallengeEndAt(room) };

  const challengeEndAt = deriveChallengeEndAt(room);
  if (!challengeEndAt) return { allowed: false, challengeEndAt: null };
  return { allowed: Date.now() >= challengeEndAt.getTime(), challengeEndAt };
}

async function getTrackThemeMediaMap(codes: Array<string | null | undefined>): Promise<Map<string, TrackThemeMedia>> {
  const normalizedCodes = [...new Set(codes.map((code) => code?.trim()).filter((code): code is string => !!code))];
  const mediaMap = new Map<string, TrackThemeMedia>();
  if (normalizedCodes.length === 0) return mediaMap;

  const themes = await db
    .select({
      code: raceTrackThemesTable.code,
      assetVersion: raceTrackThemesTable.assetVersion,
    })
    .from(raceTrackThemesTable)
    .where(inArray(raceTrackThemesTable.code, normalizedCodes));

  const versionByCode = new Map(themes.map((theme) => [theme.code, theme.assetVersion]));
  for (const code of normalizedCodes) {
    mediaMap.set(code, buildTrackThemeMedia(code, versionByCode.get(code)));
  }
  return mediaMap;
}

function trackThemeForCode(
  code: string | null | undefined,
  mediaMap: Map<string, TrackThemeMedia>,
): TrackThemeMedia {
  const normalizedCode = code?.trim() || "bg";
  return mediaMap.get(normalizedCode) ?? buildTrackThemeMedia(normalizedCode);
}

/** Allowed entry amounts in cents for paid USD challenges: $3, $5, $10, $15, $20, $25. */
const PAID_CHALLENGE_ALLOWED_AMOUNTS_CENTS = new Set([300, 500, 1000, 1500, 2000, 2500]);
/** Valid challenge durations in days. */
const VALID_DURATION_DAYS = new Set([1, 7, 30]);
/** Valid target steps per duration. */
const VALID_TARGET_STEPS_BY_GOAL: Record<string, Set<number>> = {
  daily:   new Set([500, 1000, 2000, 5000, 10000, 15000, 20000]),
  weekly:  new Set([10000, 20000, 35000, 50000, 70000, 100000]),
  monthly: new Set([50000, 100000, 150000, 200000, 300000, 500000]),
};
/** Prize pool = entry fees only. Platform/service fees are charged separately at payment. */
function calcPrizePool(entryAmountCents: number, playerCount: number) {
  const total = calcEntryPoolCents(entryAmountCents, playerCount);
  return { total, platformFee: 0, winners: total };
}

// Cumulative anti-cheat budget. A participant's TOTAL race steps may never exceed
//   ceil(secondsSinceRaceStart × MAX_PROGRESS_STEPS_PER_SECOND) + MAX_PROGRESS_BURST.
// This allowance replenishes at a fixed rate and carries unused budget forward, so it
// cannot be gamed by a per-tick bonus that resets each sync. (The previous 500-step
// per-sync floor let a 3s tick jump ~167 steps/s and effectively defeated the 6/s cap.)
// Overage is clamped to the plausible maximum and flagged for reconciliation — never
// trusted onto the live leaderboard.
const MAX_PROGRESS_STEPS_PER_SECOND = 6;
const MAX_PROGRESS_BURST = 200;
const MAX_DEVICE_TIME_SKEW_MS = 10 * 60 * 1000;

/** How many places get prizes based on player count.
 *  2  players → 1 winner (100%)
 *  3  players → 2 winners (60 / 40)
 *  4+ players → 3 winners (50 / 30 / 20)
 */
function numWinners(playerCount: number): number {
  if (playerCount <= 2) return 1;
  if (playerCount === 3) return 2;
  return 3; // 4+
}

/** Prize split ratios for USD cash races — applied to full entry pool. */
function getPrizeSplits(playerCount: number): number[] {
  const w = numWinners(playerCount);
  if (w === 1) return [1.0];
  if (w === 2) return [0.6, 0.4];
  return [0.5, 0.3, 0.2];
}

/** Prize split ratios for Coins Battle (no platform fee).
 *  2  players → 1 winner (100%)
 *  3  players → 2 winners (60 / 40)
 *  4+ players → 3 winners (50 / 30 / 20)
 */
function getCoinPrizeSplits(playerCount: number): number[] {
  const w = numWinners(playerCount);
  if (w === 1) return [1.0];
  if (w === 2) return [0.6, 0.4];
  return [0.5, 0.3, 0.2];
}

/** Build integer coin reward slots for Coins Battle. Rank-1 absorbs any rounding remainder. */
function buildCoinRewardSlots(coinWinnersPool: number, playerCount: number): Array<{ rank: number; amountCents: number }> {
  if (coinWinnersPool <= 0 || playerCount < 2) return [];
  const splits = getCoinPrizeSplits(playerCount);
  const slots = splits.map((s, i) => ({ rank: i + 1, amountCents: Math.floor(coinWinnersPool * s) }));
  const distributed = slots.reduce((sum, s) => sum + s.amountCents, 0);
  if (slots.length > 0) slots[0].amountCents += coinWinnersPool - distributed;
  return slots;
}

/** Structured per-rank prize breakdown for API responses. Empty for free races. */
function buildRewardSplit(entryAmountCents: number, playerCount: number) {
  if (entryAmountCents === 0 || playerCount < 2) return [];
  const splits = buildCashRewardSplitCents(entryAmountCents, playerCount);
  return splits.map((s) => ({
    rank: s.rank,
    label: s.label,
    percentage: s.percentage,
    amount: parseFloat((s.amountCents / 100).toFixed(2)),
    currency: "USD",
  }));
}

/** Reward split as integer cents — full entry pool, rank-1 absorbs rounding. */
function buildRewardSplitCents(entryAmountCents: number, playerCount: number): Array<{ rank: number; amountCents: number }> {
  return buildCashRewardSplitCents(entryAmountCents, playerCount).map((s) => ({
    rank: s.rank,
    amountCents: s.amountCents,
  }));
}

interface TieParticipant {
  userId: string;
  username: string;
  avatarColor: string;
  countryFlag: string;
  finalSteps: number;
  finishedAt: Date | null;
}

interface TiePayoutResult {
  userId: string;
  rank: number;
  displayRank: number;
  isTied: boolean;
  tieGroupId: string;
  tieGroupSize: number;
  prizeCents: number;
  eligibleForPrize: boolean;
  // Unique 1..N finishing position for an actual winner (new completion-gated settlement only);
  // null/undefined for non-winners and for the legacy tie-based path.
  winnerPosition?: number | null;
}

/**
 * Assign prize payouts with proper tie handling.
 *
 * Ranking:
 * - Primary: finalSteps DESC
 * - Secondary (instant-goal races): finishedAt ASC — faster finisher ranks higher
 *   when both completed the goal; non-finishers sort after finishers
 *
 * Tie groups:
 * - Two players are in the same tie group if they have the same finalSteps AND
 *   (a) neither finished (finishedAt null) — same steps, both still racing, OR
 *   (b) both finished at exactly the same millisecond (extremely rare)
 * - Finishers with different finish times are NOT tied even if steps are equal
 *
 * Prize logic:
 * - Tied players share the combined value of all prize slots their group spans
 * - Integer math; remainder distributed 1-each to first players in the group
 * - Forfeited/left players must be excluded BEFORE calling this function
 */
function assignPayoutsWithTies(
  participants: TieParticipant[],
  rewardSlots: Array<{ rank: number; amountCents: number }>,
): TiePayoutResult[] {
  if (participants.length === 0) return [];

  // Sort: steps DESC, then finishers before non-finishers, earlier finish wins
  const sorted = [...participants].sort((a, b) => {
    if (b.finalSteps !== a.finalSteps) return b.finalSteps - a.finalSteps;
    if (a.finishedAt && b.finishedAt) return a.finishedAt.getTime() - b.finishedAt.getTime();
    if (a.finishedAt) return -1; // a finished, b didn't → a ranks higher
    if (b.finishedAt) return 1;  // b finished, a didn't → b ranks higher
    return 0;
  });

  // Group consecutive players into tie groups:
  // Two players are tied iff same steps AND (neither finished OR exact same finish ms)
  const groups: TieParticipant[][] = [];
  for (const p of sorted) {
    const last = groups[groups.length - 1];
    if (last) {
      const ref = last[0];
      const sameSteps = ref.finalSteps === p.finalSteps;
      const bothFinished = ref.finishedAt !== null && p.finishedAt !== null;
      const neitherFinished = ref.finishedAt === null && p.finishedAt === null;
      const sameFinishMs = bothFinished && ref.finishedAt!.getTime() === p.finishedAt!.getTime();
      if (sameSteps && (neitherFinished || sameFinishMs)) {
        last.push(p);
        continue;
      }
    }
    groups.push([p]);
  }

  const maxPrizeRank = rewardSlots.length > 0 ? rewardSlots[rewardSlots.length - 1].rank : 0;
  const results: TiePayoutResult[] = [];
  let currentRank = 1;

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const groupSize = group.length;
    const startRank = currentRank;
    const endRank = currentRank + groupSize - 1;

    // Which prize slots fall within this group's occupied rank positions?
    const eligibleSlots = rewardSlots.filter((s) => s.rank >= startRank && s.rank <= endRank);
    const totalPrizeCents = eligibleSlots.reduce((sum, s) => sum + s.amountCents, 0);

    const isTied = groupSize > 1;
    const tieGroupId = isTied ? `g${gi + 1}-r${startRank}` : "";

    // Split equally; remainder cents go to first players (deterministic by order)
    const perPlayer = totalPrizeCents > 0 ? Math.floor(totalPrizeCents / groupSize) : 0;
    const remainder = totalPrizeCents > 0 ? totalPrizeCents - perPlayer * groupSize : 0;

    group.forEach((p, idx) => {
      results.push({
        userId: p.userId,
        rank: startRank,
        displayRank: startRank,
        isTied,
        tieGroupId,
        tieGroupSize: groupSize,
        prizeCents: perPlayer + (idx < remainder ? 1 : 0),
        eligibleForPrize: startRank <= maxPrizeRank,
      });
    });

    currentRank += groupSize;
  }

  return results;
}

// Shared auto-complete logic used by the timer, forfeit path, and force-complete endpoint.
// For sponsored events: 1-2 players -> 1 winner, 3-10 players -> 2 winners.
// Only participants who finished the goal can receive gift-card awards.
function buildSponsoredPrizeSlots(playerCount: number, finisherCount: number): Array<{ rank: number; amountCents: number }> {
  const winnerCount = getSponsoredAwardedWinnerCount(playerCount, finisherCount);
  const slots: Array<{ rank: number; amountCents: number }> = [];
  for (let i = 1; i <= winnerCount; i++) {
    slots.push({ rank: i, amountCents: SPONSORED_EVENT_PRIZE_PER_WINNER_CENTS });
  }
  return slots;
}

function assignSponsoredGiftCardPayouts(
  participants: TieParticipant[],
  playerCount: number,
): TiePayoutResult[] {
  const winnerCount = getSponsoredWinnerCount(playerCount);
  const sorted = [...participants].sort((a, b) => {
    if (a.finishedAt && b.finishedAt) return a.finishedAt.getTime() - b.finishedAt.getTime();
    if (a.finishedAt) return -1;
    if (b.finishedAt) return 1;
    return b.finalSteps - a.finalSteps;
  });

  return sorted.map((p, index) => {
    const rank = index + 1;
    const eligibleForPrize = p.finishedAt !== null && rank <= winnerCount;
    return {
      userId: p.userId,
      rank,
      displayRank: rank,
      isTied: false,
      tieGroupId: "",
      tieGroupSize: 1,
      prizeCents: eligibleForPrize ? SPONSORED_EVENT_PRIZE_PER_WINNER_CENTS : 0,
      eligibleForPrize,
    };
  });
}

function targetStepsForRoom(room: Pick<typeof raceRoomsTable.$inferSelect, "type" | "targetSteps">): number {
  return room.type === "sponsored" ? SPONSORED_EVENT_TARGET_STEPS : room.targetSteps;
}

/**
 * Tie-free payout assignment for the completion-gated settlement path (spec: WINNER SELECTION
 * AND FORFEIT LOGIC). Winners (pre-selected by `selectWinners`) receive strictly unique positions
 * ordered by authoritative completion time; every other participant is ranked below them and is
 * NOT eligible for a prize. No tie groups, no prize splitting, no unfilled-slot redistribution.
 */
function assignNewSettlementPayouts(
  participants: Array<{ id: string; userId: string; currentSteps: number; finishedAt: Date | null }>,
  positionByUser: Map<string, number>,
  cashByUser: Map<string, number>,
): TiePayoutResult[] {
  const winners = participants
    .filter((p) => positionByUser.has(p.userId))
    .sort((a, b) => (positionByUser.get(a.userId) ?? 0) - (positionByUser.get(b.userId) ?? 0));
  const nonWinners = participants
    .filter((p) => !positionByUser.has(p.userId))
    .sort((a, b) => {
      if (a.finishedAt && b.finishedAt) return a.finishedAt.getTime() - b.finishedAt.getTime();
      if (a.finishedAt) return -1;
      if (b.finishedAt) return 1;
      return b.currentSteps - a.currentSteps;
    });

  const results: TiePayoutResult[] = [];
  for (const w of winners) {
    const pos = positionByUser.get(w.userId) ?? 0;
    results.push({
      userId: w.userId,
      rank: pos,
      displayRank: pos,
      isTied: false,
      tieGroupId: "",
      tieGroupSize: 1,
      prizeCents: cashByUser.get(w.userId) ?? 0,
      eligibleForPrize: true,
      winnerPosition: pos,
    });
  }
  let nextRank = winners.length + 1;
  for (const l of nonWinners) {
    results.push({
      userId: l.userId,
      rank: nextRank,
      displayRank: nextRank,
      isTied: false,
      tieGroupId: "",
      tieGroupSize: 1,
      prizeCents: 0,
      eligibleForPrize: false,
      winnerPosition: null,
    });
    nextRank += 1;
  }
  return results;
}

/** Durable, non-fatal audit of a verification/reconciliation decision (system or operations). */
async function writeVerificationAudit(row: {
  raceId: string; userId: string; liveSteps: number | null; verifiedSteps: number | null;
  reconciledSteps: number | null; verificationStatus: string;
  decision: "verified" | "held" | "approved_manually" | "rejected" | "excluded";
  reasonCode: string; decidedBy: "system" | "operations";
}): Promise<void> {
  try {
    await db.insert(verificationDecisionAuditTable).values(row);
  } catch (err) {
    logger.warn({ err, raceId: row.raceId, userId: row.userId }, "verification audit write failed (non-fatal)");
  }
}

export async function autoCompleteRace(raceId: string, endedReason = "time_expired"): Promise<void> {
  const [room] = await db
    .select()
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.id, raceId))
    .limit(1);

  if (!room || room.status !== "in_progress") return;

  const durationCompletion = canAutoCompleteDurationChallenge(room, endedReason);
  if (!durationCompletion.allowed) {
    logger.warn(
      {
        raceId,
        endedReason,
        challengeDurationDays: room.challengeDurationDays,
        challengeEndAt: durationCompletion.challengeEndAt?.toISOString() ?? null,
        startedAt: room.startedAt?.toISOString() ?? null,
      },
      "autoCompleteRace: blocked early duration challenge completion",
    );
    return;
  }

  logger.info({ raceId, endedReason }, "autoCompleteRace: starting completion");

  // Redis-mode races: freeze + flush live state to Postgres so the payout below reads the
  // authoritative final steps, not a stale checkpoint. No-op for postgres-mode races.
  if (room.liveStateMode === "redis") {
    try {
      await flushRedisRaceToPostgres(raceId);
    } catch (err) {
      logger.error({ err, raceId }, "autoCompleteRace: redis flush failed — finalizing on last checkpoint");
    }
  }

  const participants = await db
    .select({
      id: raceParticipantsTable.id,
      userId: raceParticipantsTable.userId,
      currentSteps: raceParticipantsTable.currentSteps,
      finishedAt: raceParticipantsTable.finishedAt,
      finishedAtMs: raceParticipantsTable.finishedAtMs,
      finishRank: raceParticipantsTable.finishRank,
      username: profilesTable.username,
      avatarColor: profilesTable.avatarColor,
      countryFlag: profilesTable.countryFlag,
      // Hybrid reconciliation state — read for authoritative-step selection (§15).
      reconciledSteps: raceParticipantsTable.reconciledSteps,
      reconciliationStatus: raceParticipantsTable.reconciliationStatus,
      verifiedCumulativeSteps: raceParticipantsTable.verifiedCumulativeSteps,
      reconciliationReasonCodes: raceParticipantsTable.reconciliationReasonCodes,
    })
    .from(raceParticipantsTable)
    .innerJoin(profilesTable, eq(raceParticipantsTable.userId, profilesTable.id))
    .where(and(
      eq(raceParticipantsTable.raceRoomId, raceId),
      // Exclude left, forfeited, and disqualified — none may win (§5, §14, §15).
      ne(raceParticipantsTable.status, "left"),
      ne(raceParticipantsTable.status, "forfeited"),
      ne(raceParticipantsTable.status, "disqualified"),
    ))
    .orderBy(desc(raceParticipantsTable.currentSteps));

  // ── Authoritative step total (§15) ─────────────────────────────────────────
  // Winner/payout logic is UNCHANGED — it just receives this integer. When the hybrid flag is on
  // and a participant's reconciliation has been finalized, the reconciled total is authoritative;
  // otherwise (flag off, or reconciliation not finalized) we use currentSteps exactly as before.
  const useHybrid = config.features.hybridReconciliationEnabled;
  const authoritativeSteps = (p: {
    currentSteps: number;
    reconciledSteps: number | null;
    reconciliationStatus: string | null;
  }): number => {
    if (useHybrid && p.reconciliationStatus === "finalized" && p.reconciledSteps != null) {
      return p.reconciledSteps;
    }
    return p.currentSteps;
  };

  // ── Simulation guard: for any prize-bearing race, strip simulation participants ─
  // A participant who sent ANY "simulation" step-source sync for this race is
  // disqualified from prizes.  Free races are unaffected.
  const isPrizedRace = room.entryAmountCents > 0
    || room.entryType === "coins_battle"
    || room.type === "sponsored";

  // ── Finalization reconciliation pass (§13/§14/§15) ──────────────────────────
  //   • verified present → reconcile; matched/within_tolerance ⇒ finalize on reconciled,
  //                        review_required ⇒ hold (not finalized).
  //   • verified absent  → within grace ⇒ DEFER (retry); after grace ⇒ strict: hold for review,
  //                        non-strict: settle on the capped live total (approved timeout).
  // Session conflicts (§18) force review. Both source values are preserved for audit.
  // STRICT verification applies to participant-funded (real-money) races: their winners/payouts
  // must NEVER come from provisional live progress. A missing verification is held (pending →
  // review), never auto-settled on live. Non-strict races (coins/sponsored, or strict flag off)
  // keep the pragmatic fallback: settle on the server-capped live total after the short timeout.
  const strictRace = useHybrid && config.hybridReconciliation.strictEnabled && room.entryAmountCents > 0;
  // Participants held (review_required) on a strict race — used for selective payout below.
  const heldUserIds = new Set<string>();
  if (useHybrid && isPrizedRace) {
    const anyVerificationInUse = participants.some(
      (p) => p.verifiedCumulativeSteps != null || (p.reconciliationReasonCodes ?? []).includes("session_conflict"),
    );
    // Strict races always run the pass (even with zero verification — they must be held, not paid).
    if (anyVerificationInUse || strictRace) {
      const raceEndedAtMs = (durationCompletion.challengeEndAt ?? room.startedAt ?? new Date()).getTime();
      const nowMs = Date.now();
      const elapsedMs = nowMs - raceEndedAtMs;
      const graceMs = strictRace ? config.hybridReconciliation.graceMs : config.hybridReconciliation.finalizeTimeoutMs;
      let anyPendingInGrace = false; // verification may still arrive → defer + retry
      let anyHeldForReview = false;  // grace elapsed, still unresolved → hold for ops (strict only)
      const reconWrites: Array<Promise<unknown>> = [];
      for (const p of participants) {
        if (p.reconciliationStatus === "finalized") continue; // already consumed — idempotent
        const hasVerification = p.verifiedCumulativeSteps != null;
        const sessionConflict = (p.reconciliationReasonCodes ?? []).includes("session_conflict");

        // ── Missing verification ────────────────────────────────────────────────
        if (!hasVerification && !sessionConflict) {
          if (elapsedMs <= graceMs) { anyPendingInGrace = true; continue; } // within grace → wait
          if (strictRace) {
            // Grace elapsed on a funded race: HOLD for review — never settle on live.
            anyHeldForReview = true;
            heldUserIds.add(p.userId);
            p.reconciliationStatus = "review_required";
            reconWrites.push(
              db.update(raceParticipantsTable)
                .set({ reconciliationStatus: "review_required", reconciledAt: new Date(nowMs),
                  reconciliationReasonCodes: ["verification_missing", "held_for_review"] })
                .where(and(eq(raceParticipantsTable.raceRoomId, raceId), eq(raceParticipantsTable.userId, p.userId),
                  ne(raceParticipantsTable.reconciliationStatus, "finalized")))
                .catch(() => {}),
            );
            void writeVerificationAudit({ raceId, userId: p.userId, liveSteps: p.currentSteps, verifiedSteps: null,
              reconciledSteps: null, verificationStatus: "review_required", decision: "held",
              reasonCode: "verification_missing", decidedBy: "system" });
            void triggerEvent(`public-live-race-${raceId}`, "race:review_required", { userId: p.userId });
            void sendNotification(p.userId, "race_verification_pending", "Verifying your steps",
              "We're confirming your race steps with your health app before finalizing.",
              { raceId, dedupeKey: `verif_pending:${raceId}:${p.userId}` }).catch(() => {});
            continue;
          }
          // Non-strict: approved timeout behaviour — settle on the capped live total.
          p.reconciledSteps = p.currentSteps;
          p.reconciliationStatus = "finalized";
          reconWrites.push(
            db.update(raceParticipantsTable)
              .set({ reconciledSteps: p.currentSteps, reconciliationStatus: "finalized", reconciledAt: new Date(nowMs),
                reconciliationReasonCodes: ["verification_window_elapsed", "fallback_to_live"] })
              .where(and(eq(raceParticipantsTable.raceRoomId, raceId), eq(raceParticipantsTable.userId, p.userId),
                ne(raceParticipantsTable.reconciliationStatus, "finalized")))
              .catch(() => {}),
          );
          void triggerEvent(`public-live-race-${raceId}`, "race:verification_delayed", { userId: p.userId });
          continue;
        }

        // ── Verification present (or session conflict) → reconcile ────────────────
        const result = reconcileParticipant({
          liveSteps: p.currentSteps,
          verifiedSteps: p.verifiedCumulativeSteps ?? null,
          raceEndedAtMs,
          nowMs,
          tolerances: config.hybridReconciliation,
        });
        const decision = finalizationDecision(result, { sessionConflict });
        if (decision.defer) { anyPendingInGrace = true; continue; }
        p.reconciledSteps = decision.reconciledSteps;
        p.reconciliationStatus = decision.finalize ? "finalized" : decision.status;
        if (!decision.finalize) { anyHeldForReview = true; heldUserIds.add(p.userId); } // review blocks strict payout
        void writeVerificationAudit({ raceId, userId: p.userId, liveSteps: p.currentSteps,
          verifiedSteps: p.verifiedCumulativeSteps ?? null, reconciledSteps: decision.reconciledSteps,
          verificationStatus: p.reconciliationStatus, decision: decision.finalize ? "verified" : "held",
          reasonCode: decision.reasonCodes[0] ?? "reconciled", decidedBy: "system" });
        reconWrites.push(
          db.update(raceParticipantsTable)
            .set({ reconciledSteps: decision.reconciledSteps, reconciliationStatus: p.reconciliationStatus,
              reconciledAt: new Date(nowMs), reconciliationReasonCodes: decision.reasonCodes })
            .where(and(eq(raceParticipantsTable.raceRoomId, raceId), eq(raceParticipantsTable.userId, p.userId),
              ne(raceParticipantsTable.reconciliationStatus, "finalized")))
            .catch((err) => logger.error({ err, raceId, userId: p.userId }, "reconciliation persist failed")),
        );
        if (decision.status === "review_required") {
          void triggerEvent(`public-live-race-${raceId}`, "race:review_required", { userId: p.userId });
        } else if (decision.finalize && decision.reconciledSteps !== p.currentSteps) {
          void sendNotification(p.userId, "race_reconciliation_complete", "Race steps confirmed",
            "Your verified race steps have been reconciled.", { raceId, dedupeKey: `recon_done:${raceId}:${p.userId}` })
            .catch(() => {});
        }
        void triggerEvent(`public-live-race-${raceId}`, "participant:reconciled_progress_changed", {
          userId: p.userId, reconciledSteps: decision.reconciledSteps, reconciliationStatus: p.reconciliationStatus,
        });
      }
      await Promise.allSettled(reconWrites);

      // Grace-window deferral: verification may still arrive → wait and retry.
      if (anyPendingInGrace) {
        void db.update(raceRoomsTable).set({ settlementStatus: "awaiting_verification" })
          .where(eq(raceRoomsTable.id, raceId)).catch(() => {});
        logger.info({ raceId, strictRace }, "autoCompleteRace: deferring — awaiting verification within grace window");
        return; // scheduler retries; verification may still arrive
      }
      if (strictRace && anyHeldForReview) {
        void db.update(raceRoomsTable).set({ settlementStatus: "review_required" })
          .where(eq(raceRoomsTable.id, raceId)).catch(() => {});
      }
    }
  }

  const simulatedUserIds = new Set<string>();
  if (isPrizedRace) {
    const participantUserIds = participants.map((p) => p.userId);
    if (participantUserIds.length > 0) {
      const syncLogs = await db
        .select({
          userId: raceStepSyncLogsTable.userId,
          stepSource: raceStepSyncLogsTable.stepSource,
        })
        .from(raceStepSyncLogsTable)
        .where(
          and(
            eq(raceStepSyncLogsTable.raceId, raceId),
            inArray(raceStepSyncLogsTable.userId, participantUserIds),
          ),
        );
      for (const log of syncLogs) {
        if (log.stepSource === "simulation") {
          simulatedUserIds.add(log.userId);
        }
      }
      if (simulatedUserIds.size > 0) {
        logger.warn(
          { raceId, simulatedUserIds: [...simulatedUserIds] },
          "[SimulationGuard] disqualifying %d simulation-source participants from prize",
          simulatedUserIds.size,
        );
      }
    }
  }

  // Deduplicate by userId — keep highest step count per user (authoritative total)
  const seenUsers = new Map<string, typeof participants[number]>();
  for (const p of participants) {
    const existing = seenUsers.get(p.userId);
    if (!existing || authoritativeSteps(p) > authoritativeSteps(existing)) {
      seenUsers.set(p.userId, p);
    }
  }
  const isPaidUsd = room.entryType === "paid_usd";

  // For paid_usd: completion order wins (first to finish = 1st place).
  // For all other types: steps DESC, tiebreak by finish time.
  const uniqueParticipants = [...seenUsers.values()].sort((a, b) => {
    if (isPaidUsd) {
      // Both completed goal → earlier timestamp wins
      if (a.finishedAt && b.finishedAt) return a.finishedAt.getTime() - b.finishedAt.getTime();
      // Completer beats non-completer
      if (a.finishedAt) return -1;
      if (b.finishedAt) return 1;
      // Neither finished → more steps ranks higher
      return authoritativeSteps(b) - authoritativeSteps(a);
    }
    // Default: steps DESC, then finishedAt ASC as tiebreaker
    if (authoritativeSteps(b) !== authoritativeSteps(a)) return authoritativeSteps(b) - authoritativeSteps(a);
    if (a.finishedAt && b.finishedAt) return a.finishedAt.getTime() - b.finishedAt.getTime();
    if (a.finishedAt) return -1;
    if (b.finishedAt) return 1;
    return 0;
  });

  const isSponsored = room.type === "sponsored";
  const sponsoredPlayerCount = uniqueParticipants.length;
  const sponsoredPrizeCents = isSponsored ? getSponsoredPrizePoolCents(sponsoredPlayerCount) : 0;

  // ── New completion-gated settlement (spec: WINNER SELECTION AND FORFEIT LOGIC) ──
  // Applies to NON-sponsored races that started after this shipped (startingParticipantCount
  // frozen). Sponsored keeps its existing finisher-gated path; legacy races (null starting
  // count) keep the historical steps-ranked path. Here ONLY participants who completed the
  // full target within the race duration can win; winners get unique positions ordered by
  // authoritative completion time; unfilled winner slots are retained by the platform (§13).
  const raceEndAtForSettlement = deriveChallengeEndAt(room);
  const useNewSettlement = !isSponsored && room.startingParticipantCount != null;
  let newSettlement: {
    winnerSlotCount: number;
    positionByUser: Map<string, number>;
    cashByUser: Map<string, number>;
    coinsByUser: Map<string, number>;
    winnersPoolCents: number;
    totalPoolCents: number;
    awardedCashCents: number;
  } | null = null;
  if (useNewSettlement) {
    const startCount = room.startingParticipantCount ?? 0;
    const winnerSlotCount = room.winnerSlotCount ?? getWinnerSlotCount(startCount);
    const completers: Completer[] = uniqueParticipants
      .filter((p) =>
        p.finishedAtMs != null
        && !simulatedUserIds.has(p.userId)
        && (raceEndAtForSettlement == null || (p.finishedAtMs as number) <= raceEndAtForSettlement.getTime()),
      )
      .map((p) => ({
        participantId: p.id,
        userId: p.userId,
        goalCompletedAtMs: p.finishedAtMs as number,
        finishRank: p.finishRank ?? null,
        finalSteps: authoritativeSteps(p),
      }));
    const winners = selectWinners(completers, winnerSlotCount, raceId);

    // Pool + percentage splits key off the FROZEN starting count, so forfeited players' retained
    // entry fees / coins stay in the pool (§9) and slot percentages match the starting size (§13).
    const pool = calcPrizePool(room.entryAmountCents, startCount);
    const cashSlots = room.entryAmountCents > 0 ? buildRewardSplitCents(room.entryAmountCents, startCount) : [];
    const coinSlots = room.entryType === "coins_battle" && room.coinPrizePool > 0
      ? buildCoinRewardSlots(room.coinPrizePool, startCount)
      : [];

    const positionByUser = new Map<string, number>();
    const cashByUser = new Map<string, number>();
    const coinsByUser = new Map<string, number>();
    let awardedCashCents = 0;
    for (const w of winners) {
      positionByUser.set(w.userId, w.position);
      const cash = cashSlots.find((s) => s.rank === w.position)?.amountCents ?? 0;
      const coins = coinSlots.find((s) => s.rank === w.position)?.amountCents ?? 0;
      if (cash > 0) { cashByUser.set(w.userId, cash); awardedCashCents += cash; }
      if (coins > 0) coinsByUser.set(w.userId, coins);
    }
    newSettlement = {
      winnerSlotCount,
      positionByUser,
      cashByUser,
      coinsByUser,
      winnersPoolCents: pool.winners,
      totalPoolCents: pool.total,
      awardedCashCents,
    };
    logger.info(
      {
        raceId, startCount, winnerSlotCount,
        completerCount: completers.length, winnerCount: winners.length,
        awardedCashCents, unusedToPlatformCents: pool.winners - awardedCashCents,
      },
      "[NewSettlement] completion-gated winners selected: winners=%d/%d slots",
      winners.length, winnerSlotCount,
    );
  }

  const { winners: winnersPoolCents, total: totalPoolCents } = isSponsored && sponsoredPrizeCents > 0
    ? { winners: sponsoredPrizeCents, total: sponsoredPrizeCents }
    : newSettlement
      ? { winners: newSettlement.winnersPoolCents, total: newSettlement.totalPoolCents }
      : calcPrizePool(room.entryAmountCents, uniqueParticipants.length);
  const platformFeeCentsVal = isSponsored
    ? 0
    : newSettlement
      // Unfilled winner slots + rounding are retained by the platform (§13) — never redistributed.
      ? (totalPoolCents - newSettlement.awardedCashCents)
      : (totalPoolCents - winnersPoolCents);

  // ── Sponsored events: only finishers (reached goal) win prizes ──────────────
  // If nobody finished 10k steps the prize goes unclaimed (no award).
  const sponsoredFinishers = isSponsored
    ? uniqueParticipants.filter((p) => p.finishedAt !== null)
    : uniqueParticipants;

  // ── Build integer-cent reward slots ─────────────────────────────────────────
  const rewardSlots = isSponsored && sponsoredPrizeCents > 0
    ? buildSponsoredPrizeSlots(sponsoredPlayerCount, sponsoredFinishers.length)
    : newSettlement
      ? buildRewardSplitCents(room.entryAmountCents, room.startingParticipantCount ?? 0)
      : buildRewardSplitCents(room.entryAmountCents, uniqueParticipants.length);

  // ── Tie-aware payout assignment ──────────────────────────────────────────────
  const tieParticipants: TieParticipant[] = uniqueParticipants.map((p) => ({
    userId: p.userId,
    username: p.username,
    avatarColor: p.avatarColor ?? "#00E676",
    countryFlag: p.countryFlag ?? "🏳️",
    finalSteps: authoritativeSteps(p),
    finishedAt: p.finishedAt ?? null,
  }));

  logger.info(
    { raceId, rewardSlots, eligibleCount: tieParticipants.length },
    "[TiePayout] race_id: %s reward_split: %j eligible participants: %d",
    raceId, rewardSlots, tieParticipants.length,
  );

  const payouts = isSponsored
    ? assignSponsoredGiftCardPayouts(tieParticipants, sponsoredPlayerCount)
    : newSettlement
      ? assignNewSettlementPayouts(uniqueParticipants, newSettlement.positionByUser, newSettlement.cashByUser)
      : assignPayoutsWithTies(tieParticipants, rewardSlots);

  // Log tie groups
  const stepGroupMap = new Map<number, string[]>();
  for (const p of tieParticipants) {
    const arr = stepGroupMap.get(p.finalSteps) ?? [];
    arr.push(p.userId);
    stepGroupMap.set(p.finalSteps, arr);
  }
  logger.info({ raceId, groups: Object.fromEntries(stepGroupMap) }, "[TiePayout] grouped by final_steps");

  for (const payout of payouts) {
    if (payout.isTied) {
      logger.info(
        { raceId, userId: payout.userId, rank: payout.rank, tieGroupId: payout.tieGroupId, tieGroupSize: payout.tieGroupSize, prizeCents: payout.prizeCents },
        "[TiePayout] tie group: userId=%s rank=%d tieGroupId=%s tieGroupSize=%d prizeCents=%d",
        payout.userId, payout.rank, payout.tieGroupId, payout.tieGroupSize, payout.prizeCents,
      );
    }
  }

  const totalAwarded = payouts.reduce((sum, p) => sum + p.prizeCents, 0);
  const unawardedAmountCents = winnersPoolCents - totalAwarded;
  const tieRulesApplied = payouts.some((p) => p.isTied);

  logger.info(
    { raceId, totalAwarded, unawardedAmountCents, tieRulesApplied },
    "[TiePayout] final payouts saved: totalAwarded=%d unawardedAmountCents=%d tieRulesApplied=%s",
    totalAwarded, unawardedAmountCents, tieRulesApplied,
  );

  // ── Coins Battle pool allocation (100% to winners — no platform fee) ─────────
  // Uses the same assignPayoutsWithTies logic to correctly combine prize slots
  // across tie groups (e.g. 1st+2nd prizes split when tied for 1st in a 3-player race).
  let coinWinnersPool = 0;
  let coinPlatformFeeCoins = 0;

  const coinPrizeMap = new Map<string, number>();
  if (room.entryType === "coins_battle" && room.coinPrizePool > 0) {
    coinWinnersPool = room.coinPrizePool;
    if (newSettlement) {
      // Completion-gated: coins already assigned to the unique-position winners only.
      // Undistributed coins (unfilled slots + rounding) are retained by the platform (§13).
      for (const [uid, coins] of newSettlement.coinsByUser) coinPrizeMap.set(uid, coins);
      const totalDistributed = [...coinPrizeMap.values()].reduce((sum, c) => sum + c, 0);
      coinPlatformFeeCoins = coinWinnersPool - totalDistributed;
      logger.info(
        { raceId, coinPrizePool: room.coinPrizePool, coinWinnersPool, coinPlatformFeeCoins, winnerPayouts: Object.fromEntries(coinPrizeMap) },
        "[CoinsBattle] completion-gated pool: total=%d distributed=%d platform=%d payouts=%j",
        room.coinPrizePool, totalDistributed, coinPlatformFeeCoins, Object.fromEntries(coinPrizeMap),
      );
    } else {
      // buildCoinRewardSlots uses getCoinPrizeSplits (70/30 for 3p, 50/30/20 for 4+)
      const coinSlots = buildCoinRewardSlots(coinWinnersPool, uniqueParticipants.length);
      // Reuse assignPayoutsWithTies — "amountCents" field = coin amounts here
      const coinPayouts = assignPayoutsWithTies(tieParticipants, coinSlots);
      for (const cp of coinPayouts) {
        if (cp.eligibleForPrize && cp.prizeCents > 0) {
          coinPrizeMap.set(cp.userId, cp.prizeCents);
        }
      }
      const totalDistributed = [...coinPrizeMap.values()].reduce((sum, c) => sum + c, 0);
      const coinRoundingRemainder = coinWinnersPool - totalDistributed;
      logger.info(
        { raceId, coinPrizePool: room.coinPrizePool, coinWinnersPool, roundingRemainder: coinRoundingRemainder, winnerPayouts: Object.fromEntries(coinPrizeMap) },
        "[CoinsBattle] pool: total=%d winners=%d remainder=%d payouts=%j",
        room.coinPrizePool, coinWinnersPool, coinRoundingRemainder, Object.fromEntries(coinPrizeMap),
      );
    }
  }

  // [PaidRewards] logging for USD paid challenges
  if (isPaidUsd) {
    const participantCount = uniqueParticipants.length;
    const totalPoolCentsLog = calcEntryPoolCents(room.entryAmountCents, participantCount);
    const winnerPoolCentsLog = totalPoolCentsLog;
    const winnerCountLog = numWinners(participantCount);
    const winnersSortedByMs = uniqueParticipants
      .filter((p) => p.finishedAt !== null)
      .map((p) => ({ userId: p.userId, ms: p.finishedAt!.getTime() }));
    const payoutAmountsLog = payouts.filter((p) => p.prizeCents > 0).map((p) => ({ userId: p.userId, rank: p.rank, cents: p.prizeCents }));

    logger.info({ raceId }, "[PaidRewards] challenge id: %s", raceId);
    logger.info({ raceId, entryAmountCents: room.entryAmountCents }, "[PaidRewards] entry amount cents: %d", room.entryAmountCents);
    logger.info({ raceId, participantCount }, "[PaidRewards] participant count: %d", participantCount);
    logger.info({ raceId, totalPoolCentsLog }, "[PaidRewards] entry pool cents: %d", totalPoolCentsLog);
    logger.info({ raceId, winnerPoolCentsLog }, "[PaidRewards] prize pool cents: %d", winnerPoolCentsLog);
    logger.info({ raceId, winnerCountLog }, "[PaidRewards] winner count: %d", winnerCountLog);
    logger.info({ raceId, winnersSortedByMs }, "[PaidRewards] winners sorted by ms: %j", winnersSortedByMs);
    logger.info({ raceId, payoutAmountsLog }, "[PaidRewards] payout amounts: %j", payoutAmountsLog);
  }

  // Build result rows with all tie fields + goal completion timestamps.
  // Simulation guard: override prize eligibility for disqualified users.
  const resultRows = payouts.map((payout) => {
    const tp = tieParticipants.find((p) => p.userId === payout.userId);
    const completedAt = tp?.finishedAt ?? null;
    const isSimulatedUser = simulatedUserIds.has(payout.userId);
    // A held (review_required) participant on a funded race is out of the money by the selective
    // check below — record them as under review with no prize, never as a verified winner.
    const isHeld = heldUserIds.has(payout.userId);
    const ineligible = isSimulatedUser || isHeld;
    // Prefer the explicitly stored finishedAtMs (bigint, set at JS Date.now() when goal crossed)
    // over deriving from the timestamp column — avoids precision loss on old rows that predate the column.
    const participant = participants.find((p) => p.userId === payout.userId);
    const goalCompletedAtMs = participant?.finishedAtMs ?? (completedAt ? completedAt.getTime() : null);
    return {
      raceRoomId: raceId,
      userId: payout.userId,
      rank: payout.rank,
      displayRank: payout.displayRank,
      steps: tp?.finalSteps ?? 0,
      prizeCents: ineligible ? 0 : payout.prizeCents,
      prizeCoins: ineligible ? 0 : (coinPrizeMap.get(payout.userId) ?? 0),
      isTied: payout.isTied,
      tieGroupId: payout.tieGroupId || null,
      tieGroupSize: payout.tieGroupSize,
      eligibleForPrize: ineligible ? false : payout.eligibleForPrize,
      // Unique winner position (new settlement). Null for non-winners, simulated users, and
      // legacy/sponsored rows — enforced unique per race by the partial index.
      winnerPosition: ineligible ? null : (payout.winnerPosition ?? null),
      goalCompletedAt: completedAt,
      goalCompletedAtMs,
      status: isSimulatedUser ? "disqualified_simulation" : (isHeld ? "review_required" : "verified"),
      // Denormalized reconciliation mirror (§4). Null when the hybrid flag is off → flag-off writes
      // are unchanged. authoritativeStepSource records whether `steps` came from live or reconciled.
      reconciliationStatus: useHybrid ? (participant?.reconciliationStatus ?? null) : null,
      authoritativeStepSource: useHybrid
        && participant?.reconciliationStatus === "finalized"
        && participant?.reconciledSteps != null
        ? "reconciled"
        : (useHybrid ? "live" : null),
    };
  });
  const actualWinnerCount = isSponsored
    ? resultRows.filter((r) => r.eligibleForPrize && r.prizeCents > 0).length
    : newSettlement
      ? newSettlement.positionByUser.size
      : numWinners(uniqueParticipants.length);

  const rewardSplitForRoom = buildRewardSplit(
    room.entryAmountCents,
    newSettlement ? (room.startingParticipantCount ?? 0) : uniqueParticipants.length,
  );

  // ── Selective payout hold (strict funded races, § race-level behavior) ──────
  // An out-of-money unresolved participant must NOT block the winners; but a held participant who
  // could still reach a paid slot holds the entire settlement (never pay a slot whose occupant or
  // amount could change once verification resolves). The ops serverCap guard bounds a held
  // participant's final total to (live + tolerance), so this ceiling is a true upper bound.
  if (strictRace && heldUserIds.size > 0) {
    const tol = config.hybridReconciliation.absoluteToleranceSteps;
    const stepsOf = (uid: string) => tieParticipants.find((t) => t.userId === uid)?.finalSteps ?? 0;
    const paidWinners = payouts.filter((w) => w.prizeCents > 0 && !heldUserIds.has(w.userId));
    const lowestPaidSteps = paidWinners.length > 0 ? Math.min(...paidWinners.map((w) => stepsOf(w.userId))) : 0;
    const heldParticipantRows = participants.filter((p) => heldUserIds.has(p.userId));
    const heldCeiling = (uid: string) =>
      heldParticipantRows.filter((p) => p.userId === uid).reduce((m, p) => Math.max(m, p.currentSteps + tol), 0);
    const contested =
      payouts.some((w) => w.prizeCents > 0 && heldUserIds.has(w.userId))         // a held user is provisionally winning
      || heldParticipantRows.some((p) => p.finishedAt != null)                    // a held goal-finisher could win
      || [...heldUserIds].some((uid) => heldCeiling(uid) >= lowestPaidSteps)      // step-ranking promotion within tolerance
      || paidWinners.length === 0;                                                // no resolved winner yet → a held user could be it
    if (contested) {
      void db.update(raceRoomsTable).set({ settlementStatus: "review_required" })
        .where(eq(raceRoomsTable.id, raceId)).catch(() => {});
      logger.warn({ raceId, heldUserIds: [...heldUserIds] },
        "autoCompleteRace: HELD — an unresolved participant could affect a paid slot; awaiting ops decision");
      void triggerEvent(`public-live-race-${raceId}`, "race:review_required", { raceId, held: true });
      return; // ops resolves via /verification-resolve; the next pass settles
    }
    // Safe: every held participant is provably out of the money. Finalize now; they are recorded as
    // review_required with no payout (above), and the winners below are all verified/reconciled.
    void db.update(raceRoomsTable).set({ settlementStatus: "partially_verified" })
      .where(eq(raceRoomsTable.id, raceId)).catch(() => {});
    logger.info({ raceId, heldUserIds: [...heldUserIds] },
      "autoCompleteRace: proceeding — held participants are out of the money, paying verified winners");
  }

  // ── Step 1: Mark the race completed (critical path — must always commit) ─────
  // This is intentionally NOT in the same transaction as the results insert.
  // If results insertion fails for any reason, the race is still marked done so
  // cleanupOverdueRaces won't loop forever retrying a broken insert.
  let markedCompleted = false;
  try {
    await db.transaction(async (tx) => {
      const payoutFinalizedAt = new Date();
      const completionAllowedSql = FORCED_COMPLETION_REASONS.has(endedReason)
        ? sql`true`
        : sql`(
            ${raceRoomsTable.type} = 'sponsored'
            OR ${raceRoomsTable.challengeDurationDays} <= 0
            OR COALESCE(
              ${raceRoomsTable.challengeEndAt},
              ${raceRoomsTable.startedAt} + (${raceRoomsTable.challengeDurationDays} * interval '1 day'),
              ${raceRoomsTable.scheduledStartAt} + (${raceRoomsTable.challengeDurationDays} * interval '1 day')
            ) <= now()
          )`;
      const updated = await tx
        .update(raceRoomsTable)
        .set({
          status: "completed",
          completedAt: payoutFinalizedAt,
          updatedAt: payoutFinalizedAt,
          ...(useHybrid && { settlementStatus: "paid" }),
          ...(!isSponsored && { prizePoolCents: totalPoolCents }),
          winnersPoolCents,
          platformFeeCents: platformFeeCentsVal,
          rewardSplitJson: rewardSplitForRoom as unknown as null,
          winnerCount: actualWinnerCount,
          unawardedAmountCents,
          payoutFinalizedAt,
          ...(room.entryType === "coins_battle" && {
            coinWinnersPool,
            coinPlatformFee: coinPlatformFeeCoins,
            rewardsProcessed: true,
          }),
        })
        .where(and(
          eq(raceRoomsTable.id, raceId),
          eq(raceRoomsTable.status, "in_progress"),
          completionAllowedSql,
        ))
        .returning({ id: raceRoomsTable.id });

      if (updated.length === 0) return;
      markedCompleted = true;

      if (room.entryAmountCents > 0) {
        await creditCashChallengePrizes(tx, {
          raceRoomId: raceId,
          payouts: resultRows
            .filter((r) => r.eligibleForPrize && r.prizeCents > 0)
            .map((r) => ({ userId: r.userId, rank: r.rank, prizeCents: r.prizeCents })),
        });
      }

      if (isSponsored) {
        await createPendingSponsoredGiftCardAwards({
          database: tx,
          raceRoomId: raceId,
          awards: resultRows
            .filter((r) => r.eligibleForPrize && r.prizeCents > 0)
            .map((r) => ({ userId: r.userId, prizeAmountCents: r.prizeCents })),
          metadata: {
            eventTitle: room.title,
            source: "race_auto_completion",
          },
        });
      }
    });
  } catch (err) {
    logger.error({ raceId, err }, "autoCompleteRace: race_rooms status update failed");
    throw err;
  }

  if (!markedCompleted) {
    logger.warn(
      {
        raceId,
        endedReason,
        challengeDurationDays: room.challengeDurationDays,
        challengeEndAt: deriveChallengeEndAt(room)?.toISOString() ?? null,
        status: room.status,
      },
      "autoCompleteRace: completion update skipped; results were not written",
    );
    return;
  }

  // ── Step 2: Insert result rows (best-effort — race is already closed above) ──
  // Failures here are logged but do not un-complete the race.
  if (resultRows.length > 0) {
    try {
      await db
        .insert(raceResultsTable)
        .values(resultRows)
        .onConflictDoUpdate({
          target: [raceResultsTable.raceRoomId, raceResultsTable.userId],
          set: {
            rank: sql`excluded.rank`,
            displayRank: sql`excluded.display_rank`,
            steps: sql`excluded.steps`,
            prizeCents: sql`excluded.prize_cents`,
            isTied: sql`excluded.is_tied`,
            tieGroupId: sql`excluded.tie_group_id`,
            tieGroupSize: sql`excluded.tie_group_size`,
            eligibleForPrize: sql`excluded.eligible_for_prize`,
            prizeCoins: sql`excluded.prize_coins`,
            winnerPosition: sql`excluded.winner_position`,
            status: sql`excluded.status`,
          },
        });
    } catch (err) {
      logger.error({ raceId, err }, "autoCompleteRace: race_results insert failed (race still completed)");
      // Do NOT rethrow — the race is marked completed; results can be reconciled separately
    }
  }

  logger.info({ raceId, participants: resultRows.length, tieRulesApplied }, "autoCompleteRace: race marked completed");

  // Redis-mode races: mark finalized (late ticks now report "completed") and free live keys.
  if (room.liveStateMode === "redis") {
    await setRaceState(raceId, LIVE_RACE_STATE.FINALIZED).catch(() => {});
    void clearRaceLiveState(raceId, participants.map((p) => p.userId));
  }

  // ── [RaceFinalize] structured diagnostic logs ────────────────────────────────
  const tieGroups = resultRows.filter((r) => r.isTied).map((r) => r.tieGroupId).filter(Boolean);
  const uniqueTieGroups = [...new Set(tieGroups)];
  const rewardType = room.entryAmountCents > 0 ? "cash" : "coins";
  logger.info({ raceId }, "[RaceFinalize] race_id: %s", raceId);
  logger.info({ raceId, challengeType: room.entryType }, "[RaceFinalize] challenge_type: %s", room.entryType);
  logger.info({ raceId, participantCount: uniqueParticipants.length }, "[RaceFinalize] participant_count: %d", uniqueParticipants.length);
  const finalWinnerCount = actualWinnerCount;
  logger.info({ raceId, winnerCount: finalWinnerCount }, "[RaceFinalize] winner_count: %d", finalWinnerCount);
  logger.info({ raceId, finishedUsers: resultRows.filter((r) => r.eligibleForPrize && r.prizeCents > 0).map((r) => r.userId) }, "[RaceFinalize] finished_users: %j", resultRows.map((r) => r.userId));
  logger.info({ raceId, winnerSlotsFinalized: finalWinnerCount }, "[RaceFinalize] winner_slots_finalized: %d", finalWinnerCount);
  logger.info({ raceId, tieGroups: uniqueTieGroups }, "[RaceFinalize] tie_groups: %j", uniqueTieGroups);
  logger.info({ raceId, rewardType }, "[RaceFinalize] reward_type: %s", rewardType);
  logger.info({ raceId, rewardAssignments: resultRows.map((r) => ({ userId: r.userId, rank: r.rank, prize: r.prizeCents })) }, "[RaceFinalize] reward_assignments: %j", resultRows);
  logger.info({ raceId, payoutAssignments: resultRows.filter((r) => r.prizeCents > 0).map((r) => ({ userId: r.userId, prizeCents: r.prizeCents })) }, "[RaceFinalize] payout_assignments: %j", resultRows.filter((r) => r.prizeCents > 0));
  logger.info({ raceId, raceFinished: true, endedReason }, "[RaceFinalize] race_finished: true ended_reason: %s", endedReason);

  // ── Achievement titles evaluation (fire-and-forget) ──────────────────────────
  for (const p of uniqueParticipants) {
    evaluateAndNotify(p.userId).catch(() => {});
  }

  // ── Coin Rewards (fire-and-forget — never blocks race completion) ─────────────
  void (async () => {
    const RACE_LABEL: Record<string, string> = {
      free: "free race", paid_1: "$1 race", paid_3: "$3 race", paid_5: "$5 race", paid_usd: "USD race",
    };
    const RANK_LABEL: Record<number, string> = { 1: "1st", 2: "2nd", 3: "3rd" };

    const jobs: Promise<number | null>[] = [];

    // Only the top N finishers earn race-win coins: 1 for 2-player, 2 for 3-player, 3 for 4+
    const winnerSlots = newSettlement ? newSettlement.winnerSlotCount : numWinners(uniqueParticipants.length);

    for (const r of resultRows) {
      if (isSponsored && !r.eligibleForPrize) continue;
      // Skip coin rewards for simulation-disqualified participants
      if (!r.eligibleForPrize && r.status === "disqualified_simulation") continue;
      // New settlement: ONLY actual winners (unique position set) earn coins — a non-completer
      // holding a display rank ≤ winnerSlots (from an unfilled slot) must NOT be rewarded (§13).
      const isActualWinner = newSettlement ? (r.winnerPosition != null) : (r.rank <= winnerSlots);
      const isRoomWinner = newSettlement ? (r.winnerPosition === 1) : (r.rank === 1);
      // Race-win coins: only for top N winners AND 1k-step-goal races
      if (isActualWinner) {
        const code = getRaceWinRewardCode(room.entryType, r.rank, targetStepsForRoom(room));
        if (code) {
          const raceLabel = RACE_LABEL[room.entryType] ?? "race";
          const rankLabel = RANK_LABEL[r.rank] ?? `${r.rank}th`;
          jobs.push(grantCoinReward(r.userId, code, raceId, `${rankLabel} place in ${raceLabel}`));
        }
      }
      // Room-win coins: 50 coins to whoever wins a public or private room (must be an actual winner).
      if (isRoomWinner) {
        const roomWinCode = room.isPrivate ? "PRIVATE_ROOM_WIN" : "PUBLIC_ROOM_WIN";
        const roomLabel  = room.isPrivate ? "private" : "public";
        jobs.push(grantCoinReward(r.userId, roomWinCode, raceId, `Won a ${roomLabel} room match`));
      }
    }

    await Promise.all(jobs);
  })().catch((err) => logger.error({ raceId, err }, "autoCompleteRace: coin reward grants failed"));

  // ── Coins Battle Prize Payouts (fire-and-forget) ─────────────────────────────
  if (room.entryType === "coins_battle" && room.coinPrizePool > 0) {
    void (async () => {
      const jobs: Promise<number | null>[] = [];
      for (const [uid, coins] of coinPrizeMap.entries()) {
        const payout = payouts.find((p) => p.userId === uid);
        const rank = payout?.displayRank ?? 1;
        const rankLabel = rank === 1 ? "1st" : rank === 2 ? "2nd" : `${rank}th`;
        jobs.push(
          grantVariableCoinReward({
            userId: uid,
            amount: coins,
            rewardCode: `COINS_BATTLE_WIN_${rank}_${raceId}`,
            sourceId: raceId,
            description: `Coins Battle prize: ${rankLabel} place — ${coins} coins`,
          }),
        );
      }
      await Promise.all(jobs);
      logger.info(
        { raceId, coinPrizePool: room.coinPrizePool, coinWinnersPool, coinPlatformFeeCoins, winnerCount: coinPrizeMap.size },
        "[CoinsBattle] prizes credited: total=%d winners=%d platform=%d payouts=%d",
        room.coinPrizePool, coinWinnersPool, coinPlatformFeeCoins, coinPrizeMap.size,
      );
    })().catch((err) => logger.error({ raceId, err }, "autoCompleteRace: coins_battle payout failed"));
  }

  const winnerCount = finalWinnerCount;
  const resultsPayload = resultRows.map((r) => {
    const tp = tieParticipants.find((p) => p.userId === r.userId);
    return {
      userId: r.userId,
      username: tp?.username,
      avatarColor: tp?.avatarColor,
      countryFlag: tp?.countryFlag,
      rank: r.rank,
      displayRank: r.displayRank,
      finalSteps: r.steps,
      prizeCents: r.prizeCents,
      prizeCoins: r.prizeCoins ?? 0,
      coinRewardAmount: room.entryAmountCents === 0 ? r.prizeCents : 0,
      payoutAmount: room.entryAmountCents > 0 ? r.prizeCents / 100 : 0,
      payoutCurrency: room.entryAmountCents > 0 ? "USD" : null,
      isTied: r.isTied,
      tieGroupId: r.tieGroupId,
      tieGroupSize: r.tieGroupSize,
      eligibleForPrize: r.eligibleForPrize,
      isWinner: r.eligibleForPrize && r.prizeCents > 0,
    };
  });

  logger.info({ raceId, resultCount: resultsPayload.length }, "[RaceFinalize] pusher_broadcast: race:completed + race:winners");

  await triggerEvent(`public-live-race-${raceId}`, "race:completed", {
    raceId,
    challengeType: room.entryType,
    endedReason,
    winnerCount,
    rewardType,
    results: resultsPayload,
    ...(room.entryType === "coins_battle" && {
      coinPoolTotal: room.coinPrizePool,
      coinWinnersPool,
      coinPlatformFee: coinPlatformFeeCoins,
    }),
  });
  await triggerEvent(`public-live-race-${raceId}`, "race:winners", {
    raceId,
    tieRulesApplied,
    winners: resultsPayload,
    totalPoolCents,
    winnersPoolCents,
    unawardedAmountCents,
  });
  // §20: final authoritative progress confirmed. Emitted only for hybrid races so existing
  // clients see no new event unless the feature is on. Carries no raw health/payment data.
  if (config.features.hybridReconciliationEnabled) {
    void triggerEvent(`public-live-race-${raceId}`, "race:final_progress_confirmed", { raceId });
  }
}

async function checkPaidEligibility(userId: string, res: ReturnType<Router["get"]> extends (...args: infer _) => void ? never : unknown): Promise<boolean> {
  return true; // simplified — full checks in POST /races
}

type RegularRaceRegistrationRow = {
  roomId: string;
  roomStatus: typeof raceRoomsTable.$inferSelect.status;
  type: typeof raceRoomsTable.$inferSelect.type;
  entryType: typeof raceRoomsTable.$inferSelect.entryType;
  entryAmountCents: number;
  targetSteps: number;
  trackLayout: string;
  creatorId: string;
  currentPlayers: number;
  challengeDurationDays: number;
  challengeEndAt: Date | null;
  startedAt: Date | null;
  scheduledStartAt: Date | null;
  participantCurrentSteps: number | null;
  participantBaselineSteps: number | null;
};

type RegistrationDb = typeof db | DbTx;

type FutureScheduledRoomRow = {
  roomId: string;
  roomStatus: typeof raceRoomsTable.$inferSelect.status;
  type: typeof raceRoomsTable.$inferSelect.type;
  entryType: typeof raceRoomsTable.$inferSelect.entryType;
  creatorId: string;
  scheduledStartAt: Date | null;
  challengeEndAt: Date | null;
};

type SponsoredEventRegistrationRow = {
  roomId: string;
  roomStatus: typeof raceRoomsTable.$inferSelect.status;
  type: typeof raceRoomsTable.$inferSelect.type;
  entryType: typeof raceRoomsTable.$inferSelect.entryType;
  creatorId: string;
  scheduledStartAt: Date | null;
  challengeEndAt: Date | null;
};

async function lockRegularRaceRegistrationForUser(tx: DbTx, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`regular_race_registration:${userId}`}, 0))`);
}

async function getRegularRaceRegistrationForUser(
  dbOrTx: RegistrationDb,
  userId: string,
  excludeRoomId?: string,
): Promise<RegularRaceRegistrationRow | null> {
  const excludeCurrentRoom = excludeRoomId ? ne(raceRoomsTable.id, excludeRoomId) : undefined;

  const [row] = await dbOrTx
    .select({
      roomId: raceRoomsTable.id,
      roomStatus: raceRoomsTable.status,
      type: raceRoomsTable.type,
      entryType: raceRoomsTable.entryType,
      entryAmountCents: raceRoomsTable.entryAmountCents,
      targetSteps: raceRoomsTable.targetSteps,
      trackLayout: raceRoomsTable.trackLayout,
      creatorId: raceRoomsTable.creatorId,
      currentPlayers: raceRoomsTable.currentPlayers,
      challengeDurationDays: raceRoomsTable.challengeDurationDays,
      challengeEndAt: raceRoomsTable.challengeEndAt,
      startedAt: raceRoomsTable.startedAt,
      scheduledStartAt: raceRoomsTable.scheduledStartAt,
      participantCurrentSteps: raceParticipantsTable.currentSteps,
      participantBaselineSteps: raceParticipantsTable.raceBaselineSteps,
    })
    .from(raceRoomsTable)
    .innerJoin(
      raceParticipantsTable,
      and(
        eq(raceParticipantsTable.raceRoomId, raceRoomsTable.id),
        eq(raceParticipantsTable.userId, userId),
        inArray(raceParticipantsTable.status, ["joined", "active"]),
      ),
    )
    .where(and(
      inArray(raceRoomsTable.status, ["open", "full", "in_progress"]),
      ne(raceRoomsTable.type, "sponsored"),
      excludeCurrentRoom,
    ))
    .orderBy(desc(raceRoomsTable.createdAt))
    .limit(1);

  if (row) return row;

  const [registration] = await dbOrTx
    .select({
      roomId: raceRoomsTable.id,
      roomStatus: raceRoomsTable.status,
      type: raceRoomsTable.type,
      entryType: raceRoomsTable.entryType,
      entryAmountCents: raceRoomsTable.entryAmountCents,
      targetSteps: raceRoomsTable.targetSteps,
      trackLayout: raceRoomsTable.trackLayout,
      creatorId: raceRoomsTable.creatorId,
      currentPlayers: raceRoomsTable.currentPlayers,
      challengeDurationDays: raceRoomsTable.challengeDurationDays,
      challengeEndAt: raceRoomsTable.challengeEndAt,
      startedAt: raceRoomsTable.startedAt,
      scheduledStartAt: raceRoomsTable.scheduledStartAt,
      participantCurrentSteps: sql<number | null>`null`,
      participantBaselineSteps: sql<number | null>`null`,
    })
    .from(scheduledRoomRegistrationsTable)
    .innerJoin(raceRoomsTable, eq(raceRoomsTable.id, scheduledRoomRegistrationsTable.raceRoomId))
    .where(and(
      eq(scheduledRoomRegistrationsTable.userId, userId),
      eq(scheduledRoomRegistrationsTable.status, "registered"),
      eq(raceRoomsTable.status, "scheduled"),
      ne(raceRoomsTable.type, "sponsored"),
      excludeCurrentRoom,
    ))
    .orderBy(asc(raceRoomsTable.scheduledStartAt))
    .limit(1);

  return registration ?? null;
}

async function getActiveFutureScheduledRoomForUser(
  dbOrTx: RegistrationDb,
  userId: string,
  excludeRoomId?: string,
): Promise<FutureScheduledRoomRow | null> {
  const now = new Date();
  const excludeCurrentRoom = excludeRoomId ? ne(raceRoomsTable.id, excludeRoomId) : undefined;

  const [registration] = await dbOrTx
    .select({
      roomId: raceRoomsTable.id,
      roomStatus: raceRoomsTable.status,
      type: raceRoomsTable.type,
      entryType: raceRoomsTable.entryType,
      creatorId: raceRoomsTable.creatorId,
      scheduledStartAt: raceRoomsTable.scheduledStartAt,
      challengeEndAt: raceRoomsTable.challengeEndAt,
    })
    .from(scheduledRoomRegistrationsTable)
    .innerJoin(raceRoomsTable, eq(raceRoomsTable.id, scheduledRoomRegistrationsTable.raceRoomId))
    .where(and(
      eq(scheduledRoomRegistrationsTable.userId, userId),
      eq(scheduledRoomRegistrationsTable.status, "registered"),
      eq(raceRoomsTable.status, "scheduled"),
      ne(raceRoomsTable.type, "sponsored"),
      sql`${raceRoomsTable.scheduledStartAt} > ${now}`,
      excludeCurrentRoom,
    ))
    .orderBy(asc(raceRoomsTable.scheduledStartAt))
    .limit(1);

  if (registration) return registration;

  const [createdRoom] = await dbOrTx
    .select({
      roomId: raceRoomsTable.id,
      roomStatus: raceRoomsTable.status,
      type: raceRoomsTable.type,
      entryType: raceRoomsTable.entryType,
      creatorId: raceRoomsTable.creatorId,
      scheduledStartAt: raceRoomsTable.scheduledStartAt,
      challengeEndAt: raceRoomsTable.challengeEndAt,
    })
    .from(raceRoomsTable)
    .where(and(
      eq(raceRoomsTable.creatorId, userId),
      eq(raceRoomsTable.status, "scheduled"),
      ne(raceRoomsTable.type, "sponsored"),
      sql`${raceRoomsTable.scheduledStartAt} > ${now}`,
      excludeCurrentRoom,
    ))
    .orderBy(asc(raceRoomsTable.scheduledStartAt))
    .limit(1);

  return createdRoom ?? null;
}

// ── Shared helper: find a Sponsored Event the user is currently registered for or racing in ─
// Used to enforce "one Sponsored Event at a time". A user is considered engaged in a sponsored
// event while they are an active participant of an open/full/in_progress sponsored room OR
// registered for a scheduled sponsored room. Completed/cancelled events do not count.
async function getActiveSponsoredRegistrationForUser(
  dbOrTx: RegistrationDb,
  userId: string,
  excludeRoomId?: string,
): Promise<SponsoredEventRegistrationRow | null> {
  const excludeCurrentRoom = excludeRoomId ? ne(raceRoomsTable.id, excludeRoomId) : undefined;

  const [participating] = await dbOrTx
    .select({
      roomId: raceRoomsTable.id,
      roomStatus: raceRoomsTable.status,
      type: raceRoomsTable.type,
      entryType: raceRoomsTable.entryType,
      creatorId: raceRoomsTable.creatorId,
      scheduledStartAt: raceRoomsTable.scheduledStartAt,
      challengeEndAt: raceRoomsTable.challengeEndAt,
    })
    .from(raceRoomsTable)
    .innerJoin(
      raceParticipantsTable,
      and(
        eq(raceParticipantsTable.raceRoomId, raceRoomsTable.id),
        eq(raceParticipantsTable.userId, userId),
        inArray(raceParticipantsTable.status, ["joined", "active"]),
      ),
    )
    .where(and(
      eq(raceRoomsTable.type, "sponsored"),
      inArray(raceRoomsTable.status, ["open", "full", "in_progress"]),
      excludeCurrentRoom,
    ))
    .orderBy(desc(raceRoomsTable.createdAt))
    .limit(1);

  if (participating) return participating;

  const [registration] = await dbOrTx
    .select({
      roomId: raceRoomsTable.id,
      roomStatus: raceRoomsTable.status,
      type: raceRoomsTable.type,
      entryType: raceRoomsTable.entryType,
      creatorId: raceRoomsTable.creatorId,
      scheduledStartAt: raceRoomsTable.scheduledStartAt,
      challengeEndAt: raceRoomsTable.challengeEndAt,
    })
    .from(scheduledRoomRegistrationsTable)
    .innerJoin(raceRoomsTable, eq(raceRoomsTable.id, scheduledRoomRegistrationsTable.raceRoomId))
    .where(and(
      eq(scheduledRoomRegistrationsTable.userId, userId),
      eq(scheduledRoomRegistrationsTable.status, "registered"),
      eq(raceRoomsTable.type, "sponsored"),
      eq(raceRoomsTable.status, "scheduled"),
      excludeCurrentRoom,
    ))
    .orderBy(asc(raceRoomsTable.scheduledStartAt))
    .limit(1);

  return registration ?? null;
}

// ── Shared helper: find an active non-sponsored race the user is currently participating in ─
async function getActiveRaceForUser(userId: string) {
  const [row] = await db
    .select({
      roomId: raceRoomsTable.id,
      roomStatus: raceRoomsTable.status,
      type: raceRoomsTable.type,
      entryType: raceRoomsTable.entryType,
      entryAmountCents: raceRoomsTable.entryAmountCents,
      targetSteps: raceRoomsTable.targetSteps,
      trackLayout: raceRoomsTable.trackLayout,
      creatorId: raceRoomsTable.creatorId,
      currentPlayers: raceRoomsTable.currentPlayers,
      challengeDurationDays: raceRoomsTable.challengeDurationDays,
      challengeEndAt: raceRoomsTable.challengeEndAt,
      startedAt: raceRoomsTable.startedAt,
      scheduledStartAt: raceRoomsTable.scheduledStartAt,
      participantCurrentSteps: raceParticipantsTable.currentSteps,
      participantBaselineSteps: raceParticipantsTable.raceBaselineSteps,
    })
    .from(raceRoomsTable)
    .innerJoin(
      raceParticipantsTable,
      and(
        eq(raceParticipantsTable.raceRoomId, raceRoomsTable.id),
        eq(raceParticipantsTable.userId, userId),
        inArray(raceParticipantsTable.status, ["joined", "active"]),
      ),
    )
    .where(and(
      inArray(raceRoomsTable.status, ["open", "full", "in_progress"]),
      ne(raceRoomsTable.type, "sponsored"),
    ))
    .orderBy(desc(raceRoomsTable.createdAt))
    .limit(1);
  return row ?? null;
}

function regularRaceRegistrationConflictBody(row: RegularRaceRegistrationRow, userId: string) {
  return {
    success: false,
    code: REGULAR_RACE_REGISTRATION_EXISTS_CODE,
    title: REGULAR_RACE_REGISTRATION_EXISTS_TITLE,
    message: REGULAR_RACE_REGISTRATION_EXISTS_MESSAGE,
    active_race: activeRacePayload(row, userId),
  };
}

function futureRoomCreationBlockPayload(row: FutureScheduledRoomRow, userId: string) {
  return {
    code: FUTURE_ROOM_CREATION_EXISTS_CODE,
    title: FUTURE_ROOM_CREATION_EXISTS_TITLE,
    message: FUTURE_ROOM_CREATION_EXISTS_MESSAGE,
    scheduled_room: {
      room_id: row.roomId,
      room_status: row.roomStatus,
      room_type: row.type,
      challenge_type: row.entryType,
      current_user_role: row.creatorId === userId ? "host" : "participant",
      scheduled_start_at: row.scheduledStartAt?.toISOString() ?? null,
      challenge_end_at: row.challengeEndAt?.toISOString() ?? null,
      next_screen: "waiting_room",
    },
  };
}

function futureRoomCreationConflictBody(row: FutureScheduledRoomRow, userId: string) {
  return {
    success: false,
    ...futureRoomCreationBlockPayload(row, userId),
  };
}

function sponsoredEventRegistrationConflictBody(row: SponsoredEventRegistrationRow, userId: string) {
  return {
    success: false,
    code: SPONSORED_EVENT_REGISTRATION_EXISTS_CODE,
    title: SPONSORED_EVENT_REGISTRATION_EXISTS_TITLE,
    message: SPONSORED_EVENT_REGISTRATION_EXISTS_MESSAGE,
    sponsored_event: {
      room_id: row.roomId,
      room_status: row.roomStatus,
      room_type: row.type,
      challenge_type: row.entryType,
      current_user_role: row.creatorId === userId ? "host" : "participant",
      scheduled_start_at: row.scheduledStartAt?.toISOString() ?? null,
      challenge_end_at: row.challengeEndAt?.toISOString() ?? null,
      next_screen: "waiting_room",
    },
  };
}

function activeRacePayload(
  row: RegularRaceRegistrationRow,
  userId: string,
  trackTheme: TrackThemeMedia = buildTrackThemeMedia(row.trackLayout ?? "bg"),
) {
  return {
    room_id: row.roomId,
    room_status: row.roomStatus,
    room_type: row.type,
    is_sponsored: row.type === "sponsored",
    challenge_type: row.entryType,
    entry_fee: row.entryAmountCents / 100,
    target_steps: targetStepsForRoom(row),
    current_user_role: row.creatorId === userId ? "host" : "participant",
    can_leave: true,
    next_screen: row.roomStatus === "in_progress" ? "race_track" : "waiting_room",
    track_layout: row.trackLayout ?? "bg",
    trackLayout: row.trackLayout ?? "bg",
    trackTheme,
    // Step restoration data — lets the client restore progress after app close/reopen.
    started_at: row.startedAt?.toISOString() ?? null,
    participant_current_steps: row.participantCurrentSteps ?? 0,
    participant_baseline_steps: row.participantBaselineSteps ?? 0,
  };
}

// ── GET /api/races/current-active ─────────────────────────────────────────────
// Returns the caller's currently active race participation, if any.
router.get("/races/current-active", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const active = await getActiveRaceForUser(userId);
  if (!active) {
    return res.json({ success: true, has_active_race: false, active_race: null });
  }
  const mediaMap = await getTrackThemeMediaMap([active.trackLayout]);
  return res.json({
    success: true,
    has_active_race: true,
    active_race: activeRacePayload(active, userId, trackThemeForCode(active.trackLayout, mediaMap)),
  });
});

// ── GET /api/challenges/available ────────────────────────────────────────────
// Returns per-challenge-type status for the current user's Walk page cards.
// Status values: host_available | join_available | user_hosting_waiting |
//   user_joined_waiting | user_hosting_active | user_joined_active |
//   active_other | finished
export async function getChallengeCardsForUser(userId: string) {
  const entryTypes = ["free", "paid_1", "paid_3", "paid_5", "coins_battle"] as const;

  // ── Housekeeping: auto-cancel abandoned solo waiting rooms ──────────────────
  // Only cancel rooms where nobody has joined (host alone) after 5 minutes.
  // Rooms with 2+ players are never auto-cancelled here — they run until the
  // race completes and winners are decided.
  await db
    .update(raceRoomsTable)
    .set({ status: "cancelled" })
    .where(
      and(
        inArray(raceRoomsTable.status, ["open", "full"]),
        sql`${raceRoomsTable.currentPlayers} <= 1`,
        sql`${raceRoomsTable.createdAt} < NOW() - INTERVAL '5 minutes'`,
      ),
    );

  // ── One-shot aggregation: open/in_progress room counts for all 4 types ──────
  const rawCounts = await db
    .select({
      entryType: raceRoomsTable.entryType,
      status: raceRoomsTable.status,
      count: sql<number>`count(*)::int`,
    })
    .from(raceRoomsTable)
    .where(
      and(
        inArray(raceRoomsTable.entryType, ["free", "paid_1", "paid_3", "paid_5", "coins_battle"]),
        inArray(raceRoomsTable.status, ["open", "in_progress"]),
        ne(raceRoomsTable.type, "sponsored"),
        eq(raceRoomsTable.isPrivate, false),
      ),
    )
    .groupBy(raceRoomsTable.entryType, raceRoomsTable.status);

  const countsMap: Record<string, { open: number; in_progress: number }> = {
    free: { open: 0, in_progress: 0 },
    paid_1: { open: 0, in_progress: 0 },
    paid_3: { open: 0, in_progress: 0 },
    paid_5: { open: 0, in_progress: 0 },
    coins_battle: { open: 0, in_progress: 0 },
  };
  for (const row of rawCounts) {
    if (row.status === "open") countsMap[row.entryType].open = row.count;
    else if (row.status === "in_progress") countsMap[row.entryType].in_progress = row.count;
  }

  const challenges = await Promise.all(
    entryTypes.map(async (et) => {
      // ── Step 1: Is the current user in an active (non-completed) room? ──
      // Completed races are intentionally excluded — a finished race must not
      // block the user from discovering or joining a new open room.
      const userRows = await db
        .select({
          id: raceRoomsTable.id,
          status: raceRoomsTable.status,
          type: raceRoomsTable.type,
          creatorId: raceRoomsTable.creatorId,
          currentPlayers: raceRoomsTable.currentPlayers,
          maxPlayers: raceRoomsTable.maxPlayers,
          targetSteps: raceRoomsTable.targetSteps,
        })
        .from(raceRoomsTable)
        .innerJoin(
          raceParticipantsTable,
          and(
            eq(raceParticipantsTable.raceRoomId, raceRoomsTable.id),
            eq(raceParticipantsTable.userId, userId),
            and(ne(raceParticipantsTable.status, "left"), ne(raceParticipantsTable.status, "forfeited")),
          ),
        )
        .where(
          and(
            eq(raceRoomsTable.entryType, et),
            inArray(raceRoomsTable.status, ["open", "full", "in_progress"]),
            ne(raceRoomsTable.type, "sponsored"),
          ),
        )
        .orderBy(desc(raceRoomsTable.createdAt))
        .limit(1);

      if (userRows.length > 0) {
        const room = userRows[0];
        const isHost = room.creatorId === userId;

        // Active race the user is in
        const lc = countsMap[et].in_progress;
        const wc = countsMap[et].open;

        if (room.status === "in_progress") {
          return {
            entryType: et,
            status: isHost ? "user_hosting_active" : "user_joined_active",
            raceId: room.id,
            isHost, isParticipant: true,
            joinedCount: room.currentPlayers, maxPlayers: room.maxPlayers,
            targetSteps: targetStepsForRoom(room),
            canHost: false, canJoin: false, isActive: true, isFinished: false,
            label: isHost ? "Hosting · Active" : "My Race · Active",
            liveCount: lc, waitingCount: wc, canHostNew: false,
          };
        }

        // Waiting room (open or full) the user is in
        return {
          entryType: et,
          status: isHost ? "user_hosting_waiting" : "user_joined_waiting",
          raceId: room.id,
          isHost, isParticipant: true,
          joinedCount: room.currentPlayers, maxPlayers: room.maxPlayers,
          targetSteps: targetStepsForRoom(room),
          canHost: false, canJoin: false, isActive: false, isFinished: false,
          label: isHost
            ? `Hosting · ${room.currentPlayers}/${room.maxPlayers}`
            : `My Race · ${room.currentPlayers}/${room.maxPlayers}`,
          liveCount: lc, waitingCount: wc, canHostNew: false,
        };
      }

      // ── Step 2: Is there a public open room someone else is hosting? ──
      const joinable = await db
        .select({
          id: raceRoomsTable.id,
          currentPlayers: raceRoomsTable.currentPlayers,
          maxPlayers: raceRoomsTable.maxPlayers,
        })
        .from(raceRoomsTable)
        .where(
          and(
            eq(raceRoomsTable.entryType, et),
            inArray(raceRoomsTable.status, ["open", "full"]),
            ne(raceRoomsTable.type, "sponsored"),
            eq(raceRoomsTable.isPrivate, false),
            sql`${raceRoomsTable.currentPlayers} < ${raceRoomsTable.maxPlayers}`,
          ),
        )
        .orderBy(desc(raceRoomsTable.currentPlayers))
        .limit(1);

      const liveCount  = countsMap[et].in_progress;
      const waitingCount = countsMap[et].open;

      if (joinable.length > 0) {
        const best = joinable[0];
        return {
          entryType: et,
          status: "join_available",
          raceId: best.id,
          isHost: false, isParticipant: false,
          joinedCount: best.currentPlayers, maxPlayers: best.maxPlayers,
          canHost: false, canJoin: true, isActive: false, isFinished: false,
          label: `Join · ${best.currentPlayers}/${best.maxPlayers}`,
          liveCount, waitingCount, canHostNew: true,
        };
      }

      // ── Step 3: Is there an active race the user is not in? ──
      const activeOther = await db
        .select({ id: raceRoomsTable.id, currentPlayers: raceRoomsTable.currentPlayers })
        .from(raceRoomsTable)
        .where(
          and(
            eq(raceRoomsTable.entryType, et),
            eq(raceRoomsTable.status, "in_progress"),
            eq(raceRoomsTable.isPrivate, false),
          ),
        )
        .limit(1);

      if (activeOther.length > 0) {
        return {
          entryType: et,
          status: "active_other",
          raceId: activeOther[0].id,
          isHost: false, isParticipant: false,
          joinedCount: activeOther[0].currentPlayers, maxPlayers: 10,
          canHost: false, canJoin: false, isActive: true, isFinished: false,
          label: "Active",
          liveCount, waitingCount, canHostNew: true,
        };
      }

      // ── Step 4: No room exists — user can host ──
      return {
        entryType: et,
        status: "host_available",
        raceId: null,
        isHost: false, isParticipant: false,
        joinedCount: 0, maxPlayers: 10,
        canHost: true, canJoin: false, isActive: false, isFinished: false,
        label: "Host",
        liveCount, waitingCount, canHostNew: true,
      };
    }),
  );

  return challenges;
}

export async function getRoomCountsSummary() {
  const now = new Date();
  const [currentRows, upcomingRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(raceRoomsTable)
      .where(
        and(
          eq(raceRoomsTable.status, "open"),
          ne(raceRoomsTable.type, "sponsored"),
          sql`${raceRoomsTable.currentPlayers} < ${raceRoomsTable.maxPlayers}`,
        )
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(raceRoomsTable)
      .where(
        and(
          eq(raceRoomsTable.status, "scheduled"),
          ne(raceRoomsTable.type, "sponsored"),
          sql`${raceRoomsTable.scheduledStartAt} > ${now}`,
        )
      ),
  ]);
  const currentRoomsCount  = currentRows[0]?.count  ?? 0;
  const upcomingRoomsCount = upcomingRows[0]?.count ?? 0;
  return {
    currentRoomsCount,
    upcomingRoomsCount,
    totalRoomsCount: currentRoomsCount + upcomingRoomsCount,
  };
}

router.get("/challenges/available", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const [challenges, futureRoomConflict] = await Promise.all([
    getChallengeCardsForUser(userId),
    getActiveFutureScheduledRoomForUser(db, userId),
  ]);
  return res.json({
    challenges,
    futureRoomCreation: futureRoomConflict
      ? {
          canCreateFutureRoom: false,
          ...futureRoomCreationBlockPayload(futureRoomConflict, userId),
        }
      : {
          canCreateFutureRoom: true,
          code: null,
          title: null,
          message: null,
          scheduled_room: null,
        },
  });
});

// ── GET /api/rooms/counts ─────────────────────────────────────────────────────
// Lightweight endpoint — returns joinable/registerable room counts for the badge.
router.get("/rooms/counts", requireAuth, async (req, res) => {
  return res.json(await getRoomCountsSummary());
});

// ── GET /api/rooms/available ──────────────────────────────────────────────────
// Browse open rooms visible to the current user (all public + all private).
// Private rooms are listed but marked requires_code=true; room_code is never
// returned here. Query params: filter, limit, offset, sort
router.get("/rooms/available", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const { filter = "all", limit = "30", offset = "0", sort = "newest", tab = "current" } = req.query as Record<string, string>;

  // ── Upcoming tab ─────────────────────────────────────────────────────────────
  if (tab === "upcoming") {
    const now = new Date();
    const upcoming = await db
      .select({
        id: raceRoomsTable.id,
        title: raceRoomsTable.title,
        entryType: raceRoomsTable.entryType,
        entryAmountCents: raceRoomsTable.entryAmountCents,
        coinEntryAmount: raceRoomsTable.coinEntryAmount,
        targetSteps: raceRoomsTable.targetSteps,
        maxPlayers: raceRoomsTable.maxPlayers,
        registeredCount: raceRoomsTable.registeredCount,
        isPrivate: raceRoomsTable.isPrivate,
        trackLayout: raceRoomsTable.trackLayout,
        scheduledStartAt: raceRoomsTable.scheduledStartAt,
        challengeDurationDays: raceRoomsTable.challengeDurationDays,
        challengeEndAt: raceRoomsTable.challengeEndAt,
        creatorId: raceRoomsTable.creatorId,
        createdAt: raceRoomsTable.createdAt,
        hostUsername: profilesTable.username,
        hostAvatarColor: profilesTable.avatarColor,
        hostAvatarUrl: profilesTable.avatarUrl,
        hostCountryFlag: profilesTable.countryFlag,
      })
      .from(raceRoomsTable)
      .innerJoin(profilesTable, eq(raceRoomsTable.creatorId, profilesTable.id))
      .where(
        and(
          eq(raceRoomsTable.status, "scheduled"),
          ne(raceRoomsTable.type, "sponsored"),
          sql`${raceRoomsTable.scheduledStartAt} > ${now}`
        )
      )
      .orderBy(asc(raceRoomsTable.scheduledStartAt))
      .limit(50);

    const registrations = upcoming.length > 0
      ? await db
          .select({ raceRoomId: scheduledRoomRegistrationsTable.raceRoomId })
          .from(scheduledRoomRegistrationsTable)
          .where(
            and(
              eq(scheduledRoomRegistrationsTable.userId, userId),
              eq(scheduledRoomRegistrationsTable.status, "registered"),
              inArray(scheduledRoomRegistrationsTable.raceRoomId, upcoming.map((r) => r.id))
            )
          )
      : [];

    const registeredSet = new Set(registrations.map((r) => r.raceRoomId));
    const trackThemeMediaMap = await getTrackThemeMediaMap(upcoming.map((r) => r.trackLayout));

    const TRACK_NAMES2: Record<string, string> = {
      bg: "Neon Finish", bg1: "Arcade Track", bg2: "Night City",
      bg3: "Speed Zone", bg4: "Solar Sprint", bg5: "Ice Run",
    };

    const formatted = upcoming.map((r) => {
      const trackTheme = trackThemeForCode(r.trackLayout, trackThemeMediaMap);
      return {
        room_id: r.id,
        status: "scheduled",
        challenge_type: r.entryType,
        entry_fee: r.entryAmountCents / 100,
        coin_entry_amount: r.coinEntryAmount ?? 0,
        title: r.title,
        target_steps: r.targetSteps,
        max_players: r.maxPlayers,
        registered_count: r.registeredCount,
        scheduled_start_at: r.scheduledStartAt?.toISOString() ?? null,
        challenge_duration_days: r.challengeDurationDays,
        challenge_end_at: r.challengeEndAt?.toISOString() ?? null,
        selected_track_theme_id: r.trackLayout,
        theme_name: TRACK_NAMES2[r.trackLayout] ?? r.trackLayout,
        trackTheme,
        imageSet: trackTheme.imageSet,
        trackThemeImageSet: trackTheme.imageSet,
        is_private: r.isPrivate,
        requires_code: r.isPrivate,
        host_user_id: r.creatorId,
        host_username: r.hostUsername,
        host_avatar_color: r.hostAvatarColor,
        host_avatar_url: r.hostAvatarUrl ?? null,
        host_country_flag: r.hostCountryFlag ?? null,
        current_user_registered: registeredSet.has(r.id),
        eligible_to_register: !registeredSet.has(r.id) && r.registeredCount < r.maxPlayers,
      };
    });

    return res.json({ success: true, rooms: formatted });
  }

  // ── Current tab (default) ─────────────────────────────────────────────────

  const limitNum = Math.min(parseInt(limit, 10) || 30, 50);
  const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

  const filterToEntryTypes: Record<string, ("free" | "paid_1" | "paid_3" | "paid_5" | "coins_battle")[]> = {
    all: ["free", "paid_1", "paid_3", "paid_5", "coins_battle"],
    free: ["free"],
    one_dollar: ["paid_1"],
    three_dollar: ["paid_3"],
    five_dollar: ["paid_5"],
    coins: ["coins_battle"],
  };
  const entryTypes = filterToEntryTypes[filter] ?? filterToEntryTypes.all;

  const orderCol =
    sort === "filling_fast" ? desc(raceRoomsTable.currentPlayers)
    : sort === "prize_pool" ? desc(raceRoomsTable.prizePoolCents)
    : sort === "target_steps" ? asc(raceRoomsTable.targetSteps)
    : desc(raceRoomsTable.createdAt); // default: newest first

  // All open rooms with available slots are discoverable (public + private).
  // Private rooms are shown with requires_code=true; room_code is not returned.
  const baseWhere = and(
    eq(raceRoomsTable.status, "open"),
    sql`${raceRoomsTable.currentPlayers} < ${raceRoomsTable.maxPlayers}`,
  );

  const [rooms, countRows, visibilityCountRows] = await Promise.all([
    db
      .select({
        id: raceRoomsTable.id,
        title: raceRoomsTable.title,
        entryType: raceRoomsTable.entryType,
        entryAmountCents: raceRoomsTable.entryAmountCents,
        targetSteps: raceRoomsTable.targetSteps,
        maxPlayers: raceRoomsTable.maxPlayers,
        currentPlayers: raceRoomsTable.currentPlayers,
        prizePoolCents: raceRoomsTable.prizePoolCents,
        coinEntryAmount: raceRoomsTable.coinEntryAmount,
        trackLayout: raceRoomsTable.trackLayout,
        isPrivate: raceRoomsTable.isPrivate,
        countryCode: raceRoomsTable.countryCode,
        type: raceRoomsTable.type,
        teamACountry: raceRoomsTable.teamACountry,
        teamACountryCode: raceRoomsTable.teamACountryCode,
        teamBCountry: raceRoomsTable.teamBCountry,
        teamBCountryCode: raceRoomsTable.teamBCountryCode,
        creatorId: raceRoomsTable.creatorId,
        createdAt: raceRoomsTable.createdAt,
        hostUsername: profilesTable.username,
        hostAvatarColor: profilesTable.avatarColor,
        hostAvatarUrl: profilesTable.avatarUrl,
        hostCountryFlag: profilesTable.countryFlag,
      })
      .from(raceRoomsTable)
      .innerJoin(profilesTable, eq(raceRoomsTable.creatorId, profilesTable.id))
      .where(and(inArray(raceRoomsTable.entryType, entryTypes), baseWhere))
      .orderBy(orderCol)
      .limit(limitNum)
      .offset(offsetNum),

    db
      .select({
        entryType: raceRoomsTable.entryType,
        count: sql<number>`count(*)::int`,
      })
      .from(raceRoomsTable)
      .where(baseWhere)
      .groupBy(raceRoomsTable.entryType),

    db
      .select({
        isPrivate: raceRoomsTable.isPrivate,
        count: sql<number>`count(*)::int`,
      })
      .from(raceRoomsTable)
      .where(baseWhere)
      .groupBy(raceRoomsTable.isPrivate),
  ]);

  const counts = { total: 0, free: 0, one_dollar: 0, three_dollar: 0, five_dollar: 0 };
  for (const c of countRows) {
    counts.total += c.count;
    if (c.entryType === "free") counts.free = c.count;
    else if (c.entryType === "paid_1") counts.one_dollar = c.count;
    else if (c.entryType === "paid_3") counts.three_dollar = c.count;
    else if (c.entryType === "paid_5") counts.five_dollar = c.count;
  }

  const publicRoomCount = visibilityCountRows.find((r) => !r.isPrivate)?.count ?? 0;
  const privateRoomCount = visibilityCountRows.find((r) => r.isPrivate)?.count ?? 0;

  const TRACK_NAMES: Record<string, string> = {
    bg: "Neon Finish", bg1: "Arcade Track", bg2: "Night City",
    bg3: "Speed Zone", bg4: "Solar Sprint", bg5: "Ice Run",
  };

  function createdAgoLabel(createdAt: Date): string {
    const diffMs = Date.now() - createdAt.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    if (diffSecs < 60) return "Created just now";
    if (diffMins < 2) return "Created 1 min ago";
    if (diffMins < 60) return `Created ${diffMins} mins ago`;
    if (diffHours < 2) return "Created 1 hour ago";
    if (diffHours < 24) return `Created ${diffHours} hours ago`;
    if (diffDays < 2) return "Created 1 day ago";
    return `Created ${createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
  }

  const trackThemeMediaMap = await getTrackThemeMediaMap(rooms.map((r) => r.trackLayout));
  const formatted = rooms.map((r) => {
    const trackTheme = trackThemeForCode(r.trackLayout, trackThemeMediaMap);
    return {
      room_id: r.id,
      status: "waiting",
      challenge_type: r.entryType,
      entry_fee: r.entryAmountCents / 100,
      currency: "USD",
      title: r.title,
      target_steps: targetStepsForRoom(r),
      max_players: r.maxPlayers,
      current_players: r.currentPlayers,
      available_slots: r.maxPlayers - r.currentPlayers,
      reward_pool: r.prizePoolCents / 100,
      coin_entry_amount: r.coinEntryAmount ?? 0,
      reward_label: r.entryType === "coins_battle"
        ? `${(r.coinEntryAmount ?? 0).toLocaleString()} coins`
        : r.entryAmountCents === 0
          ? "Coins & badges"
          : `$${(r.prizePoolCents / 100).toFixed(2)}`,
      host_user_id: r.creatorId,
      host_username: r.hostUsername,
      host_avatar_color: r.hostAvatarColor,
      host_avatar_url: r.hostAvatarUrl ?? null,
      host_country_flag: r.hostCountryFlag ?? null,
      country_code: r.countryCode ?? null,
      country_label: r.countryCode ?? "Any Country",
      race_type: r.type,
      team_a_country: r.teamACountry ?? null,
      team_a_country_code: r.teamACountryCode ?? null,
      team_b_country: r.teamBCountry ?? null,
      team_b_country_code: r.teamBCountryCode ?? null,
      theme_code: r.trackLayout,
      theme_name: TRACK_NAMES[r.trackLayout] ?? r.trackLayout,
      trackTheme,
      imageSet: trackTheme.imageSet,
      trackThemeImageSet: trackTheme.imageSet,
      is_private: r.isPrivate,
      requires_code: r.isPrivate,
      created_at: r.createdAt,
      created_ago_label: createdAgoLabel(r.createdAt),
      joinable: true,
      join_block_reason: null,
    };
  });

  req.log.info({ filter, total: counts.total, publicRoomCount, privateRoomCount, userId }, "[AvailableRooms] fetched");
  return res.json({
    success: true,
    filter,
    counts,
    active_room_count: counts.total,
    public_room_count: publicRoomCount,
    private_room_count: privateRoomCount,
    rooms: formatted,
  });
});

// ── POST /api/rooms/:roomId/register ─────────────────────────────────────────
// Register current user for a future scheduled room.
router.post("/rooms/:roomId/register", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const roomId = String(req.params.roomId);

  req.log.info({ roomId, userId }, "[ScheduleRoom] registerClicked");
  let registeredCount = 0;
  let errorStatus: number | null = null;
  let errorBody: Record<string, unknown> | null = null;

  await db.transaction(async (tx) => {
    await lockRegularRaceRegistrationForUser(tx, userId);

    const room = await lockRaceRoom(tx, roomId);
    if (!room) {
      errorStatus = 404;
      errorBody = { error: "Room not found." };
      return;
    }
    if (room.status !== "scheduled") {
      errorStatus = 409;
      errorBody = { error: "Room is no longer accepting registrations." };
      return;
    }
    if (room.type !== "sponsored") {
      const existingRegularRace = await getRegularRaceRegistrationForUser(tx, userId, roomId);
      if (existingRegularRace) {
        errorStatus = 409;
        errorBody = regularRaceRegistrationConflictBody(existingRegularRace, userId);
        return;
      }
    } else {
      // Enforce: a user may be registered for only one Sponsored Event at a time.
      const existingSponsored = await getActiveSponsoredRegistrationForUser(tx, userId, roomId);
      if (existingSponsored) {
        errorStatus = 409;
        errorBody = sponsoredEventRegistrationConflictBody(existingSponsored, userId);
        return;
      }
    }

    const existing = await lockScheduledRegistration(tx, roomId, userId);
    if (existing && (existing.status === "registered" || existing.status === "active")) {
      errorStatus = 409;
      errorBody = { error: "Already registered." };
      return;
    }
    if ((!existing || existing.status === "cancelled") && room.registeredCount >= room.maxPlayers) {
      errorStatus = 409;
      errorBody = { error: "Room is full." };
      return;
    }

    const registrationResult = await registerOrReviveScheduledRegistration(tx, roomId, userId);
    registeredCount = room.registeredCount + (registrationResult.changed ? 1 : 0);

    if (registrationResult.changed) {
      await tx
        .update(raceRoomsTable)
        .set({ registeredCount, updatedAt: new Date() })
        .where(eq(raceRoomsTable.id, roomId));
    }
  });

  if (errorStatus !== null && errorBody) {
    return res.status(errorStatus).json(errorBody);
  }

  req.log.info({ roomId, userId }, "[ScheduleRoom] registerResponse");

  triggerEvent("public-rooms-available", "room:registered", {
    room_id: roomId,
    registered_count: registeredCount,
  }).catch(() => {});

  return res.json({
    success: true,
    registered: true,
    registered_count: registeredCount,
  });
});

// ── POST /api/rooms/:roomId/cancel-registration ───────────────────────────────
router.post("/rooms/:roomId/cancel-registration", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const roomId = String(req.params.roomId);
  let registeredCount = 0;
  let errorStatus: number | null = null;
  let errorBody: Record<string, string> | null = null;

  await db.transaction(async (tx) => {
    const room = await lockRaceRoom(tx, roomId);
    if (!room) {
      errorStatus = 404;
      errorBody = { error: "Room not found." };
      return;
    }
    if (room.status !== "scheduled") {
      errorStatus = 409;
      errorBody = { error: "Room has already started or been cancelled." };
      return;
    }

    const reg = await lockScheduledRegistration(tx, roomId, userId);
    if (!reg || reg.status !== "registered") {
      errorStatus = 404;
      errorBody = { error: "Registration not found." };
      return;
    }

    registeredCount = Math.max(0, room.registeredCount - 1);
    await tx
      .update(scheduledRoomRegistrationsTable)
      .set({ status: "cancelled", cancelledAt: new Date(), activatedAt: null })
      .where(eq(scheduledRoomRegistrationsTable.id, reg.id));
    await tx
      .update(raceRoomsTable)
      .set({ registeredCount, updatedAt: new Date() })
      .where(eq(raceRoomsTable.id, roomId));
  });

  if (errorStatus !== null && errorBody) {
    return res.status(errorStatus).json(errorBody);
  }

  triggerEvent("public-rooms-available", "room:registration_cancelled", {
    room_id: roomId,
    registered_count: registeredCount,
  }).catch(() => {});

  return res.json({ success: true, registered: false });
});

// ── GET /api/races/my-active ──────────────────────────────────────────────────
// Returns the current user's waiting or active race(s), including Unlimited.
router.get("/races/my-active", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const [rows, unlimitedRows] = await Promise.all([
    db
      .select({
        id: raceRoomsTable.id,
        title: raceRoomsTable.title,
        entryType: raceRoomsTable.entryType,
        entryAmountCents: raceRoomsTable.entryAmountCents,
        targetSteps: raceRoomsTable.targetSteps,
        maxPlayers: raceRoomsTable.maxPlayers,
        currentPlayers: raceRoomsTable.currentPlayers,
        status: raceRoomsTable.status,
        trackLayout: raceRoomsTable.trackLayout,
        creatorId: raceRoomsTable.creatorId,
        startedAt: raceRoomsTable.startedAt,
        createdAt: raceRoomsTable.createdAt,
      })
      .from(raceRoomsTable)
      .innerJoin(
        raceParticipantsTable,
        and(
          eq(raceParticipantsTable.raceRoomId, raceRoomsTable.id),
          eq(raceParticipantsTable.userId, userId),
          and(ne(raceParticipantsTable.status, "left"), ne(raceParticipantsTable.status, "forfeited")),
        ),
      )
      .where(inArray(raceRoomsTable.status, ["open", "in_progress"]))
      .orderBy(desc(raceRoomsTable.createdAt))
      .limit(5),
    db
      .select({
        id: unlimitedChallengesTable.id,
        title: unlimitedChallengesTable.title,
        entryFeeCents: unlimitedChallengesTable.entryFeeCents,
        dailyGoalSteps: unlimitedChallengesTable.dailyGoalSteps,
        status: unlimitedChallengesTable.status,
        hostUserId: unlimitedChallengesTable.hostUserId,
        paidParticipantCount: unlimitedChallengesTable.paidParticipantCount,
        startAtUtc: unlimitedChallengesTable.startAtUtc,
        challengeEndAtUtc: unlimitedChallengesTable.challengeEndAtUtc,
        createdAt: unlimitedChallengesTable.createdAt,
      })
      .from(unlimitedChallengeParticipantsTable)
      .innerJoin(
        unlimitedChallengesTable,
        eq(unlimitedChallengesTable.id, unlimitedChallengeParticipantsTable.challengeId),
      )
      .where(
        and(
          eq(unlimitedChallengeParticipantsTable.userId, userId),
          ne(unlimitedChallengeParticipantsTable.qualificationStatus, "left"),
          inArray(unlimitedChallengesTable.status, ["waiting", "starting", "active", "settling"]),
        ),
      )
      .orderBy(desc(unlimitedChallengesTable.startAtUtc))
      .limit(5),
  ]);

  const mediaMap = await getTrackThemeMediaMap(rows.map((r) => r.trackLayout));
  const classicRaces = rows.map((row) => {
    const trackTheme = trackThemeForCode(row.trackLayout, mediaMap);
    return {
      ...row,
      isHost: row.creatorId === userId,
      entryType: entryTypeLabel(row.entryType),
      entryAmountDollars: row.entryAmountCents / 100,
      trackTheme,
      imageSet: trackTheme.imageSet,
      trackThemeImageSet: trackTheme.imageSet,
      challengeType: undefined as string | undefined,
      capacityMode: undefined as string | undefined,
      currentUserParticipating: true,
    };
  });

  const unlimitedRaces = unlimitedRows.map((r) => ({
    id: r.id,
    title: r.title,
    entryType: "unlimited_goal",
    entryAmountCents: r.entryFeeCents,
    entryAmountDollars: r.entryFeeCents / 100,
    targetSteps: r.dailyGoalSteps,
    maxPlayers: null as number | null,
    currentPlayers: r.paidParticipantCount,
    status:
      r.status === "active" || r.status === "starting" || r.status === "settling"
        ? "in_progress"
        : "open",
    trackLayout: "bg",
    creatorId: r.hostUserId,
    startedAt: r.startAtUtc,
    createdAt: r.createdAt,
    isHost: r.hostUserId === userId,
    challengeType: "unlimited_goal",
    capacityMode: "unlimited",
    challengeEndAt: r.challengeEndAtUtc,
    currentUserParticipating: true,
  }));

  const races = [...unlimitedRaces, ...classicRaces];
  if (races.length === 0) return res.json({ race: null, races: [] });

  return res.json({
    race: races[0],
    races,
  });
});

// ── GET /api/races/my-upcoming ────────────────────────────────────────────────
// Unified "mine" feed for Next Race: scheduled fixed races the viewer is registered
// for + unlimited challenges the viewer is an active participant in. Membership is by
// participation only (never host id alone), so leaving removes the item.
router.get("/races/my-upcoming", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const now = new Date();

  const [fixedRows, unlimitedRows] = await Promise.all([
    db
      .select({
        id: raceRoomsTable.id,
        title: raceRoomsTable.title,
        entryType: raceRoomsTable.entryType,
        entryAmountCents: raceRoomsTable.entryAmountCents,
        targetSteps: raceRoomsTable.targetSteps,
        status: raceRoomsTable.status,
        creatorId: raceRoomsTable.creatorId,
        scheduledStartAt: raceRoomsTable.scheduledStartAt,
        challengeEndAt: raceRoomsTable.challengeEndAt,
      })
      .from(scheduledRoomRegistrationsTable)
      .innerJoin(raceRoomsTable, eq(raceRoomsTable.id, scheduledRoomRegistrationsTable.raceRoomId))
      .where(
        and(
          eq(scheduledRoomRegistrationsTable.userId, userId),
          eq(scheduledRoomRegistrationsTable.status, "registered"),
          eq(raceRoomsTable.status, "scheduled"),
          sql`${raceRoomsTable.scheduledStartAt} > ${now}`,
        ),
      ),
    db
      .select({
        id: unlimitedChallengesTable.id,
        title: unlimitedChallengesTable.title,
        entryFeeCents: unlimitedChallengesTable.entryFeeCents,
        dailyGoalSteps: unlimitedChallengesTable.dailyGoalSteps,
        status: unlimitedChallengesTable.status,
        hostUserId: unlimitedChallengesTable.hostUserId,
        startAtUtc: unlimitedChallengesTable.startAtUtc,
        challengeEndAtUtc: unlimitedChallengesTable.challengeEndAtUtc,
        participationStatus: unlimitedChallengeParticipantsTable.qualificationStatus,
      })
      .from(unlimitedChallengeParticipantsTable)
      .innerJoin(unlimitedChallengesTable, eq(unlimitedChallengesTable.id, unlimitedChallengeParticipantsTable.challengeId))
      .where(
        and(
          eq(unlimitedChallengeParticipantsTable.userId, userId),
          ne(unlimitedChallengeParticipantsTable.qualificationStatus, "left"),
          inArray(unlimitedChallengesTable.status, ["waiting", "starting", "active", "settling"]),
        ),
      ),
  ]);

  const items = [
    ...fixedRows.map((r) => ({
      sortMs: r.scheduledStartAt?.getTime() ?? 0,
      item: {
        kind: "fixed" as const,
        id: r.id,
        title: r.title,
        challengeType: r.entryType,
        entryType: r.entryType,
        entryFeeCents: r.entryAmountCents,
        targetSteps: r.targetSteps,
        scheduledStartAt: r.scheduledStartAt?.toISOString() ?? null,
        challengeEndAt: r.challengeEndAt?.toISOString() ?? null,
        status: r.status,
        isHost: r.creatorId === userId,
        currentUserRegistered: true,
        participationStatus: "active",
      },
    })),
    ...unlimitedRows.map((r) => ({
      sortMs: r.startAtUtc?.getTime() ?? 0,
      item: {
        kind: "unlimited" as const,
        id: r.id,
        title: r.title,
        challengeType: "unlimited_goal",
        entryType: "unlimited_goal",
        entryFeeCents: r.entryFeeCents,
        targetSteps: r.dailyGoalSteps,
        scheduledStartAt: r.startAtUtc?.toISOString() ?? null,
        challengeEndAt: r.challengeEndAtUtc?.toISOString() ?? null,
        status: r.status,
        isHost: r.hostUserId === userId,
        currentUserRegistered: true,
        participationStatus: r.participationStatus,
      },
    })),
  ]
    .sort((a, b) => a.sortMs - b.sortMs)
    .map((x) => x.item);

  return res.json({ items, count: items.length });
});

// ── POST /api/races/host ──────────────────────────────────────────────────────
// Creates a new race room and joins the creator as host participant.
const VALID_TRACK_LAYOUTS = TRACK_THEME_CODES;
const hostRaceSchema = z.object({
  entryType: z.enum(["free", "paid_1", "paid_3", "paid_5", "paid_usd", "coins_battle"]),
  maxPlayers: z.number().int().min(2).max(10),
  targetSteps: z.number().int().min(50).max(1000000).optional().default(1000),
  trackLayout: z.enum(VALID_TRACK_LAYOUTS).optional().default("bg"),
  isPrivate: z.boolean().optional().default(false),
  coinEntryAmount: z.number().int().min(0).optional().default(0),
  /** For paid_usd: entry amount in cents (min $1 = 100, max $100 = 10000). */
  customEntryAmountCents: z.number().int().min(0).max(10000).optional().default(0),
  goalType: z.enum(["daily", "weekly", "monthly"]).optional().default("daily"),
  countryCode: z.string().optional(),
  isCountryVs: z.boolean().optional().default(false),
  teamACountry: z.string().max(100).optional(),
  teamACountryCode: z.string().max(10).optional(),
  teamBCountry: z.string().max(100).optional(),
  teamBCountryCode: z.string().max(10).optional(),
  scheduledStartAtIso: z.string().optional(),
  challengeEndAtIso: z.string().optional(),
  challengeDurationDays: z.number().int().min(0).max(30).optional().default(0),
  timezone: z.string().max(100).optional(),
});

// ── GET /api/races/cash-challenge/payment-quote ───────────────────────────────
router.get("/races/cash-challenge/payment-quote", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const entryFeeCents = Number(req.query.entryFeeCents ?? req.query.entryFee ?? 0);
  const numberOfPlayers = Math.max(2, Math.min(10, Number(req.query.numberOfPlayers ?? req.query.playerCount ?? 2)));
  const countryCode = typeof req.query.countryCode === "string" ? req.query.countryCode : undefined;

  if (!isAllowedEntryAmountCents(entryFeeCents)) {
    return res.status(400).json({
      error: "Invalid entry amount. Allowed: $3, $5, $10, $15, $20, $25.",
    });
  }

  const [profileForQuote] = await db
    .select({ countryCode: profilesTable.countryCode })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);
  const effectiveCountryCode = profileForQuote?.countryCode ?? countryCode;
  if (isCashChallengeUnsupportedForCountry(effectiveCountryCode)) {
    req.log.info(
      { userId, countryCode: effectiveCountryCode },
      "[CashChallenge] INR/Razorpay quote blocked until multi-currency support ships",
    );
    return res.status(403).json(cashChallengeUnsupportedForCurrencyBody());
  }

  const [wallet] = await db
    .select({ availableBalanceCents: walletsTable.availableBalanceCents })
    .from(walletsTable)
    .where(eq(walletsTable.userId, userId))
    .limit(1);

  const provider = resolvePaymentProvider(effectiveCountryCode);
  const quote = buildCashChallengeQuote({
    entryFeeCents,
    numberOfPlayers,
    paymentProvider: provider,
  });

  return res.json(formatQuoteForApi(quote, wallet?.availableBalanceCents ?? 0));
});

router.post("/races/host", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = hostRaceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }

  const { entryType, maxPlayers, targetSteps, trackLayout, isPrivate, coinEntryAmount, customEntryAmountCents, goalType, countryCode, isCountryVs, teamACountry, teamACountryCode, teamBCountry, teamBCountryCode, scheduledStartAtIso, challengeEndAtIso, challengeDurationDays } = parsed.data;

  if (!ENABLE_CASH_CHALLENGES && ["paid_1", "paid_3", "paid_5", "paid_usd"].includes(entryType)) {
    return res.status(403).json({ error: "Cash challenges are disabled for this build." });
  }
  if (!ENABLE_COIN_ENTRY_CHALLENGES && entryType === "coins_battle") {
    return res.status(403).json({ error: "Coin-entry challenges are disabled for this build." });
  }

  // For paid_usd, validate and resolve the custom entry amount
  let amountCents = entryAmountCents(entryType);
  if (entryType === "paid_usd") {
    if (!customEntryAmountCents || !PAID_CHALLENGE_ALLOWED_AMOUNTS_CENTS.has(customEntryAmountCents)) {
      return res.status(400).json({ error: "Paid challenge entry amount must be one of: $3, $5, $10, $15, $20, $25." });
    }
    amountCents = customEntryAmountCents;
  }

  // Validate challenge duration (must be 1, 7, or 30 days if provided)
  if (challengeDurationDays > 0 && !VALID_DURATION_DAYS.has(challengeDurationDays)) {
    return res.status(400).json({ error: "Invalid challenge duration. Must be 1, 7, or 30 days." });
  }

  // Validate target steps are valid for the selected goal type.
  // Only enforced for scheduled duration challenges (challengeDurationDays > 0),
  // where the goal type is meaningful. Instant races accept any step target.
  if (goalType && targetSteps && challengeDurationDays > 0) {
    const validSteps = VALID_TARGET_STEPS_BY_GOAL[goalType];
    if (validSteps && !validSteps.has(targetSteps)) {
      return res.status(400).json({ error: "Target steps are not valid for this challenge duration." });
    }
  }

  // Parse scheduling info
  let scheduledStartAt: Date | null = null;
  let isScheduledFuture = false;
  if (scheduledStartAtIso) {
    const parsed2 = new Date(scheduledStartAtIso);
    if (!isNaN(parsed2.getTime()) && parsed2.getTime() > Date.now() + 30_000) {
      scheduledStartAt = parsed2;
      isScheduledFuture = true;
    }
  }

  // Validate host owns the selected track theme (default themes always pass)
  const ownsLayout = await validateThemeOwnership(userId, trackLayout);
  if (!ownsLayout) {
    return res.status(403).json({ error: "You must unlock this track before hosting a challenge with it." });
  }

  if (isScheduledFuture) {
    const existingScheduledRoom = await getActiveFutureScheduledRoomForUser(db, userId);
    if (existingScheduledRoom) {
      return res.status(409).json(futureRoomCreationConflictBody(existingScheduledRoom, userId));
    }
  }

  // Enforce: user may only be registered for one regular race at a time.
  const existingRegularRace = await getRegularRaceRegistrationForUser(db, userId);
  if (existingRegularRace) {
    return res.status(409).json(regularRaceRegistrationConflictBody(existingRegularRace, userId));
  }
  {
    // One-blocking-challenge also spans Unlimited Challenges (no-op when the feature flag is off).
    const unlimitedBlock = await getUnlimitedBlockingMembership(db, userId);
    if (unlimitedBlock) return res.status(409).json({ error: "You already have an active challenge.", code: "one_challenge_at_a_time", blocking: unlimitedBlock });
  }
  // One-blocking-challenge also spans Unlimited Challenges.
  const unlimitedBlock = await getUnlimitedBlockingMembership(db, userId);
  if (unlimitedBlock) {
    return res.status(409).json({ error: "You already have an active challenge.", code: "one_challenge_at_a_time", blocking: unlimitedBlock });
  }

  // For paid races validate eligibility
  if (amountCents > 0) {
    const [profile] = await db
      .select()
      .from(profilesTable)
      .where(eq(profilesTable.id, userId))
      .limit(1);
    if (!profile) return res.status(403).json({ error: "Paid challenges are not available for your account." });
    if (!computeIsAdult(profile.dateOfBirth, profile.isAdult)) return res.status(403).json({ error: "You must be 18 or older to join paid challenges." });
    if (!profile.paidRaceEnabled) return res.status(403).json({ error: "Paid challenges are not available for your account." });
    if (profile.accountStatus !== "active") return res.status(403).json({ error: "Your account is under review." });
    if (isCashChallengeUnsupportedForCountry(profile.countryCode)) {
      req.log.info(
        { userId, countryCode: profile.countryCode },
        "[CashChallenge] INR/Razorpay host blocked until multi-currency support ships",
      );
      return res.status(403).json(cashChallengeUnsupportedForCurrencyBody());
    }
  }

  const titleMap: Record<string, string> = {
    free: "Free Challenge",
    paid_1: "$1 Challenge",
    paid_3: "$3 Challenge",
    paid_5: "$5 Champion Race",
    paid_usd: `$${amountCents / 100} USD Challenge`,
    coins_battle: "Coins Battle",
  };

  // CSPRNG code with rejection sampling (no modulo bias) and ≥64 bits of
  // entropy so private/cash rooms cannot be enumerated by brute force.
  const inviteCode = isPrivate ? generateInviteCode() : null;

  const durationDays = challengeDurationDays ?? 0;
  let challengeEndAt: Date | null = null;
  if (scheduledStartAt && durationDays > 0) {
    // Server always computes the canonical end datetime to prevent manipulation
    challengeEndAt = new Date(scheduledStartAt.getTime() + durationDays * 24 * 60 * 60 * 1000);
    // Validate the client-supplied value (if any) matches within a 60-second tolerance
    if (challengeEndAtIso) {
      const clientEnd = new Date(challengeEndAtIso);
      if (!isNaN(clientEnd.getTime())) {
        const diffMs = Math.abs(clientEnd.getTime() - challengeEndAt.getTime());
        if (diffMs > 60_000) {
          return res.status(400).json({
            error: "End date and time must match the selected challenge duration.",
          });
        }
      }
    }
  } else if (challengeEndAtIso) {
    // No scheduled start — accept the client value only if it's in the future
    const parsed3 = new Date(challengeEndAtIso);
    if (!isNaN(parsed3.getTime()) && parsed3.getTime() > Date.now()) {
      challengeEndAt = parsed3;
    }
  }

  req.log.info(
    { scheduledStartAtIso, isScheduledFuture, durationDays },
    "[ScheduleRoom] createPayload"
  );

  let scheduledCreateConflict: FutureScheduledRoomRow | null = null;
  let createConflict: RegularRaceRegistrationRow | null = null;
  const result = await db.transaction(async (tx) => {
    await lockRegularRaceRegistrationForUser(tx, userId);
    if (isScheduledFuture) {
      scheduledCreateConflict = await getActiveFutureScheduledRoomForUser(tx, userId);
      if (scheduledCreateConflict) return null;
    }
    createConflict = await getRegularRaceRegistrationForUser(tx, userId);
    if (createConflict) return null;

    const roomTitle = isCountryVs && teamACountry && teamBCountry
      ? `${teamACountry} vs ${teamBCountry}`
      : (titleMap[entryType] ?? "Walk Challenge");
    const roomType = isCountryVs ? "country_battle" : isPrivate ? "friends" : "quick";

    const [room] = await tx
      .insert(raceRoomsTable)
      .values({
        creatorId: userId,
        title: roomTitle,
        type: roomType,
        entryType,
        entryAmountCents: amountCents,
        goalType: goalType ?? "daily",
        ...(entryType === "coins_battle" && coinEntryAmount > 0 ? { coinEntryAmount } : {}),
        targetSteps,
        maxPlayers,
        trackLayout,
        currentPlayers: isScheduledFuture ? 0 : 1,
        isPrivate,
        status: isScheduledFuture ? "scheduled" : "open",
        scheduleType: isScheduledFuture ? "future" : "now",
        // Shared Waiting Room lifecycle: scheduled rooms auto-start at scheduledStartAt; open-window
        // rooms stay open exactly 30 min (roomExpiresAt) unless the host starts sooner.
        mode: isScheduledFuture ? "scheduled" : "open_window",
        minimumParticipants: config.waitingRoom.minimumParticipants,
        ...(isScheduledFuture ? {} : { roomExpiresAt: new Date(Date.now() + config.waitingRoom.openWindowMs) }),
        ...(scheduledStartAt ? { scheduledStartAt } : {}),
        ...(challengeEndAt ? { challengeEndAt } : {}),
        ...(durationDays > 0 ? { challengeDurationDays: durationDays } : {}),
        ...(isScheduledFuture ? { registeredCount: 1 } : {}),
        ...(inviteCode ? { inviteCode } : {}),
        ...(countryCode ? { countryCode } : {}),
        ...(isCountryVs ? { teamACountry, teamACountryCode, teamBCountry, teamBCountryCode } : {}),
      })
      .returning();

    let participant = null;
    if (!isScheduledFuture) {
      [participant] = await tx
        .insert(raceParticipantsTable)
        .values({ raceRoomId: room.id, userId, status: "joined" })
        .returning();
    } else {
      // Auto-register host in scheduled_room_registrations
      await tx
        .insert(scheduledRoomRegistrationsTable)
        .values({ raceRoomId: room.id, userId, status: "registered" });
    }

    return { room, participant };
  });

  if (scheduledCreateConflict) {
    return res.status(409).json(futureRoomCreationConflictBody(scheduledCreateConflict, userId));
  }
  if (createConflict) {
    return res.status(409).json(regularRaceRegistrationConflictBody(createConflict, userId));
  }
  if (!result) {
    return res.status(409).json({ error: "Unable to create race." });
  }

  req.log.info({ raceId: result.room.id, userId, entryType, isPrivate, isScheduledFuture }, "[ScheduleRoom] createResponse");
  // Enqueue the durable lifecycle job (scheduled auto-start OR 30-min open-window expiry).
  void enqueueWaitingRoomLifecycleJobs(result.room);
  if (!isPrivate) {
    if (isScheduledFuture) {
      triggerEvent("public-rooms-available", "room:scheduled", {
        room_id: result.room.id,
        scheduled_start_at: scheduledStartAt?.toISOString(),
      }).catch(() => {});
    } else {
      triggerEvent("public-rooms-available", "room:created", {
        room_id: result.room.id,
        entry_type: result.room.entryType,
        current_players: result.room.currentPlayers,
        max_players: result.room.maxPlayers,
      }).catch(() => {});
    }
  }
  // Instant paid cash challenge: charge host total payable on confirm (entry + fees).
  if (amountCents > 0 && !isScheduledFuture && result.participant) {
    const [profile] = await db
      .select({ countryCode: profilesTable.countryCode })
      .from(profilesTable)
      .where(eq(profilesTable.id, userId))
      .limit(1);
    const provider = resolvePaymentProvider(profile?.countryCode);
    const charge = await db.transaction(async (tx) => {
      const debit = await debitCashChallengeEntry(tx, {
        userId,
        raceRoomId: result.room.id,
        entryFeeCents: amountCents,
        paymentProvider: provider,
        description: `Cash challenge host entry: ${result.room.title}`,
      });
      if (debit.ok) {
        await grantReferralBonusForCashChallenge(tx, {
          referredUserId: userId,
          raceRoomId: result.room.id,
        });
      }
      return debit;
    });
    if (!charge.ok) {
      await db
        .update(raceRoomsTable)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(raceRoomsTable.id, result.room.id));
      const fees = calcPerPlayerFees(amountCents, provider);
      return res.status(402).json({
        error: charge.error,
        totalPayable: fees.totalPayableCents / 100,
        totalPayableCents: fees.totalPayableCents,
        walletBalance: charge.balanceCents / 100,
        canAfford: false,
      });
    }
  }

  try {
    await setUserDefaultTrackTheme(userId, trackLayout);
  } catch (err) {
    req.log.warn({ err, userId, trackLayout }, "failed to save last used track theme");
  }

  const paymentQuote =
    amountCents > 0
      ? formatQuoteForApi(
          buildCashChallengeQuote({
            entryFeeCents: amountCents,
            numberOfPlayers: maxPlayers,
          }),
        )
      : null;

  return res.status(201).json({
    raceId: result.room.id,
    race: result.room,
    participant: result.participant,
    isScheduled: isScheduledFuture,
    scheduledStartAt: scheduledStartAt?.toISOString() ?? null,
    ...(inviteCode ? { inviteCode } : {}),
    ...(paymentQuote ? { paymentQuote } : {}),
  });
});

// ── POST /api/races/:id/start ─────────────────────────────────────────────────
// Host starts the race. Requires >= 2 joined participants.
// Result of an activation attempt. Non-HTTP so both the host endpoint and the scheduler can use it.
export type ActivateRoomResult =
  | { ok: true; room: typeof raceRoomsTable.$inferSelect }
  | { ok: false; httpStatus: number; body: Record<string, unknown> };

/**
 * Shared "charge entries + start the race" transition, used by BOTH the host manual-start
 * endpoint (open_window rooms) and the scheduler's scheduled auto-start. Atomicity vs
 * expire/cancel is via a compare-and-set claim into the transient `starting` status: while a
 * room is `starting`, terminate paths (which only act on open/full/scheduled) no-op, so a
 * host-start and a 30-minute expiry can never both win. On any charge failure the claim is
 * reverted so the room is startable again (and the reconciler recovers stuck `starting` rooms).
 *
 * @param opts.fromStatuses statuses eligible to be claimed (["open","full"] for manual start,
 *        ["scheduled"] for scheduled auto-start).
 * @param opts.materializeRegistrations convert scheduled_room_registrations → joined participants
 *        before charging (scheduled rooms only).
 */
export async function activateRoomAndStart(
  raceId: string,
  opts: { fromStatuses: Array<"open" | "full" | "scheduled">; materializeRegistrations?: boolean } = { fromStatuses: ["open", "full"] },
): Promise<ActivateRoomResult> {
  // ── Materialize scheduled registrations into joined participants (scheduled only) ──
  if (opts.materializeRegistrations) {
    await db.transaction(async (tx) => {
      const lockedRoom = await lockRaceRoom(tx, raceId);
      if (!lockedRoom || lockedRoom.status !== "scheduled") return;
      const regs = await tx
        .select({ userId: scheduledRoomRegistrationsTable.userId })
        .from(scheduledRoomRegistrationsTable)
        .where(and(
          eq(scheduledRoomRegistrationsTable.raceRoomId, raceId),
          eq(scheduledRoomRegistrationsTable.status, "registered"),
        ));
      let activated = 0;
      for (const reg of regs) {
        const r = await joinOrReviveParticipant(tx, { raceRoomId: raceId, userId: reg.userId, currentSteps: 0, raceBaselineSteps: 0 });
        if (r.changed) activated += 1;
      }
      await tx
        .update(scheduledRoomRegistrationsTable)
        .set({ status: "activated", activatedAt: new Date() })
        .where(and(
          eq(scheduledRoomRegistrationsTable.raceRoomId, raceId),
          eq(scheduledRoomRegistrationsTable.status, "registered"),
        ));
      if (activated > 0) {
        await tx.update(raceRoomsTable).set({ currentPlayers: activated, updatedAt: new Date() }).where(eq(raceRoomsTable.id, raceId));
      }
    });
  }

  // ── Compare-and-set claim: <fromStatuses> → "starting" (only one caller wins) ──
  const [claimed] = await db
    .update(raceRoomsTable)
    .set({ status: "starting", updatedAt: new Date() })
    .where(and(eq(raceRoomsTable.id, raceId), inArray(raceRoomsTable.status, opts.fromStatuses)))
    .returning();
  if (!claimed) {
    return { ok: false, httpStatus: 409, body: { error: "Race cannot be started in its current state." } };
  }
  const room = claimed;

  // Revert the claim back to a startable status if charging fails, so the room isn't stuck.
  const revertClaim = async () => {
    await db
      .update(raceRoomsTable)
      .set({ status: opts.fromStatuses.includes("scheduled") ? "scheduled" : deriveOpenRoomStatus(room.currentPlayers, room.maxPlayers), updatedAt: new Date() })
      .where(and(eq(raceRoomsTable.id, raceId), eq(raceRoomsTable.status, "starting")));
  };

  // Charge any joined participants who have not yet paid (legacy / scheduled flows).
  if (room.entryAmountCents > 0) {
    const participants = await db
      .select({ userId: raceParticipantsTable.userId })
      .from(raceParticipantsTable)
      .where(
        and(
          eq(raceParticipantsTable.raceRoomId, raceId),
          eq(raceParticipantsTable.status, "joined"),
        ),
      );

    if (participants.length > 0) {
      const participantProfiles = await db
        .select({ userId: profilesTable.id, countryCode: profilesTable.countryCode })
        .from(profilesTable)
        .where(inArray(profilesTable.id, participants.map((p) => p.userId)));
      const unsupportedParticipant = participantProfiles.find((profile) =>
        isCashChallengeUnsupportedForCountry(profile.countryCode)
      );
      if (unsupportedParticipant) {
        logger.warn(
          { raceId, userId: unsupportedParticipant.userId, countryCode: unsupportedParticipant.countryCode },
          "[CashChallenge] INR/Razorpay race start participant debit blocked until multi-currency support ships",
        );
        await revertClaim();
        return { ok: false, httpStatus: 403, body: cashChallengeUnsupportedForCurrencyBody() };
      }

      const [hostProfile] = await db
        .select({ countryCode: profilesTable.countryCode })
        .from(profilesTable)
        .where(eq(profilesTable.id, room.creatorId))
        .limit(1);
      if (isCashChallengeUnsupportedForCountry(hostProfile?.countryCode)) {
        logger.warn(
          { raceId, hostUserId: room.creatorId, countryCode: hostProfile?.countryCode },
          "[CashChallenge] INR/Razorpay race start debit blocked until multi-currency support ships",
        );
        await revertClaim();
        return { ok: false, httpStatus: 403, body: cashChallengeUnsupportedForCurrencyBody() };
      }
      const provider = resolvePaymentProvider(hostProfile?.countryCode);

      try {
        await db.transaction(async (tx) => {
          for (const p of participants) {
            const paid = await hasCompletedEntryPayment(tx, p.userId, raceId);
            if (paid) continue;
            const result = await debitCashChallengeEntry(tx, {
              userId: p.userId,
              raceRoomId: raceId,
              entryFeeCents: room.entryAmountCents,
              paymentProvider: provider,
              description: `Entry fee for race: ${room.title}`,
            });
            if (!result.ok) {
              throw new Error(result.error);
            }
            await grantReferralBonusForCashChallenge(tx, {
              referredUserId: p.userId,
              raceRoomId: raceId,
            });
          }
        });
      } catch (err) {
        logger.error({ raceId, err }, "activateRoomAndStart: cash entry charge failed — reverting claim");
        await revertClaim();
        return { ok: false, httpStatus: 402, body: { error: "Entry fee could not be charged.", code: "entry_charge_failed" } };
      }

      logger.info(
        { raceId, participantCount: participants.length, amountCents: room.entryAmountCents },
        "entry fees charged at race start (unpaid participants only)",
      );
    }
  }

  // ── Charge Coins Battle entry fees ───────────────────────────────────────
  if (room.entryType === "coins_battle" && room.coinEntryAmount > 0) {
    const coinParticipants = await db
      .select({ userId: raceParticipantsTable.userId })
      .from(raceParticipantsTable)
      .where(and(eq(raceParticipantsTable.raceRoomId, raceId), eq(raceParticipantsTable.status, "joined")));

    if (coinParticipants.length > 0) {
      let totalCollected = 0;
      // Capture new balances per-user so we can send Pusher updates after the TX
      const newBalanceMap = new Map<string, number>();
      // Participants who could not pay the FULL entry are disqualified rather than
      // admitted for free. Previously we charged min(balance, entry) and kept the
      // participant in the race even when that was 0, letting them compete for a
      // pool funded entirely by other players' full entries.
      const disqualifiedUserIds: string[] = [];
      try {
      await db.transaction(async (tx) => {
        for (const p of coinParticipants) {
          const [bal] = await tx
            .select({ currentBalance: coinBalancesTable.currentBalance })
            .from(coinBalancesTable)
            .where(eq(coinBalancesTable.userId, p.userId))
            .limit(1)
            .for("update");
          const balance = bal?.currentBalance ?? 0;
          if (balance < room.coinEntryAmount) {
            // Cannot afford the full entry — disqualify and exclude from the pool.
            await tx
              .update(raceParticipantsTable)
              .set({ status: "disqualified" })
              .where(and(eq(raceParticipantsTable.raceRoomId, raceId), eq(raceParticipantsTable.userId, p.userId)));
            disqualifiedUserIds.push(p.userId);
            continue;
          }
          const toDeduct = room.coinEntryAmount;
          const ledger = await recordCoinLedgerEntry(tx, {
            userId: p.userId,
            amount: -toDeduct,
            transactionType: "spend",
            source: "coins_battle_entry",
            sourceId: raceId,
            rewardCode: null,
            reasonCode: "coins_battle_entry",
            idempotencyKey: `coins-battle-entry:${p.userId}:${raceId}`,
            description: `Coins Battle entry: ${toDeduct} coins`,
            metadata: { raceId, entryAmount: toDeduct },
          });
          newBalanceMap.set(p.userId, ledger.newBalance);
          totalCollected += toDeduct;
        }
        if (disqualifiedUserIds.length > 0) {
          await tx
            .update(raceRoomsTable)
            .set({
              currentPlayers: sql`greatest(${raceRoomsTable.currentPlayers} - ${disqualifiedUserIds.length}, 0)`,
              updatedAt: new Date(),
            })
            .where(eq(raceRoomsTable.id, raceId));
        }
        if (totalCollected > 0) {
          await tx
            .update(raceRoomsTable)
            .set({ coinPrizePool: totalCollected, updatedAt: new Date() })
            .where(eq(raceRoomsTable.id, raceId));
        }
      });
      } catch (err) {
        logger.error({ raceId, err }, "activateRoomAndStart: coins_battle entry charge failed — reverting claim");
        await revertClaim();
        return { ok: false, httpStatus: 402, body: { error: "Coins Battle entry could not be charged.", code: "entry_charge_failed" } };
      }
      for (const uid of disqualifiedUserIds) {
        void triggerEvent(`private-user-${uid}`, "race:disqualified", {
          raceId,
          reason: "insufficient_coins",
        }).catch(() => {});
      }
      if (disqualifiedUserIds.length > 0) {
        logger.info(
          { raceId, disqualifiedCount: disqualifiedUserIds.length },
          "[CoinsBattle] participants disqualified for insufficient coins at start",
        );
      }
      // Notify each participant of their new balance (fire-and-forget)
      for (const [uid, newBalance] of newBalanceMap.entries()) {
        void triggerEvent(`private-user-${uid}`, "wallet.updated", {
          type: "coins_spent",
          reason: "coins_battle_entry",
          coins: room.coinEntryAmount,
          changeAmount: -room.coinEntryAmount,
          coinBalance: newBalance,
          description: `Coins Battle entry: ${room.coinEntryAmount} coins`,
        }).catch(() => {});
      }
      logger.info({ raceId, participantCount: coinParticipants.length, totalCollected }, "[CoinsBattle] entry coins charged at race start");
    }
  }

  const startedAt = new Date();
  // Sponsored: 3h. Multi-day rooms: calendar challengeEndAt. Classic fixed free/coins/cash
  // (durationDays 0 or legacy daily=1): startedAt + 24h unless winners finish sooner.
  const challengeEndAt =
    room.type === "sponsored"
      ? new Date(startedAt.getTime() + 3 * 60 * 60_000)
      : isDurationChallengeRoom(room)
        ? deriveChallengeEndAt({ ...room, startedAt })
        : new Date(startedAt.getTime() + FIXED_RACE_MAX_DURATION_MS);

  // ── Freeze winner slots at race start (never recalculated afterwards) ─────────
  // Count distinct valid participants NOW (after any pre-start coins_battle disqualification).
  // startingParticipantCount + winnerSlotCount are written once here and drive the new
  // completion-gated settlement path; races started before this shipped keep them null (legacy).
  const [{ startingParticipantCount }] = await db
    .select({ startingParticipantCount: sql<number>`count(distinct ${raceParticipantsTable.userId})::int` })
    .from(raceParticipantsTable)
    .where(and(
      eq(raceParticipantsTable.raceRoomId, raceId),
      ne(raceParticipantsTable.status, "left"),
      ne(raceParticipantsTable.status, "disqualified"),
      ne(raceParticipantsTable.status, "forfeited"),
    ));
  const winnerSlotCount = getWinnerSlotCount(startingParticipantCount ?? 0);

  // Compare-and-set: only the caller holding the "starting" claim commits the activation.
  const [updated] = await db
    .update(raceRoomsTable)
    .set({
      status: "in_progress",
      startedAt,
      ...(challengeEndAt ? { challengeEndAt } : {}),
      liveStateMode: resolveLiveStateModeForNewRace(),
      startingParticipantCount: startingParticipantCount ?? 0,
      winnerSlotCount,
      updatedAt: startedAt,
    })
    .where(and(eq(raceRoomsTable.id, raceId), eq(raceRoomsTable.status, "starting")))
    .returning();
  if (!updated) {
    return { ok: false, httpStatus: 409, body: { error: "Race cannot be started in its current state." } };
  }

  logger.info(
    { raceId, startingParticipantCount, winnerSlotCount },
    "[RaceStart] winner slots frozen: startingParticipantCount=%d winnerSlotCount=%d",
    startingParticipantCount, winnerSlotCount,
  );

  // Register the live race so the safety-net cleanup considers it (opens the idle gate).
  // Fixed free/coins/cash: 24h from start. Duration challenges: challengeEndAt.
  void markRaceActive(
    raceId,
    challengeEndAt?.getTime() ?? startedAt.getTime() + FIXED_RACE_MAX_DURATION_MS,
  );
  // Seed redis-live if this race started in redis mode (no-op otherwise).
  void initializeRaceLiveState(raceId);

  // Fire race:starting immediately so all clients can show the countdown overlay
  await triggerEvent(`public-live-race-${raceId}`, "race:starting", {
    raceId,
    countdownSeconds: 3,
  });

  // Fire race:started after the countdown window so all clients navigate in sync
  setTimeout(() => {
    triggerEvent(`public-live-race-${raceId}`, "race:started", { raceId }).catch(() => {});
    triggerEvent("public-presence", "race:started", { raceId }).catch(() => {});
    triggerEvent("public-rooms-available", "room:started", { room_id: raceId }).catch(() => {});
  }, 3500);

  // Exactly-once "Your race has started" notification to participants (gated by the CAS above).
  void (async () => {
    const parts = await db
      .select({ userId: raceParticipantsTable.userId })
      .from(raceParticipantsTable)
      .where(and(
        eq(raceParticipantsTable.raceRoomId, raceId),
        ne(raceParticipantsTable.status, "left"),
        ne(raceParticipantsTable.status, "disqualified"),
      ));
    const userIds = [...new Set(parts.map((p) => p.userId))];
    for (const uid of userIds) {
      sendNotification(uid, "race_started", "Your race has started", "Your race has started — start walking!", {
        raceId,
        dedupeKey: `race_started:${raceId}`,
      }).catch(() => {});
    }
  })().catch(() => {});

  logger.info({ raceId }, "race activated");
  return { ok: true, room: updated };
}

router.post("/races/:id/start", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const raceId = String(req.params.id);

  const [room] = await db
    .select()
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.id, raceId))
    .limit(1);

  if (!room) return res.status(404).json({ error: "Race not found" });
  if (room.creatorId !== userId) return res.status(403).json({ error: "Only the host can start the race." });
  if (room.status !== "open" && room.status !== "full") {
    return res.status(409).json({ error: "Race cannot be started in its current state." });
  }
  // Scheduled rooms start automatically at their scheduled time — the host cannot start them.
  if (room.mode === "scheduled") {
    return res.status(409).json({ error: "Scheduled races start automatically at their scheduled time.", code: "scheduled_auto_start" });
  }
  const minParticipants = room.minimumParticipants ?? config.waitingRoom.minimumParticipants;
  if (room.currentPlayers < minParticipants) {
    return res.status(409).json({ error: `Need at least ${minParticipants} players to start.`, code: "insufficient_players" });
  }
  // Open-window rooms cannot be started after their 30-minute window closes.
  if (room.roomExpiresAt && Date.now() >= room.roomExpiresAt.getTime()) {
    return res.status(409).json({ error: "This Waiting Room has expired.", code: "room_expired" });
  }

  const result = await activateRoomAndStart(raceId, { fromStatuses: ["open", "full"] });
  if (!result.ok) return res.status(result.httpStatus).json(result.body);
  req.log.info({ raceId, userId }, "race started by host");
  return res.json({ race: result.room });
});

// ── POST /api/races/:id/cancel ────────────────────────────────────────────────
// Host cancels a waiting room before it starts.
router.post("/races/:id/cancel", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const raceId = String(req.params.id);

  const [room] = await db
    .select()
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.id, raceId))
    .limit(1);

  if (!room) return res.status(404).json({ error: "Race not found" });
  if (room.creatorId !== userId) return res.status(403).json({ error: "Only the host can cancel the room." });
  // A successfully-created paid (USD cash-entry) challenge can NEVER be cancelled by a normal user —
  // the host must LEAVE instead (pre-start leave still refunds). Free/coins rooms keep cancel.
  if (room.entryAmountCents > 0) {
    return res.status(409).json({
      code: "PAID_CHALLENGE_CANNOT_BE_CANCELLED",
      error: "Cash challenges cannot be cancelled after creation.",
    });
  }
  if (room.status !== "open" && room.status !== "full" && room.status !== "scheduled") return res.status(409).json({ error: "Only open or scheduled rooms can be cancelled." });

  // Authoritative terminal transition + refunds + one realtime event + one notification per user.
  // Idempotent: a room already terminal/started is a safe no-op. A later start/expire can never
  // revive a cancelled room (the terminal status is compare-and-set).
  const result = await terminateWaitingRoom(raceId, {
    terminalStatus: "cancelled",
    reason: "HOST_CANCELLED",
    actor: "host",
    hostUserId: userId,
  });
  req.log.info({ raceId, userId, changed: result.changed }, "race room cancelled by host");
  return res.json({ success: true, raceStatus: "cancelled", cancellationReason: "HOST_CANCELLED" });
});

// ── POST /api/races/:id/leave ─────────────────────────────────────────────────
// Participant leaves a race. Supports both waiting rooms (open) and active
// races (in_progress). For active races, only the caller's participation ends —
// the race itself continues for remaining players.
router.post("/races/:id/leave", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const raceId = String(req.params.id);
  const leaveReason = typeof req.body?.reason === "string" ? req.body.reason : "voluntary";

  const [room] = await db
    .select()
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.id, raceId))
    .limit(1);

  if (!room) return res.status(404).json({ error: "Race not found" });
  if (room.status === "completed" || room.status === "cancelled") {
    return res.status(409).json({ error: "Race is already finished." });
  }

  const isHost = room.creatorId === userId;
  const isPaid = room.entryAmountCents > 0;
  // Server-authoritative refund boundary (§): a race is PRE-START until it actually starts. An
  // open/full room hasn't started until the host starts it; a scheduled room starts at
  // scheduledStartAt. leaveRequestedAt >= startAt (server time) is the non-refundable side.
  const startAtMs = room.startedAt?.getTime() ?? room.scheduledStartAt?.getTime() ?? null;
  const isPreStart = (room.status === "open" || room.status === "full" || room.status === "scheduled")
    && (startAtMs === null || Date.now() < startAtMs);

  // Free rooms keep the "host cancels" rule. Paid challenges CANNOT be cancelled, so the host must
  // LEAVE instead (pre-start still refunds). Leaving never cancels the challenge or reassigns the
  // host — creatorId is preserved so the original host name still displays; the slot is just emptied.
  if (isPreStart && isHost && !isPaid) {
    return res.status(400).json({ error: "Host cannot leave — use Cancel Room instead." });
  }

  const [participant] = await db
    .select()
    .from(raceParticipantsTable)
    .where(
      and(
        eq(raceParticipantsTable.raceRoomId, raceId),
        eq(raceParticipantsTable.userId, userId),
        ne(raceParticipantsTable.status, "left"),
      ),
    )
    .limit(1);

  if (!participant) {
    return res.status(404).json({ error: "You are not an active participant in this race." });
  }

  if (isPreStart) {
    // ── Pre-start leave: remove from lobby + refund per policy (idempotent). Works for the host
    // (paid) and regular participants. The refund txn re-validates server time + refund idempotency.
    try {
      const leaveResult = await createRefundForRaceLeave({ raceId, userId, reasonCode: leaveReason });
      const refund = leaveResult.refund;
      await triggerEvent(`public-live-race-${raceId}`, "race:player-left", { userId, raceId });
      triggerEvent("public-rooms-available", "room:participant_left", { room_id: raceId }).catch(() => {});
      const refundAmount = refund.succeededCashCents ?? 0;
      req.log.info({ raceId, userId, isHost, refundAmount }, "participant left race (pre-start, refunded)");
      return res.json({
        success: true,
        room_id: raceId,
        message: "You left the race.",
        participationStatus: "left",
        participant_status: "left",
        currentUserRegistered: false,
        prizeEligible: false,
        refundEligible: true,
        refundIssued: refundAmount > 0,
        refundStatus: refund.status ?? null,
        refundAmount,
        refundAmountCents: refundAmount,
        activeChallengeReleased: true,
        challengeStatus: room.status, // unchanged — leaving never cancels the challenge
        hostLeft: isHost,
        can_rejoin: false,
        refundBreakdown: { refund },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg === "HOST_MUST_CANCEL") return res.status(400).json({ error: "Host cannot leave — use Cancel Room instead." });
      if (msg !== "RACE_ALREADY_STARTED") {
        req.log.error({ raceId, userId, err }, "race leave refund failed");
        return res.status(409).json({ error: "Could not process your leave right now. Please try again." });
      }
      // The race started between our pre-check and the refund transaction → fall through to the
      // no-refund forfeit path (server-authoritative time was re-checked inside the refund txn).
    }
  }

  {
    // ── Post-start leave: forfeit this participant (atomic + idempotent) ────────────
    // A forfeit NEVER refunds, NEVER settles the race, and NEVER declares another
    // participant the winner. It marks ONLY this participant forfeited; the race stays
    // active and remaining players must still complete the target to win (§9–§12).
    const forfeitedAtMs = Date.now();
    const forfeitChanged = await db.transaction(async (tx) => {
      const updated = await tx
        .update(raceParticipantsTable)
        .set({
          status: "forfeited",
          finalSteps: participant.currentSteps,
          forfeitedAtMs,
          completedAt: new Date(forfeitedAtMs),
        })
        .where(and(
          eq(raceParticipantsTable.id, participant.id),
          // Only from a live status — makes duplicate/terminal forfeit requests no-ops (§14).
          notInArray(raceParticipantsTable.status, ["forfeited", "disqualified", "left", "completed"]),
        ))
        .returning({ id: raceParticipantsTable.id });
      if (updated.length === 0) return false;
      await writeAuditLog({
        actorUserId: userId,
        actorType: "user",
        action: "race.forfeit",
        entityType: "race_participant",
        entityId: participant.id,
        reason: leaveReason,
        metadata: { raceId, forfeitedAtMs, finalSteps: participant.currentSteps, refund: "none" },
      });
      return true;
    });

    if (forfeitChanged) {
      // Evict from redis-live so queued/delayed ticks can't reactivate the forfeited player (§12).
      void removeParticipantLiveState(raceId, userId);

      await triggerEvent(`public-live-race-${raceId}`, "race:participant-forfeited", {
        userId,
        raceId,
        finalSteps: participant.currentSteps,
        reason: leaveReason,
      });

      // ── No-contest resolution (NOT a winner-by-forfeit) ───────────────────────
      // A forfeit must not settle the race or crown a survivor. We only auto-complete
      // when NOBODY is left actively racing (every remaining participant has already
      // finished or forfeited). That race then settles via the normal completion-gated
      // rules — zero winners unless someone actually completed the target.
      const remainingActiveRows = await db
        .select({ userId: raceParticipantsTable.userId })
        .from(raceParticipantsTable)
        .where(and(
          eq(raceParticipantsTable.raceRoomId, raceId),
          ne(raceParticipantsTable.status, "left"),
          ne(raceParticipantsTable.status, "forfeited"),
          ne(raceParticipantsTable.status, "disqualified"),
          eq(raceParticipantsTable.finishedGoal, false),
        ));
      const activeCount = new Set(remainingActiveRows.map((r) => r.userId)).size;
      if (activeCount === 0) {
        req.log.info({ raceId, userId }, "no participant still racing (all finished or forfeited) — auto-completing");
        autoCompleteRace(raceId, "all_forfeited").catch((err) => {
          req.log.error({ raceId, err }, "forfeit: autoCompleteRace failed");
        });
      }
    }

    req.log.info({ raceId, userId, leaveReason, changed: forfeitChanged }, "participant forfeited race");
    return res.json({
      success: true,
      raceId,
      room_id: raceId,
      message: "You quit this race.",
      participationStatus: "left",
      participant_status: "forfeited",
      participantStatus: "forfeited",
      currentUserRegistered: false,
      prizeEligible: false,
      refundEligible: false,
      refundIssued: false,
      refundAmount: 0,
      refundAmountCents: 0,
      activeChallengeReleased: true,
      raceStatus: "active",
      challengeStatus: room.status, // unchanged — leaving never cancels the challenge
      raceContinues: true,
      hostLeft: isHost,
      can_rejoin: false,
      refund: { eligible: false, type: "none", cashAmountMinor: 0, coinAmount: 0 },
    });
  }
});

// ── GET /api/races ────────────────────────────────────────────────────────────
// Returns race rooms for the Live tab. Supports filter by entry type or status.
router.get("/races", requireAuth, async (req, res) => {
  const filter = (req.query.filter as string) || "all";
  const statusFilter = (req.query.status as string) || "all";

  const statusCondition =
    statusFilter === "in_progress"
      ? eq(raceRoomsTable.status, "in_progress")
      : statusFilter === "open"
        ? eq(raceRoomsTable.status, "open")
        : statusFilter === "completed"
          ? eq(raceRoomsTable.status, "completed")
          : inArray(raceRoomsTable.status, ["open", "in_progress"]);

  const entryCondition =
    filter === "free"
      ? and(eq(raceRoomsTable.entryType, "free"), ne(raceRoomsTable.type, "sponsored"))
      : filter === "$1"
        ? eq(raceRoomsTable.entryType, "paid_1")
        : filter === "$3"
          ? eq(raceRoomsTable.entryType, "paid_3")
          : filter === "$5"
            ? eq(raceRoomsTable.entryType, "paid_5")
            : filter === "coins" || filter === "coins_battle"
            ? eq(raceRoomsTable.entryType, "coins_battle")
            : filter === "country"
              ? eq(raceRoomsTable.type, "country_battle")
              : filter === "sponsored"
                ? eq(raceRoomsTable.type, "sponsored")
                : undefined;

  const whereClause = entryCondition
    ? and(statusCondition, entryCondition)
    : statusCondition;

  // Order by the most relevant recency column per status so that races
  // created weeks in advance (e.g. sponsored events) still surface at
  // the top when they are live or have just finished.
  const orderByClause =
    statusFilter === "completed"
      ? desc(raceRoomsTable.completedAt)
      : statusFilter === "in_progress"
        ? desc(raceRoomsTable.startedAt)
        : desc(raceRoomsTable.createdAt);

  const limitNum  = Math.min(100, Math.max(1, parseInt((req.query.limit  as string) || "30", 10) || 30));
  const offsetNum = Math.max(0,              parseInt((req.query.offset as string) || "0",  10) || 0);

  const rows = await db
    .select()
    .from(raceRoomsTable)
    .where(whereClause)
    .orderBy(orderByClause)
    .limit(limitNum)
    .offset(offsetNum);
  const trackThemeMediaMap = await getTrackThemeMediaMap(rows.map((room) => room.trackLayout));

  // Attach top-3 participants for each race
  const racesWithPlayers = await Promise.all(
    rows.map(async (room) => {
      // For completed races, read authoritative steps from race_results (ordered by rank).
      // For active races, read live progress from race_participants.
      let players: Array<{ id: string; userId: string; username: string; countryFlag: string; avatarColor: string; avatarUrl: string | null; avatarVersion: number; currentSteps: number; rank: number; isHost: boolean; prizeAmount?: number; isTied?: boolean; tieGroupSize?: number }>;

      if (room.status === "completed") {
        const results = await db
          .select({
            userId: raceResultsTable.userId,
            steps: raceResultsTable.steps,
            rank: raceResultsTable.rank,
            prizeCents: raceResultsTable.prizeCents,
            isTied: raceResultsTable.isTied,
            tieGroupSize: raceResultsTable.tieGroupSize,
            username: profilesTable.username,
            countryFlag: profilesTable.countryFlag,
            avatarColor: profilesTable.avatarColor,
            avatarUrl: profilesTable.avatarUrl,
            updatedAt: profilesTable.updatedAt,
          })
          .from(raceResultsTable)
          .innerJoin(profilesTable, eq(raceResultsTable.userId, profilesTable.id))
          .where(eq(raceResultsTable.raceRoomId, room.id))
          .orderBy(asc(raceResultsTable.rank))
          .limit(3);

        players = results.map((r) => ({
          id: r.userId,
          userId: r.userId,
          username: r.username,
          countryFlag: r.countryFlag ?? "🏳️",
          avatarColor: r.avatarColor ?? "#00E676",
          avatarUrl: r.avatarUrl ?? null,
          avatarVersion: r.updatedAt?.getTime() ?? 0,
          currentSteps: r.steps,
          targetSteps: targetStepsForRoom(room),
          rank: r.rank,
          isHost: r.userId === room.creatorId,
          prizeAmount: (r.prizeCents ?? 0) > 0 ? r.prizeCents! / 100 : undefined,
          isTied: r.isTied ?? false,
          tieGroupSize: r.tieGroupSize ?? 1,
        }));
      } else {
        const participants = await db
          .select({
            id: raceParticipantsTable.id,
            userId: raceParticipantsTable.userId,
            currentSteps: raceParticipantsTable.currentSteps,
            username: profilesTable.username,
            countryFlag: profilesTable.countryFlag,
            avatarColor: profilesTable.avatarColor,
            avatarUrl: profilesTable.avatarUrl,
            updatedAt: profilesTable.updatedAt,
          })
          .from(raceParticipantsTable)
          .innerJoin(profilesTable, eq(raceParticipantsTable.userId, profilesTable.id))
          .where(and(eq(raceParticipantsTable.raceRoomId, room.id), ne(raceParticipantsTable.status, "left")))
          .orderBy(desc(raceParticipantsTable.currentSteps))
          .limit(3);

        // Deduplicate by userId — a user may have joined multiple times
        const seenIds = new Set<string>();
        const uniqueP = participants.filter((p) => {
          if (seenIds.has(p.userId)) return false;
          seenIds.add(p.userId);
          return true;
        });
        players = uniqueP.map((p, i) => ({
          id: p.userId,
          userId: p.userId,
          username: p.username,
          countryFlag: p.countryFlag ?? "🏳️",
          avatarColor: p.avatarColor ?? "#00E676",
          avatarUrl: p.avatarUrl ?? null,
          avatarVersion: p.updatedAt?.getTime() ?? 0,
          currentSteps: p.currentSteps,
          targetSteps: targetStepsForRoom(room),
          rank: i + 1,
          isHost: p.userId === room.creatorId,
        }));
      }

      const { total: prizeTotal, winners: winnersPoolCents } = calcPrizePool(room.entryAmountCents, room.currentPlayers);
      const splits = getPrizeSplits(room.currentPlayers);
      const prizeTiers = splits.map((s) => parseFloat(((winnersPoolCents / 100) * s).toFixed(2)));
      const rewardSplit = buildRewardSplit(room.entryAmountCents, room.currentPlayers);
      const winnerCount = room.type === "sponsored" ? getSponsoredWinnerCount(room.currentPlayers) : numWinners(room.currentPlayers);
      const displayPrizePoolCents = room.type === "sponsored" ? getSponsoredPrizePoolCents(room.currentPlayers) : (room.prizePoolCents ?? 0);
      const trackTheme = trackThemeForCode(room.trackLayout, trackThemeMediaMap);
      const challengeTime = buildChallengeTimeFields(room);

      return {
        id: room.id,
        title: room.title,
        type: room.type,
        entryType: entryTypeLabel(room.entryType),
        entryAmountCents: room.entryAmountCents,
        playerCount: room.currentPlayers,
        maxPlayers: room.maxPlayers,
        targetSteps: targetStepsForRoom(room),
        status: room.status,
        prizePool: prizeTotal / 100,
        prizePoolCents: displayPrizePoolCents,
        winnersPool: room.type === "sponsored" ? displayPrizePoolCents / 100 : winnersPoolCents / 100,
        platformFee: 0,
        prizeTiers,
        rewardSplit,
        winnerCount,
        spectatorCount: room.spectatorCount,
        isPrivate: room.isPrivate,
        inviteCode: room.isPrivate ? room.inviteCode : null,
        countryCode: room.countryCode,
        ...challengeTime,
        completedAt: room.completedAt,
        createdAt: room.createdAt,
        creatorId: room.creatorId,
        trackLayout: room.trackLayout ?? "bg",
        trackTheme,
        imageSet: trackTheme.imageSet,
        trackThemeImageSet: trackTheme.imageSet,
        coin_entry_amount: room.coinEntryAmount ?? 0,
        players,
      };
    }),
  );

  // Batch-fetch reaction counts for all races in one query
  const raceIds = racesWithPlayers.map((r) => r.id);
  const reactionRows = raceIds.length > 0
    ? await db
        .select({
          raceRoomId: liveRaceReactionsTable.raceRoomId,
          emoji:      liveRaceReactionsTable.emoji,
          count:      sql<number>`count(*)::int`,
        })
        .from(liveRaceReactionsTable)
        .where(inArray(liveRaceReactionsTable.raceRoomId, raceIds))
        .groupBy(liveRaceReactionsTable.raceRoomId, liveRaceReactionsTable.emoji)
    : [];

  // Build raceId → { emoji: count } map
  const reactMap: Record<string, Record<string, number>> = {};
  for (const row of reactionRows) {
    if (!reactMap[row.raceRoomId]) reactMap[row.raceRoomId] = {};
    reactMap[row.raceRoomId][row.emoji] = row.count;
  }

  const racesWithReactions = racesWithPlayers.map((r) => ({
    ...r,
    reactionCounts: reactMap[r.id] ?? {},
  }));

  return res.json({ races: racesWithReactions });
});

// ── POST /api/races ───────────────────────────────────────────────────────────
const createRaceSchema = z.object({
  title: z.string().min(3).max(60),
  type: z.enum(["quick", "endurance", "country_battle", "friends", "sponsored"]),
  entryType: z.enum(["free", "paid_1", "paid_3", "paid_5"]),
  targetSteps: z.number().int().min(50).max(1000000),
  maxPlayers: z.number().int().min(2).max(100),
  isPrivate: z.boolean().optional().default(false),
  countryCode: z.string().optional(),
  trackLayout: z.enum(VALID_TRACK_LAYOUTS).optional().default("bg"),
});

router.post("/races", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = createRaceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }

  const data = parsed.data;
  if (!ENABLE_CASH_CHALLENGES && data.entryType !== "free") {
    return res.status(403).json({ error: "Only free races are enabled in v1." });
  }
  const amountCents = entryAmountCents(data.entryType);

  // Validate host owns the selected track theme (default themes always pass)
  const ownsLayoutPost = await validateThemeOwnership(userId, data.trackLayout);
  if (!ownsLayoutPost) {
    return res.status(403).json({ error: "You must unlock this track before hosting a challenge with it." });
  }

  const existingRegularRace = await getRegularRaceRegistrationForUser(db, userId);
  if (existingRegularRace) {
    return res.status(409).json(regularRaceRegistrationConflictBody(existingRegularRace, userId));
  }
  {
    // One-blocking-challenge also spans Unlimited Challenges (no-op when the feature flag is off).
    const unlimitedBlock = await getUnlimitedBlockingMembership(db, userId);
    if (unlimitedBlock) return res.status(409).json({ error: "You already have an active challenge.", code: "one_challenge_at_a_time", blocking: unlimitedBlock });
  }

  if (amountCents > 0) {
    const [profile] = await db
      .select()
      .from(profilesTable)
      .where(eq(profilesTable.id, userId))
      .limit(1);
    if (!profile) return res.status(403).json({ error: "Paid challenges are not available for your account." });
    if (!computeIsAdult(profile.dateOfBirth, profile.isAdult)) return res.status(403).json({ error: "You must be 18 or older to join paid challenges." });
    if (!profile.paidRaceEnabled) return res.status(403).json({ error: "Paid challenges are not available for your account." });
    if (profile.accountStatus !== "active") return res.status(403).json({ error: "Your account is under review." });
    if (!profile.profileCompleted) return res.status(403).json({ error: "Paid challenges are not available for your account." });
    if ((profile.fraudScore ?? 0) >= 70) return res.status(403).json({ error: "Your account is under review." });
  }

  // CSPRNG code with ≥64 bits of entropy (replaces the brute-forceable 4-byte
  // hex code) so private rooms cannot be enumerated.
  const inviteCode = data.isPrivate ? generateInviteCode() : null;

  let createConflict: RegularRaceRegistrationRow | null = null;
  const [room] = await db.transaction(async (tx) => {
    await lockRegularRaceRegistrationForUser(tx, userId);
    createConflict = await getRegularRaceRegistrationForUser(tx, userId);
    if (createConflict) return [];

    return tx
      .insert(raceRoomsTable)
      .values({
        creatorId: userId,
        title: data.title,
        type: data.type,
        entryType: data.entryType,
        entryAmountCents: amountCents,
        targetSteps: data.targetSteps,
        maxPlayers: data.maxPlayers,
        isPrivate: data.isPrivate,
        countryCode: data.countryCode,
        trackLayout: data.trackLayout,
        inviteCode,
        mode: "open_window",
        minimumParticipants: config.waitingRoom.minimumParticipants,
        roomExpiresAt: new Date(Date.now() + config.waitingRoom.openWindowMs),
      })
      .returning();
  });

  if (createConflict) {
    return res.status(409).json(regularRaceRegistrationConflictBody(createConflict, userId));
  }
  if (!room) {
    return res.status(409).json({ error: "Unable to create race." });
  }

  void enqueueWaitingRoomLifecycleJobs(room);

  try {
    await setUserDefaultTrackTheme(userId, data.trackLayout);
  } catch (err) {
    req.log.warn({ err, userId, trackLayout: data.trackLayout }, "failed to save last used track theme");
  }

  req.log.info({ raceId: room.id, entryType: room.entryType }, "race created");
  return res.status(201).json({ race: room });
});

// ── POST /api/races/quick-join-free ──────────────────────────────────────────
const quickJoinFreeSchema = z.object({
  maxPlayers: z.number().int().min(2).max(100).optional().default(10),
  targetSteps: z.number().int().min(50).max(1000000).optional().default(1000),
});

router.post("/races/quick-join-free", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const parsed = quickJoinFreeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }
  const { maxPlayers, targetSteps } = parsed.data;

  const existingRegularRace = await getRegularRaceRegistrationForUser(db, userId);
  if (existingRegularRace) {
    return res.status(409).json(regularRaceRegistrationConflictBody(existingRegularRace, userId));
  }
  {
    // One-blocking-challenge also spans Unlimited Challenges (no-op when the feature flag is off).
    const unlimitedBlock = await getUnlimitedBlockingMembership(db, userId);
    if (unlimitedBlock) return res.status(409).json({ error: "You already have an active challenge.", code: "one_challenge_at_a_time", blocking: unlimitedBlock });
  }

  const [profile] = await db
    .select({ accountStatus: profilesTable.accountStatus })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);

  if (!profile) return res.status(404).json({ error: "Profile not found." });
  if (profile.accountStatus === "banned" || profile.accountStatus === "suspended") {
    return res.status(403).json({ error: "Your account is not eligible to join challenges." });
  }

  const openRooms = await db
    .select()
    .from(raceRoomsTable)
    .where(
      and(
        eq(raceRoomsTable.entryType, "free"),
        eq(raceRoomsTable.status, "open"),
        sql`${raceRoomsTable.currentPlayers} < ${raceRoomsTable.maxPlayers}`,
      ),
    )
    .orderBy(desc(raceRoomsTable.currentPlayers))
    .limit(5);

  let targetRoomId: string | null = null;
  let participant: typeof raceParticipantsTable.$inferSelect | null = null;
  let joinedRoom: typeof raceRoomsTable.$inferSelect | null = null;

  for (const room of openRooms) {
    let joined = false;

    await db.transaction(async (tx) => {
      await lockRegularRaceRegistrationForUser(tx, userId);
      const conflict = await getRegularRaceRegistrationForUser(tx, userId, room.id);
      if (conflict) return;

      const lockedRoom = await lockRaceRoom(tx, room.id);
      if (!lockedRoom || (lockedRoom.status !== "open" && lockedRoom.status !== "full")) return;
      // Reject joins to an open-window room whose 30-minute window has already closed.
      if (lockedRoom.roomExpiresAt && Date.now() >= lockedRoom.roomExpiresAt.getTime()) return;
      if (lockedRoom.currentPlayers >= lockedRoom.maxPlayers) return;

      const participantResult = await joinOrReviveParticipant(tx, { raceRoomId: lockedRoom.id, userId });
      if (!participantResult.changed) return;

      const newPlayerCount = lockedRoom.currentPlayers + 1;
      const nextStatus = deriveOpenRoomStatus(newPlayerCount, lockedRoom.maxPlayers);

      await tx
        .update(raceRoomsTable)
        .set({
          currentPlayers: newPlayerCount,
          status: nextStatus,
          updatedAt: new Date(),
        })
        .where(eq(raceRoomsTable.id, lockedRoom.id));

      participant = participantResult.participant;
      joinedRoom = { ...lockedRoom, currentPlayers: newPlayerCount, status: nextStatus };
      targetRoomId = lockedRoom.id;
      joined = true;
    });

    if (joined) break;
  }

  if (!targetRoomId || !participant || !joinedRoom) {
    let createConflict: RegularRaceRegistrationRow | null = null;
    const created = await db.transaction(async (tx) => {
      await lockRegularRaceRegistrationForUser(tx, userId);
      createConflict = await getRegularRaceRegistrationForUser(tx, userId);
      if (createConflict) return null;

      const [newRoom] = await tx
        .insert(raceRoomsTable)
        .values({
          creatorId: userId,
          title: "Quick Free Challenge",
          type: "quick",
          entryType: "free",
          entryAmountCents: 0,
          targetSteps,
          maxPlayers,
          currentPlayers: 1,
          mode: "open_window",
          minimumParticipants: config.waitingRoom.minimumParticipants,
          roomExpiresAt: new Date(Date.now() + config.waitingRoom.openWindowMs),
        })
        .returning();

      const [newParticipant] = await tx
        .insert(raceParticipantsTable)
        .values({ raceRoomId: newRoom.id, userId, status: "joined" })
        .returning();

      return { newRoom, newParticipant };
    });

    if (createConflict) {
      return res.status(409).json(regularRaceRegistrationConflictBody(createConflict, userId));
    }
    if (!created) {
      return res.status(409).json({ error: "Unable to join a race." });
    }

    targetRoomId = created.newRoom.id;
    participant = created.newParticipant;

    void enqueueWaitingRoomLifecycleJobs(created.newRoom);
    req.log.info({ raceId: targetRoomId, userId }, "user quick-joined (created) free race");
    return res.status(201).json({ raceId: targetRoomId, isHost: true });
  }

  req.log.info({ raceId: targetRoomId, userId }, "user quick-joined free race");
  return res.status(201).json({ raceId: targetRoomId, participant, isHost: joinedRoom.creatorId === userId });
});

// ── POST /api/races/:id/join-paid ─────────────────────────────────────────────
// Deducts entry fee from the user's available wallet balance and joins the race.
router.post("/races/:id/join-paid", requireAuth, async (req, res) => {
  if (!ENABLE_CASH_CHALLENGES) {
    return res.status(404).json({ error: "Cash race joins are disabled for this build." });
  }
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const raceId = String(req.params.id);

  const existingRegularRace = await getRegularRaceRegistrationForUser(db, userId, raceId);
  if (existingRegularRace) {
    return res.status(409).json(regularRaceRegistrationConflictBody(existingRegularRace, userId));
  }
  {
    // One-blocking-challenge also spans Unlimited Challenges (no-op when the feature flag is off).
    const unlimitedBlock = await getUnlimitedBlockingMembership(db, userId);
    if (unlimitedBlock) return res.status(409).json({ error: "You already have an active challenge.", code: "one_challenge_at_a_time", blocking: unlimitedBlock });
  }

  const [room] = await db
    .select()
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.id, raceId))
    .limit(1);

  if (!room) return res.status(404).json({ error: "Race not found." });
  if (room.entryAmountCents === 0) return res.status(400).json({ error: "Use the free join endpoint for free races." });

  // Eligibility checks
  const [profile] = await db.select().from(profilesTable).where(eq(profilesTable.id, userId)).limit(1);
  if (!profile) return res.status(403).json({ error: "Paid challenges are not available for your account." });
  if (!computeIsAdult(profile.dateOfBirth, profile.isAdult)) return res.status(403).json({ error: "You must be 18 or older to join paid challenges." });
  if (!profile.paidRaceEnabled) return res.status(403).json({ error: "Paid challenges are not available for your account." });
  if (profile.accountStatus !== "active") return res.status(403).json({ error: "Your account is under review." });
  if (isCashChallengeUnsupportedForCountry(profile.countryCode)) {
    req.log.info(
      { userId, raceId, countryCode: profile.countryCode },
      "[CashChallenge] INR/Razorpay paid join blocked until multi-currency support ships",
    );
    return res.status(403).json(cashChallengeUnsupportedForCurrencyBody());
  }

  // Wallet check — require total payable (entry + processing + platform service fees)
  const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.userId, userId)).limit(1);
  const balance = wallet?.availableBalanceCents ?? 0;
  const [profileForFees] = await db
    .select({ countryCode: profilesTable.countryCode })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);
  const provider = resolvePaymentProvider(profileForFees?.countryCode);
  const perPlayerFees = calcPerPlayerFees(room.entryAmountCents, provider);
  if (balance < perPlayerFees.totalPayableCents) {
    return res.status(402).json({
      error: `Insufficient balance. You need $${(perPlayerFees.totalPayableCents / 100).toFixed(2)} to join this challenge.`,
      ...formatQuoteForApi(
        buildCashChallengeQuote({
          entryFeeCents: room.entryAmountCents,
          numberOfPlayers: room.maxPlayers,
          paymentProvider: provider,
        }),
        balance,
      ),
    });
  }

  let participant: typeof raceParticipantsTable.$inferSelect | null = null;
  let lockedRoom: typeof raceRoomsTable.$inferSelect | null = null;
  let joinedCurrentPlayers = room.currentPlayers;
  let joinErrorStatus: number | null = null;
  let joinErrorBody: Record<string, unknown> | null = null;

  try {
    await db.transaction(async (tx) => {
      await lockRegularRaceRegistrationForUser(tx, userId);

      lockedRoom = await lockRaceRoom(tx, raceId);
      if (!lockedRoom) {
        joinErrorStatus = 404;
        joinErrorBody = { error: "Race not found." };
        return;
      }
      if (lockedRoom.status !== "open" && lockedRoom.status !== "full") {
        joinErrorStatus = 409;
        joinErrorBody = { error: "Race is no longer open to join." };
        return;
      }
      // Reject late joins to an open-window room whose 30-minute window has already closed.
      if (lockedRoom.roomExpiresAt && Date.now() >= lockedRoom.roomExpiresAt.getTime()) {
        joinErrorStatus = 409;
        joinErrorBody = { error: "This Waiting Room has expired." };
        return;
      }
      if (lockedRoom.currentPlayers >= lockedRoom.maxPlayers) {
        joinErrorStatus = 409;
        joinErrorBody = { error: "Race is full." };
        return;
      }
      if (lockedRoom.type !== "sponsored") {
        const conflict = await getRegularRaceRegistrationForUser(tx, userId, raceId);
        if (conflict) {
          joinErrorStatus = 409;
          joinErrorBody = regularRaceRegistrationConflictBody(conflict, userId);
          return;
        }
      }

      const participantResult = await joinOrReviveParticipant(tx, { raceRoomId: raceId, userId });
      if (participantResult.reason === "blocked") {
        joinErrorStatus = 409;
        joinErrorBody = { error: "You cannot rejoin this race." };
        return;
      }
      if (participantResult.reason === "already_joined") {
        joinErrorStatus = 409;
        joinErrorBody = { error: "You are already in this race." };
        return;
      }

      participant = participantResult.participant;
      const newPlayerCount = lockedRoom.currentPlayers + 1;
      await tx
        .update(raceRoomsTable)
        .set({
          currentPlayers: newPlayerCount,
          status: deriveOpenRoomStatus(newPlayerCount, lockedRoom.maxPlayers),
          updatedAt: new Date(),
        })
        .where(eq(raceRoomsTable.id, lockedRoom.id));

      const debit = await debitCashChallengeEntry(tx, {
        userId,
        raceRoomId: raceId,
        entryFeeCents: lockedRoom.entryAmountCents,
        paymentProvider: provider,
        description: `Cash challenge join: ${lockedRoom.title}`,
      });
      if (!debit.ok) {
        throw new PaidJoinRollback(402, { error: debit.error });
      }
      await grantReferralBonusForCashChallenge(tx, {
        referredUserId: userId,
        raceRoomId: raceId,
      });

      joinedCurrentPlayers = newPlayerCount;
      lockedRoom = { ...lockedRoom, currentPlayers: newPlayerCount, status: deriveOpenRoomStatus(newPlayerCount, lockedRoom.maxPlayers) };
    });
  } catch (err) {
    if (err instanceof PaidJoinRollback) {
      joinErrorStatus = err.statusCode;
      joinErrorBody = err.body;
    } else {
      throw err;
    }
  }

  if (joinErrorStatus !== null && joinErrorBody) {
    return res.status(joinErrorStatus).json(joinErrorBody);
  }
  if (!participant) {
    return res.status(409).json({ error: "Unable to join this race." });
  }

  await triggerEvent(`public-live-race-${raceId}`, "race:player-joined", { userId, raceId });
  triggerEvent("public-rooms-available", "room:participant_joined", { room_id: raceId, current_players: joinedCurrentPlayers }).catch(() => {});
  req.log.info({ raceId, userId, amountCents: room.entryAmountCents }, "user joined paid race");
  const paymentQuote = formatQuoteForApi(
    buildCashChallengeQuote({
      entryFeeCents: room.entryAmountCents,
      numberOfPlayers: room.maxPlayers,
      paymentProvider: provider,
    }),
    balance - perPlayerFees.totalPayableCents,
  );
  return res.status(201).json({ participant, isHost: false, paymentQuote });
});

// ── POST /api/races/:id/join (free only — paid uses payment intent) ───────────
router.post("/races/:id/join", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const raceId = String(req.params.id);

  const existingRegularRace = await getRegularRaceRegistrationForUser(db, userId, raceId);
  if (existingRegularRace) {
    return res.status(409).json(regularRaceRegistrationConflictBody(existingRegularRace, userId));
  }
  {
    // One-blocking-challenge also spans Unlimited Challenges (no-op when the feature flag is off).
    const unlimitedBlock = await getUnlimitedBlockingMembership(db, userId);
    if (unlimitedBlock) return res.status(409).json({ error: "You already have an active challenge.", code: "one_challenge_at_a_time", blocking: unlimitedBlock });
  }

  const [room] = await db
    .select()
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.id, raceId))
    .limit(1);

  if (!room) return res.status(404).json({ error: "Race not found" });
  if (room.entryAmountCents > 0) {
    return res.status(ENABLE_CASH_CHALLENGES ? 400 : 404).json({
      error: ENABLE_CASH_CHALLENGES
        ? "Use the payment API to join paid races."
        : "Cash races are disabled for this build.",
    });
  }

  if (room.type === "country_battle" && room.teamACountryCode && room.teamBCountryCode) {
    const [profile] = await db
      .select({ countryCode: profilesTable.countryCode })
      .from(profilesTable)
      .where(eq(profilesTable.id, userId))
      .limit(1);
    const userCountry = profile?.countryCode;
    if (!userCountry || (userCountry !== room.teamACountryCode && userCountry !== room.teamBCountryCode)) {
      return res.status(403).json({
        error: `This is a Country Battle: ${room.teamACountry ?? room.teamACountryCode} vs ${room.teamBCountry ?? room.teamBCountryCode}. Only players from these countries may join.`,
        code: "COUNTRY_INELIGIBLE",
      });
    }
  }

  let participant: typeof raceParticipantsTable.$inferSelect | null = null;
  let lockedRoom: typeof raceRoomsTable.$inferSelect | null = null;
  let joinedCurrentPlayers = room.currentPlayers;
  let joinErrorStatus: number | null = null;
  let joinErrorBody: Record<string, unknown> | null = null;

  await db.transaction(async (tx) => {
    await lockRegularRaceRegistrationForUser(tx, userId);

    lockedRoom = await lockRaceRoom(tx, raceId);
    if (!lockedRoom) {
      joinErrorStatus = 404;
      joinErrorBody = { error: "Race not found" };
      return;
    }
    if (lockedRoom.status !== "open" && lockedRoom.status !== "full") {
      joinErrorStatus = 409;
      joinErrorBody = { error: "Race is no longer open to join." };
      return;
    }
    // Reject late joins to an open-window room whose 30-minute window has already closed.
    if (lockedRoom.roomExpiresAt && Date.now() >= lockedRoom.roomExpiresAt.getTime()) {
      joinErrorStatus = 409;
      joinErrorBody = { error: "This Waiting Room has expired." };
      return;
    }
    if (lockedRoom.currentPlayers >= lockedRoom.maxPlayers) {
      joinErrorStatus = 409;
      joinErrorBody = { error: "Race is full." };
      return;
    }
    if (lockedRoom.type !== "sponsored") {
      const conflict = await getRegularRaceRegistrationForUser(tx, userId, raceId);
      if (conflict) {
        joinErrorStatus = 409;
        joinErrorBody = regularRaceRegistrationConflictBody(conflict, userId);
        return;
      }
    }

    const participantResult = await joinOrReviveParticipant(tx, { raceRoomId: raceId, userId });
    if (participantResult.reason === "blocked") {
      joinErrorStatus = 409;
      joinErrorBody = { error: "You cannot rejoin this race." };
      return;
    }
    if (participantResult.reason === "already_joined") {
      joinErrorStatus = 409;
      joinErrorBody = { error: "You are already in this race." };
      return;
    }

    participant = participantResult.participant;
    const newPlayerCount = lockedRoom.currentPlayers + 1;
    await tx
      .update(raceRoomsTable)
      .set({
        currentPlayers: newPlayerCount,
        status: deriveOpenRoomStatus(newPlayerCount, lockedRoom.maxPlayers),
        updatedAt: new Date(),
      })
      .where(eq(raceRoomsTable.id, lockedRoom.id));
    joinedCurrentPlayers = newPlayerCount;
    lockedRoom = { ...lockedRoom, currentPlayers: newPlayerCount, status: deriveOpenRoomStatus(newPlayerCount, lockedRoom.maxPlayers) };
  });

  if (joinErrorStatus !== null && joinErrorBody) {
    return res.status(joinErrorStatus).json(joinErrorBody);
  }
  if (!participant) {
    return res.status(409).json({ error: "Unable to join this race." });
  }

  await triggerEvent(`public-live-race-${raceId}`, "race:player-joined", { userId, raceId });
  triggerEvent("public-rooms-available", "room:participant_joined", { room_id: raceId, current_players: joinedCurrentPlayers }).catch(() => {});
  req.log.info({ raceId, userId }, "user joined race (free)");
  return res.status(201).json({ participant, isHost: room.creatorId === userId });
});

// ── GET /api/races/by-code/:code ──────────────────────────────────────────────
// Look up an open private room by its invite code (used for join-by-code flow).
router.get("/races/by-code/:code", requireAuth, async (req, res) => {
  const code = String(req.params.code).toUpperCase().trim();

  const [room] = await db
    .select({
      id: raceRoomsTable.id,
      status: raceRoomsTable.status,
      entryType: raceRoomsTable.entryType,
      entryAmountCents: raceRoomsTable.entryAmountCents,
      maxPlayers: raceRoomsTable.maxPlayers,
      currentPlayers: raceRoomsTable.currentPlayers,
      targetSteps: raceRoomsTable.targetSteps,
      trackLayout: raceRoomsTable.trackLayout,
      isPrivate: raceRoomsTable.isPrivate,
      inviteCode: raceRoomsTable.inviteCode,
      creatorId: raceRoomsTable.creatorId,
    })
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.inviteCode, code))
    .limit(1);

  if (!room) return res.status(404).json({ error: "Room not found. Check the code and try again." });
  if (room.status === "completed" || room.status === "cancelled") {
    return res.status(409).json({ error: "This room is no longer available." });
  }
  if (room.currentPlayers >= room.maxPlayers) {
    return res.status(409).json({ error: "This room is full." });
  }

  const mediaMap = await getTrackThemeMediaMap([room.trackLayout]);
  const trackTheme = trackThemeForCode(room.trackLayout, mediaMap);
  return res.json({
    raceId: room.id,
    room: {
      ...room,
      trackTheme,
      imageSet: trackTheme.imageSet,
      trackThemeImageSet: trackTheme.imageSet,
    },
  });
});

// ── POST /api/races/join-with-code ────────────────────────────────────────────
// Join a private room using its invite code. Handles both free and paid rooms.
router.post("/races/join-with-code", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const { code, acceptedCashChallengeConsent, acceptedRulesVersion } = req.body as {
    code?: string;
    acceptedCashChallengeConsent?: boolean;
    acceptedRulesVersion?: string;
  };

  if (!code || typeof code !== "string") {
    return res.status(400).json({ success: false, code: "MISSING_CODE", error: "Room code is required." });
  }
  const normalizedCode = code.trim().toUpperCase();

  const [room] = await db
    .select()
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.inviteCode, normalizedCode))
    .limit(1);

  if (!room) {
    return res.status(404).json({ success: false, code: "INVALID_ROOM_CODE", error: "Invalid room code." });
  }

  if (room.status === "completed" || room.status === "cancelled" || room.status === "expired") {
    return res.status(409).json({ success: false, code: "ROOM_CODE_EXPIRED", error: "This room code has expired." });
  }
  if (room.status === "in_progress" || room.status === "starting") {
    return res.status(409).json({ success: false, code: "RACE_ALREADY_STARTED", error: "This race has already started." });
  }
  // Reject joins to an open-window room whose 30-minute window has already closed (before the
  // reconciler/durable job has flipped its status to "expired").
  if (room.roomExpiresAt && Date.now() >= room.roomExpiresAt.getTime()) {
    return res.status(409).json({ success: false, code: "ROOM_EXPIRED", error: "This Waiting Room has expired." });
  }
  if (room.currentPlayers >= room.maxPlayers) {
    return res.status(409).json({ success: false, code: "ROOM_FULL", error: "This room is full." });
  }

  const existingRegularRace = await getRegularRaceRegistrationForUser(db, userId, room.id);
  if (existingRegularRace) {
    return res.status(409).json(regularRaceRegistrationConflictBody(existingRegularRace, userId));
  }

  // Check existing participation
  const [existing] = await db
    .select()
    .from(raceParticipantsTable)
    .where(
      and(
        eq(raceParticipantsTable.raceRoomId, room.id),
        eq(raceParticipantsTable.userId, userId),
      ),
    )
    .limit(1);

  if (existing) {
    if (existing.status === "forfeited" || existing.status === "disqualified") {
      return res.status(409).json({
        success: false,
        code: "RACE_ALREADY_FORFEITED",
        error: "You already quit this race and cannot rejoin while it is active.",
      });
    }
    // Already joined — fetch participants and return success so client can navigate
    const alreadyJoinedParticipants = await db
      .select({
        id: raceParticipantsTable.id,
        userId: raceParticipantsTable.userId,
        username: profilesTable.username,
        country: profilesTable.country,
        countryFlag: profilesTable.countryFlag,
        avatarColor: profilesTable.avatarColor,
        avatarUrl: profilesTable.avatarUrl,
        updatedAt: profilesTable.updatedAt,
      })
      .from(raceParticipantsTable)
      .innerJoin(profilesTable, eq(raceParticipantsTable.userId, profilesTable.id))
      .where(and(
        eq(raceParticipantsTable.raceRoomId, room.id),
        ne(raceParticipantsTable.status, "left"),
      ));
    return res.json({
      success: true,
      room_id: room.id,
      entry_fee: room.entryAmountCents / 100,
      max_players: room.maxPlayers,
      is_private: room.isPrivate,
      status: room.status,
      participant_count: room.currentPlayers,
      current_user_status: existing.status,
      message: "You are already in this room.",
      participants: alreadyJoinedParticipants.map((p) => ({
        id: p.id,
        userId: p.userId,
        username: p.username,
        country: p.country ?? null,
        countryFlag: p.countryFlag ?? null,
        avatarColor: p.avatarColor ?? null,
        avatarUrl: p.avatarUrl ?? null,
        avatarVersion: p.updatedAt?.getTime() ?? 0,
        isHost: p.userId === room.creatorId,
        isCurrentUser: p.userId === userId,
        friendStatus: "none",
        friendRequestId: null,
        activeTitle: null,
        currentSteps: 0,
      })),
    });
  }

  let joinerProfile: typeof profilesTable.$inferSelect | null = null;
  if (room.entryAmountCents > 0) {
    const [profile] = await db.select().from(profilesTable).where(eq(profilesTable.id, userId)).limit(1);
    joinerProfile = profile ?? null;
    if (!joinerProfile || !computeIsAdult(joinerProfile.dateOfBirth, joinerProfile.isAdult) || !joinerProfile.paidRaceEnabled || joinerProfile.accountStatus !== "active") {
      return res.status(403).json({ success: false, error: "Paid challenges are not available for your account." });
    }
    if (isCashChallengeUnsupportedForCountry(joinerProfile.countryCode)) {
      req.log.info(
        { userId, raceId: room.id, countryCode: joinerProfile.countryCode },
        "[CashChallenge] INR/Razorpay private paid join blocked until multi-currency support ships",
      );
      return res.status(403).json(cashChallengeUnsupportedForCurrencyBody());
    }
  }

  // Cash challenge consent enforcement — must be accepted before join
  const rulesVersion = (acceptedRulesVersion as string | undefined) ?? "2026-06";
  if (room.entryAmountCents > 0 && !acceptedCashChallengeConsent) {
    if (!ENABLE_CASH_CHALLENGES) {
      return res.status(404).json({ success: false, error: "Cash challenges are disabled for this build." });
    }
    return res.status(403).json({
      success: false,
      code: "CASH_CHALLENGE_CONSENT_REQUIRED",
      message: "Please confirm the cash challenge terms before joining.",
    });
  }

  // Paid room: profile + wallet check
  if (room.entryAmountCents > 0) {
    if (!ENABLE_CASH_CHALLENGES) {
      return res.status(404).json({
        success: false,
        error: "Cash challenges are disabled for this build.",
      });
    }
    const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.userId, userId)).limit(1);
    const balance = wallet?.availableBalanceCents ?? 0;
    if (balance < room.entryAmountCents) {
      return res.status(402).json({
        success: false,
        error: `Insufficient balance. You need $${(room.entryAmountCents / 100).toFixed(2)} but have $${(balance / 100).toFixed(2)}.`,
      });
    }
  }
  const privatePaidProvider = room.entryAmountCents > 0
    ? resolvePaymentProvider(joinerProfile?.countryCode)
    : "stripe";

  let lockedRoom: typeof raceRoomsTable.$inferSelect | null = null;
  let joinedCurrentPlayers = room.currentPlayers;
  let joinErrorStatus: number | null = null;
  let joinErrorBody: Record<string, unknown> | null = null;

  try {
    await db.transaction(async (tx) => {
      await lockRegularRaceRegistrationForUser(tx, userId);

      lockedRoom = await lockRaceRoom(tx, room.id);
      if (!lockedRoom) {
        joinErrorStatus = 404;
        joinErrorBody = { success: false, error: "Invalid room code." };
        return;
      }
      if (lockedRoom.status === "completed" || lockedRoom.status === "cancelled") {
        joinErrorStatus = 409;
        joinErrorBody = { success: false, code: "ROOM_CODE_EXPIRED", error: "This room code has expired." };
        return;
      }
      if (lockedRoom.status === "in_progress") {
        joinErrorStatus = 409;
        joinErrorBody = { success: false, code: "RACE_ALREADY_STARTED", error: "This race has already started." };
        return;
      }
      if (lockedRoom.currentPlayers >= lockedRoom.maxPlayers) {
        joinErrorStatus = 409;
        joinErrorBody = { success: false, code: "ROOM_FULL", error: "This room is full." };
        return;
      }
      if (lockedRoom.type !== "sponsored") {
        const conflict = await getRegularRaceRegistrationForUser(tx, userId, lockedRoom.id);
        if (conflict) {
          joinErrorStatus = 409;
          joinErrorBody = regularRaceRegistrationConflictBody(conflict, userId);
          return;
        }
      }

      const participantResult = await joinOrReviveParticipant(tx, { raceRoomId: lockedRoom.id, userId });
      if (participantResult.reason === "blocked") {
        joinErrorStatus = 409;
        joinErrorBody = { success: false, code: "RACE_ALREADY_FORFEITED", error: "You already quit this race and cannot rejoin while it is active." };
        return;
      }
      if (participantResult.reason === "already_joined") {
        joinErrorStatus = 409;
        joinErrorBody = { success: false, error: "You are already in this race." };
        return;
      }

      if (lockedRoom.entryAmountCents > 0) {
        const debit = await debitCashChallengeEntry(tx, {
          userId,
          raceRoomId: lockedRoom.id,
          entryFeeCents: lockedRoom.entryAmountCents,
          paymentProvider: privatePaidProvider,
          description: `Cash challenge private join: ${lockedRoom.title}`,
        });
        if (!debit.ok) {
          throw new PaidJoinRollback(402, { error: debit.error });
        }
        await grantReferralBonusForCashChallenge(tx, {
          referredUserId: userId,
          raceRoomId: lockedRoom.id,
        });
      }

      const newPlayerCount = lockedRoom.currentPlayers + 1;
      await tx.update(raceRoomsTable)
        .set({
          currentPlayers: newPlayerCount,
          status: deriveOpenRoomStatus(newPlayerCount, lockedRoom.maxPlayers),
          updatedAt: new Date(),
        })
        .where(eq(raceRoomsTable.id, lockedRoom.id));
      joinedCurrentPlayers = newPlayerCount;

      lockedRoom = {
        ...lockedRoom,
        currentPlayers: newPlayerCount,
        status: deriveOpenRoomStatus(newPlayerCount, lockedRoom.maxPlayers),
      };
    });
  } catch (err) {
    if (err instanceof PaidJoinRollback) {
      joinErrorStatus = err.statusCode;
      joinErrorBody = { success: false, ...err.body };
    } else {
      throw err;
    }
  }

  if (joinErrorStatus !== null && joinErrorBody) {
    return res.status(joinErrorStatus).json(joinErrorBody);
  }

  if (room.entryAmountCents > 0) {
    await db
      .insert(cashChallengeConsentsTable)
      .values({
        userId,
        challengeId: room.id,
        entryFeeCents: room.entryAmountCents,
        currencyCode: "USD",
        rulesVersion,
      })
      .onConflictDoNothing();
  }

  await triggerEvent(`public-live-race-${room.id}`, "race:player-joined", { userId, raceId: room.id });
  triggerEvent("public-rooms-available", "room:participant_joined", { room_id: room.id, current_players: joinedCurrentPlayers }).catch(() => {});
  req.log.info({ raceId: room.id, userId, code: normalizedCode }, "[JoinWithCode] user joined private room");

  const newJoinParticipants = await db
    .select({
      id: raceParticipantsTable.id,
      userId: raceParticipantsTable.userId,
      username: profilesTable.username,
      country: profilesTable.country,
      countryFlag: profilesTable.countryFlag,
      avatarColor: profilesTable.avatarColor,
      avatarUrl: profilesTable.avatarUrl,
      updatedAt: profilesTable.updatedAt,
    })
    .from(raceParticipantsTable)
    .innerJoin(profilesTable, eq(raceParticipantsTable.userId, profilesTable.id))
    .where(and(
      eq(raceParticipantsTable.raceRoomId, room.id),
      ne(raceParticipantsTable.status, "left"),
    ));

  return res.status(201).json({
    success: true,
    room_id: room.id,
    entry_fee: room.entryAmountCents / 100,
    max_players: room.maxPlayers,
    is_private: room.isPrivate,
    status: room.status,
    participant_count: room.currentPlayers + 1,
    current_user_status: "joined",
    message: "Joined private room successfully.",
    participants: newJoinParticipants.map((p) => ({
      id: p.id,
      userId: p.userId,
      username: p.username,
      country: p.country ?? null,
      countryFlag: p.countryFlag ?? null,
      avatarColor: p.avatarColor ?? null,
      avatarUrl: p.avatarUrl ?? null,
      avatarVersion: p.updatedAt?.getTime() ?? 0,
      isHost: p.userId === room.creatorId,
      isCurrentUser: p.userId === userId,
      friendStatus: "none",
      friendRequestId: null,
      activeTitle: null,
      currentSteps: 0,
    })),
  });
});

// ── GET /api/races/:id ────────────────────────────────────────────────────────
router.get("/races/:id", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const raceId = String(req.params.id);

  const rows = await db
    .select()
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.id, raceId))
    .limit(1);

  if (!rows[0]) return res.status(404).json({ error: "Race not found" });
  let room = rows[0];

  // NOTE: No time-based self-healing here. Races end only when:
  //  a) required winners finish their goal (handled in POST /progress), or
  //  b) all participants forfeit (handled in POST /forfeit), or
  //  c) a scheduled end time is reached (handled by the scheduler), or
  //  d) fixed free/coins/cash hit the 24h max (cleanupOverdueRaces).
  // Do NOT end a race just because a short local timer elapsed.

  const isWaitingRoom = room.status === "open" || room.status === "full";

  // Base participant shape — extended for waiting rooms
  type BaseParticipant = {
    id: string;
    userId: string;
    currentSteps: number;
    status: string | null;
    rank: number | null;
    displayRank: number | null;
    prizeCents: number;
    prizeCoins: number;
    isTied: boolean;
    tieGroupSize: number;
    eligibleForPrize: boolean;
    username: string;
    country: string | null;
    countryFlag: string | null;
    avatarColor: string | null;
    avatarUrl: string | null;
    avatarVersion: number;
    isHost: boolean;
    isCurrentUser: boolean;
    friendStatus: string;
    friendRequestId: string | null;
    activeTitle: { code: string; title: string } | null;
  };

  let participantRows: BaseParticipant[];

  if (room.status === "completed") {
    const results = await db
      .select({
        participantId: raceParticipantsTable.id,
        userId: raceResultsTable.userId,
        steps: raceResultsTable.steps,
        rank: raceResultsTable.rank,
        displayRank: raceResultsTable.displayRank,
        prizeCents: raceResultsTable.prizeCents,
        prizeCoins: raceResultsTable.prizeCoins,
        isTied: raceResultsTable.isTied,
        tieGroupSize: raceResultsTable.tieGroupSize,
        eligibleForPrize: raceResultsTable.eligibleForPrize,
        username: profilesTable.username,
        country: profilesTable.country,
        countryFlag: profilesTable.countryFlag,
        avatarColor: profilesTable.avatarColor,
        avatarUrl: profilesTable.avatarUrl,
        updatedAt: profilesTable.updatedAt,
      })
      .from(raceResultsTable)
      .innerJoin(profilesTable, eq(raceResultsTable.userId, profilesTable.id))
      .leftJoin(
        raceParticipantsTable,
        and(eq(raceParticipantsTable.raceRoomId, raceId), eq(raceParticipantsTable.userId, raceResultsTable.userId)),
      )
      .where(eq(raceResultsTable.raceRoomId, raceId))
      .orderBy(asc(raceResultsTable.rank));

    const finishedUserIds = new Set(results.map((r) => r.userId));
    participantRows = results.map((r) => ({
      id: r.participantId ?? r.userId,
      userId: r.userId,
      currentSteps: r.steps,
      status: "finished",
      rank: r.rank,
      displayRank: r.displayRank ?? r.rank,
      prizeCents: r.prizeCents,
      prizeCoins: r.prizeCoins ?? 0,
      isTied: r.isTied,
      tieGroupSize: r.tieGroupSize,
      eligibleForPrize: r.eligibleForPrize,
      username: r.username,
      country: r.country ?? null,
      countryFlag: r.countryFlag ?? null,
      avatarColor: r.avatarColor ?? null,
      avatarUrl: r.avatarUrl ?? null,
      avatarVersion: r.updatedAt?.getTime() ?? 0,
      isHost: r.userId === room.creatorId,
      isCurrentUser: r.userId === userId,
      friendStatus: "none",
      friendRequestId: null,
      activeTitle: null,
    }));

    // Also include forfeited participants so they appear in results with red status
    const forfeitedRows = await db
      .select({
        id: raceParticipantsTable.id,
        userId: raceParticipantsTable.userId,
        finalSteps: raceParticipantsTable.finalSteps,
        username: profilesTable.username,
        country: profilesTable.country,
        countryFlag: profilesTable.countryFlag,
        avatarColor: profilesTable.avatarColor,
        avatarUrl: profilesTable.avatarUrl,
        updatedAt: profilesTable.updatedAt,
      })
      .from(raceParticipantsTable)
      .innerJoin(profilesTable, eq(raceParticipantsTable.userId, profilesTable.id))
      .where(and(
        eq(raceParticipantsTable.raceRoomId, raceId),
        eq(raceParticipantsTable.status, "forfeited"),
      ));

    for (const f of forfeitedRows) {
      if (finishedUserIds.has(f.userId)) continue;
      participantRows.push({
        id: f.id,
        userId: f.userId,
        currentSteps: f.finalSteps ?? 0,
        status: "forfeited",
        rank: participantRows.length + 1,
        displayRank: participantRows.length + 1,
        prizeCents: 0,
        prizeCoins: 0,
        isTied: false,
        tieGroupSize: 1,
        eligibleForPrize: false,
        username: f.username,
        country: f.country ?? null,
        countryFlag: f.countryFlag ?? null,
        avatarColor: f.avatarColor ?? null,
        avatarUrl: f.avatarUrl ?? null,
        avatarVersion: f.updatedAt?.getTime() ?? 0,
        isHost: f.userId === room.creatorId,
        isCurrentUser: f.userId === userId,
        friendStatus: "none",
        friendRequestId: null,
        activeTitle: null,
      });
    }
  } else {
    const participants = await db
      .select({
        id: raceParticipantsTable.id,
        userId: raceParticipantsTable.userId,
        currentSteps: raceParticipantsTable.currentSteps,
        status: raceParticipantsTable.status,
        rank: raceParticipantsTable.rank,
        finishedGoal: raceParticipantsTable.finishedGoal,
        finishedAt: raceParticipantsTable.finishedAt,
        username: profilesTable.username,
        country: profilesTable.country,
        countryFlag: profilesTable.countryFlag,
        avatarColor: profilesTable.avatarColor,
        avatarUrl: profilesTable.avatarUrl,
        updatedAt: profilesTable.updatedAt,
      })
      .from(raceParticipantsTable)
      .leftJoin(profilesTable, eq(raceParticipantsTable.userId, profilesTable.id))
      .where(and(eq(raceParticipantsTable.raceRoomId, raceId), ne(raceParticipantsTable.status, "left")))
      .orderBy(desc(raceParticipantsTable.currentSteps));

    const allParticipantRows = participants.map((p) => ({
      ...p,
      // Missing profile must not drop membership — keep stable participant id + userId.
      username: p.username?.trim() || "Walker",
      displayRank: p.rank ?? null,
      prizeCents: 0,
      prizeCoins: 0,
      isTied: false,
      tieGroupSize: 1,
      eligibleForPrize: false,
      country: p.country ?? null,
      countryFlag: p.countryFlag ?? null,
      avatarColor: p.avatarColor ?? null,
      avatarUrl: p.avatarUrl ?? null,
      avatarVersion: p.updatedAt?.getTime() ?? 0,
      isHost: p.userId === room.creatorId,
      isCurrentUser: p.userId === userId,
      friendStatus: "none",
      friendRequestId: null as string | null,
      activeTitle: null as { code: string; title: string } | null,
      finishedGoal: p.finishedGoal ?? false,
      finishedAt: p.finishedAt?.toISOString() ?? null,
    }));
    // Deduplicate by userId — same user may have multiple rows; keep highest steps
    const seenParticipantUsers = new Map<string, typeof allParticipantRows[number]>();
    for (const p of allParticipantRows) {
      const ex = seenParticipantUsers.get(p.userId);
      if (!ex || p.currentSteps > ex.currentSteps) {
        seenParticipantUsers.set(p.userId, p);
      }
    }
    participantRows = [...seenParticipantUsers.values()].sort((a, b) => b.currentSteps - a.currentSteps);

    // For sponsored in-progress races: auto-create participant if registered but missing from race_participants
    if (room.type === "sponsored" && room.status === "in_progress") {
      const alreadyIn = participantRows.some((p) => p.userId === userId);
      if (!alreadyIn) {
        const [reg] = await db
          .select({ id: scheduledRoomRegistrationsTable.id })
          .from(scheduledRoomRegistrationsTable)
          .where(and(
            eq(scheduledRoomRegistrationsTable.raceRoomId, raceId),
            eq(scheduledRoomRegistrationsTable.userId, userId),
            inArray(scheduledRoomRegistrationsTable.status, ["registered", "active"]),
          ))
          .limit(1);
        if (reg) {
          await db.transaction(async (tx) => {
            const lockedRoom = await lockRaceRoom(tx, raceId);
            if (!lockedRoom || lockedRoom.status !== "in_progress") return;
            const lockedReg = await lockScheduledRegistration(tx, raceId, userId);
            if (!lockedReg || (lockedReg.status !== "registered" && lockedReg.status !== "active")) return;

            const participantResult = await joinOrReviveParticipant(tx, {
              raceRoomId: raceId,
              userId,
              currentSteps: 0,
              raceBaselineSteps: 0,
            });
            if (participantResult.changed) {
              await tx.update(raceRoomsTable)
                .set({ currentPlayers: sql`${raceRoomsTable.currentPlayers} + 1`, updatedAt: new Date() })
                .where(eq(raceRoomsTable.id, raceId));
            }
          });
          req.log.info({ raceId, userId }, "[SponsoredRace] auto-created participant on GET");
          const [profile] = await db
            .select({
              username: profilesTable.username,
              country: profilesTable.country,
              countryFlag: profilesTable.countryFlag,
              avatarColor: profilesTable.avatarColor,
              avatarUrl: profilesTable.avatarUrl,
              updatedAt: profilesTable.updatedAt,
            })
            .from(profilesTable)
            .where(eq(profilesTable.id, userId))
            .limit(1);
          if (profile) {
            participantRows.push({
              id: "pending",
              userId,
              currentSteps: 0,
              status: "joined",
              rank: null,
              username: profile.username,
              country: profile.country ?? null,
              countryFlag: profile.countryFlag ?? null,
              avatarColor: profile.avatarColor ?? null,
              avatarUrl: profile.avatarUrl ?? null,
              avatarVersion: profile.updatedAt?.getTime() ?? 0,
              isHost: userId === room.creatorId,
              isCurrentUser: true,
              friendStatus: "self",
              friendRequestId: null,
              activeTitle: null,
              displayRank: null,
              prizeCents: 0,
              prizeCoins: 0,
              isTied: false,
              tieGroupSize: 1,
              eligibleForPrize: false,
            });
          }
        }
      }
    }

    // For waiting rooms: enrich with friendStatus and activeTitle
    if (isWaitingRoom && participantRows.length > 0) {
      const allIds = participantRows.map((p) => p.userId);
      const otherIds = allIds.filter((id) => id !== userId);

      const [friendRows, requestRows, titleRows] = await Promise.all([
        otherIds.length > 0
          ? db.select({ friendId: friendsTable.friendId }).from(friendsTable)
              .where(and(eq(friendsTable.userId, userId), inArray(friendsTable.friendId, otherIds)))
          : Promise.resolve([]),
        otherIds.length > 0
          ? db.select({ id: friendRequestsTable.id, senderId: friendRequestsTable.senderId, recipientId: friendRequestsTable.recipientId })
              .from(friendRequestsTable)
              .where(and(
                eq(friendRequestsTable.status, "pending"),
                or(
                  and(eq(friendRequestsTable.senderId, userId), inArray(friendRequestsTable.recipientId, otherIds)),
                  and(inArray(friendRequestsTable.senderId, otherIds), eq(friendRequestsTable.recipientId, userId)),
                ),
              ))
          : Promise.resolve([]),
        db.select({ userId: userTitlesTable.userId, code: achievementDefinitionsTable.code, title: achievementDefinitionsTable.title })
          .from(userTitlesTable)
          .innerJoin(achievementDefinitionsTable, eq(achievementDefinitionsTable.code, userTitlesTable.achievementCode))
          .where(and(eq(userTitlesTable.isActive, true), inArray(userTitlesTable.userId, allIds))),
      ]);

      const friendSet = new Set(friendRows.map((f) => f.friendId));
      const reqMap = new Map<string, { status: "pending_sent" | "pending_received"; id: string }>();
      for (const r of requestRows) {
        const otherId = r.senderId === userId ? r.recipientId : r.senderId;
        reqMap.set(otherId, { status: r.senderId === userId ? "pending_sent" : "pending_received", id: r.id });
      }
      const titleMap = new Map(titleRows.map((t) => [t.userId, { code: t.code, title: t.title }]));

      participantRows = participantRows.map((p) => {
        const isMe = p.userId === userId;
        return {
          ...p,
          friendStatus: isMe ? "self" : friendSet.has(p.userId) ? "friends" : (reqMap.get(p.userId)?.status ?? "none"),
          friendRequestId: isMe ? null : (reqMap.get(p.userId)?.id ?? null),
          activeTitle: titleMap.get(p.userId) ?? null,
        };
      });
    }
  }

  const { total: prizeTotal, winners: winnersPoolCents } = calcPrizePool(room.entryAmountCents, room.currentPlayers);
  const splits = getPrizeSplits(room.currentPlayers);
  const prizeTiers = splits.map((s) => parseFloat(((winnersPoolCents / 100) * s).toFixed(2)));
  const rewardSplit = buildRewardSplit(room.entryAmountCents, room.currentPlayers);
  const winnerCount = room.type === "sponsored" && room.status === "completed"
    ? participantRows.filter((p) => p.eligibleForPrize && p.prizeCents > 0).length
    : room.type === "sponsored"
      ? getSponsoredWinnerCount(room.currentPlayers)
      : numWinners(room.currentPlayers);
  const displayPrizePoolCents = room.type === "sponsored" ? getSponsoredPrizePoolCents(room.currentPlayers) : room.prizePoolCents;

  // Tie summary — derived from stored participant results for completed races
  const tieRulesApplied = room.status === "completed" && participantRows.some((p) => p.isTied);
  const totalAwarded = room.status === "completed"
    ? participantRows.reduce((sum, p) => sum + p.prizeCents, 0) / 100
    : 0;
  const unawardedAmount = room.unawardedAmountCents / 100;
  const mediaMap = await getTrackThemeMediaMap([room.trackLayout]);
  const trackTheme = trackThemeForCode(room.trackLayout, mediaMap);
  const challengeTime = buildChallengeTimeFields(room);

  return res.json({
    race: {
      ...room,
      ...challengeTime,
      trackTheme,
      imageSet: trackTheme.imageSet,
      trackThemeImageSet: trackTheme.imageSet,
      targetSteps: targetStepsForRoom(room),
      entryAmountDollars: room.entryAmountCents / 100,
      prizePool: room.type === "sponsored" ? displayPrizePoolCents / 100 : prizeTotal / 100,
      prizePoolCents: displayPrizePoolCents,
      winnersPool: room.type === "sponsored" ? displayPrizePoolCents / 100 : winnersPoolCents / 100,
      platformFee: 0,
      prizeTiers,
      rewardSplit,
      winnerCount,
      tieRulesApplied,
      totalAwarded,
      unawardedAmount,
      // ── Shared Waiting Room lifecycle surface (camelCase from ...room + snake_case aliases) ──
      canStart: computeCanStart(room),
      can_start: computeCanStart(room),
      minimumParticipants: room.minimumParticipants ?? config.waitingRoom.minimumParticipants,
      minParticipants: room.minimumParticipants ?? config.waitingRoom.minimumParticipants,
      minimum_participants: room.minimumParticipants ?? config.waitingRoom.minimumParticipants,
      min_players: room.minimumParticipants ?? config.waitingRoom.minimumParticipants,
      participantCount: room.currentPlayers,
      participant_count: room.currentPlayers,
      maximumParticipants: room.maxPlayers,
      roomCreatedAt: room.createdAt,
      room_created_at: room.createdAt,
      roomExpiresAt: room.roomExpiresAt,
      room_expires_at: room.roomExpiresAt,
      scheduled_start_at: room.scheduledStartAt,
      started_at: room.startedAt,
      cancellationReason: room.cancellationReason,
      cancellation_reason: room.cancellationReason,
      cancelReason: room.cancellationReason,
      cancelled_at: room.cancelledAt,
    },
    participants: participantRows.map((p) => ({
      ...p,
      prizeAmount: p.prizeCents / 100,
      isWinner: room.type === "sponsored"
        ? p.eligibleForPrize && p.prizeCents > 0
        : p.rank !== null && p.rank <= winnerCount,
    })),
  });
});

// ── POST /api/races/:id/progress ─────────────────────────────────────────────
async function respondWithLiveProgress(
  res: import("express").Response,
  raceId: string,
  userId: string,
  raceSteps: number,
  extra: Record<string, unknown> = {},
) {
  const ctx = await buildLiveRaceProgressContext(raceId, userId, raceSteps);
  if (!ctx) {
    return res.json({ success: true, steps: raceSteps, race_status: "unknown", ...extra });
  }
  if (ctx.raceStatus === "in_progress" && !extra.skipped) {
    void triggerLiveActivityUpdate(ctx);
  }
  return res.json(formatProgressSyncResponse(ctx, extra));
}

// ── Redis-live progress path (Phase 2 canary) ─────────────────────────────────
// Durable finish write at the deciding moment. finishRank == the server-acceptance ordinal
// assigned atomically in Redis (authoritative order), NOT a Postgres max()+1 which lock
// ordering could reorder. Reuses the existing finalization lock + autoCompleteRace.
async function persistRedisFinish(
  raceId: string,
  userId: string,
  finishOrdinal: number,
  steps: number,
  acceptedAtMs: number,
): Promise<void> {
  try {
    // Use the TRUE server-acceptance instant (when the goal-crossing tick was processed), not
    // persist time — so finishedAt-ordered payouts match the live finish order. Lock-acquisition
    // latency in this transaction must not reorder who gets paid.
    const finishedAtMs = acceptedAtMs;
    const result = await db.transaction(async (tx) => {
      const room = await lockRaceRoom(tx, raceId);
      if (!room || room.status !== "in_progress") return null;
      // Within-duration guard (§4/§11): drop a finish whose accepted instant is past the race end.
      const raceEndAt = deriveChallengeEndAt(room);
      if (raceEndAt && finishedAtMs > raceEndAt.getTime()) return null;
      const updated = await tx
        .update(raceParticipantsTable)
        .set({
          currentSteps: steps,
          finishedGoal: true,
          finishedAt: new Date(finishedAtMs),
          finishedAtMs,
          finishRank: finishOrdinal,
        })
        .where(and(
          eq(raceParticipantsTable.raceRoomId, raceId),
          eq(raceParticipantsTable.userId, userId),
          eq(raceParticipantsTable.finishedGoal, false),
        ))
        .returning({ id: raceParticipantsTable.id });
      if (updated.length === 0) return null; // already persisted
      const [{ finishedCount }] = await tx
        .select({ finishedCount: sql<number>`count(distinct ${raceParticipantsTable.userId})::int` })
        .from(raceParticipantsTable)
        .where(and(eq(raceParticipantsTable.raceRoomId, raceId), eq(raceParticipantsTable.finishedGoal, true)));
      const winnersNeeded =
        typeof room.winnerSlotCount === "number" && room.winnerSlotCount > 0
          ? room.winnerSlotCount
          : getWinnerSlotCount(
              room.startingParticipantCount ?? room.currentPlayers ?? 0,
            ) || numWinners(room.currentPlayers ?? 0);
      return { finishedCount, winnersNeeded };
    });
    if (!result) return;
    await markFinishOfficial(raceId, userId); // clear from pending set, mark official in Redis
    if (result.winnersNeeded > 0 && result.finishedCount >= result.winnersNeeded) {
      autoCompleteRace(raceId, "winners_finalized").catch(() => {});
    }
  } catch (err) {
    logger.error({ err, raceId, userId }, "[redisProgress] persistRedisFinish failed");
  }
}

function liveStatusToRaceStatus(status: string): string {
  return status === LIVE_RACE_STATE.FINALIZED ? "completed" : "in_progress";
}

/**
 * Recover finishes that were accepted in Redis (ordinal assigned, pending-finish recorded) but
 * whose durable Postgres write never landed — e.g. the API crashed between applyProgress and
 * persistRedisFinish. Without this, Postgres shows finishedGoal=false, so the
 * finishedCount>=numWinners early-finalization trigger undercounts and the race hangs until the
 * safety timeout. Runs periodically (worker) and is idempotent (persistRedisFinish no-ops if the
 * finish already landed; markFinishOfficial clears the pending entry).
 */
export async function recoverPendingRedisFinishes(): Promise<void> {
  if (!config.redis.liveUrl) return;
  const raceIds = await listActiveRaces();
  for (const raceId of raceIds) {
    try {
      if (!(await isRaceHydrated(raceId))) continue;
      const pending = await getPendingFinishes(raceId);
      if (pending.length === 0) continue;
      const states = await getParticipantsState(raceId, pending.map((f) => f.userId));
      for (let i = 0; i < pending.length; i += 1) {
        const f = pending[i];
        const steps = Number(states[i]?.currentSteps);
        const acceptedAtMs = Number(states[i]?.finishAcceptedAtMs) || Date.now();
        await persistRedisFinish(raceId, f.userId, f.ordinal, Number.isFinite(steps) ? steps : 0, acceptedAtMs);
      }
    } catch (err) {
      logger.error({ err, raceId }, "[redisProgress] recoverPendingRedisFinishes failed");
    }
  }
}

/**
 * Freeze a redis-mode race and flush its authoritative live state to Postgres BEFORE the
 * finalizer reads currentSteps for payout. Sequence: FROZEN (reject further ticks) → drain
 * pending finishes with their acceptance ordinal as finishRank → fenced UPSERT of steps
 * (never lowers a value). After this, autoCompleteRace runs unchanged on authoritative data.
 *
 * NOTE (canary): FINALIZING accepts no late samples — it goes straight to FROZEN (conservative
 * / strict). The bounded-grace window for timed races is a deferred refinement. If the flush
 * throws, we log loudly and let finalization proceed on the last checkpoint (steps only ever
 * move forward via GREATEST); productionizing should route an unflushable race to pending_review.
 */
async function flushRedisRaceToPostgres(raceId: string): Promise<void> {
  if (!(await isRaceHydrated(raceId))) return;
  await setRaceState(raceId, LIVE_RACE_STATE.FROZEN);

  const [snapshot, pending] = await Promise.all([snapshotRace(raceId), getPendingFinishes(raceId)]);
  const stepByUser = new Map(snapshot.map((s) => [s.userId, s.steps]));
  // True acceptance instant per pending finisher (falls back to now if absent).
  const pendingUserIds = pending.map((f) => f.userId);
  const pendingStates = await getParticipantsState(raceId, pendingUserIds);
  const acceptedAtByUser = new Map(
    pendingUserIds.map((uid, i) => [uid, Number(pendingStates[i]?.finishAcceptedAtMs) || Date.now()]),
  );

  await db.transaction(async (tx) => {
    for (const s of snapshot) {
      // Fenced: only advance steps, never lower a value already in Postgres.
      await tx
        .update(raceParticipantsTable)
        .set({ currentSteps: s.steps })
        .where(and(
          eq(raceParticipantsTable.raceRoomId, raceId),
          eq(raceParticipantsTable.userId, s.userId),
          lt(raceParticipantsTable.currentSteps, s.steps),
        ));
    }
    for (const f of pending) {
      const finishedAtMs = acceptedAtByUser.get(f.userId) ?? Date.now();
      await tx
        .update(raceParticipantsTable)
        .set({
          finishedGoal: true,
          finishRank: f.ordinal,
          finishedAt: new Date(finishedAtMs),
          finishedAtMs,
          ...(stepByUser.has(f.userId) ? { currentSteps: stepByUser.get(f.userId)! } : {}),
        })
        .where(and(
          eq(raceParticipantsTable.raceRoomId, raceId),
          eq(raceParticipantsTable.userId, f.userId),
          eq(raceParticipantsTable.finishedGoal, false),
        ));
    }
  });

  for (const f of pending) await markFinishOfficial(raceId, f.userId).catch(() => {});
}

/**
 * Handle a progress tick for a redis-mode race entirely off redis-live (zero SQL on the
 * normal path). Returns true when handled (response sent); false to fall through to the
 * legacy Postgres path (race is not redis-mode, or live state is unavailable → degraded).
 */
async function tryHandleRedisProgress(
  res: import("express").Response,
  args: {
    raceId: string;
    userId: string;
    steps: number;
    clientSeq: number | null;
    deviceTotal: number | null;
    srcLabel: string | null;
    devTime: Date | null;
    liveSessionId: string | null;
    liveSource: string | null;
  },
): Promise<boolean> {
  const { raceId, userId, steps, clientSeq, deviceTotal, srcLabel, devTime, liveSessionId, liveSource } = args;

  let cfg = await getRaceConfig(raceId).catch(() => null);
  if (!cfg) {
    // Either a Postgres-mode race (fall through) or a redis race whose keys were lost.
    const hydrated = await ensureRaceHydrated(raceId);
    if (!hydrated) return false;
    cfg = await getRaceConfig(raceId).catch(() => null);
    if (!cfg) return false;
  }

  if (cfg.status !== LIVE_RACE_STATE.ACTIVE) {
    // Finalizing/frozen/finalized: reject new steps, echo current standing (no acceptance).
    const rank = await getParticipantRank(raceId, userId).catch(() => null);
    await sendRedisProgressResponse(res, raceId, userId, cfg, rank?.steps ?? 0, { skipped: "not_active" });
    return true;
  }

  // Device-time skew guard (parity with the Postgres path).
  const nowMs = Date.now();
  if (devTime && Math.abs(nowMs - devTime.getTime()) > MAX_DEVICE_TIME_SKEW_MS) {
    res.status(400).json({ error: "deviceTime is outside the allowed skew window", code: "DEVICE_TIME_SKEW" });
    return true;
  }

  let result = await applyProgress({ raceId, userId, requestedSteps: steps, clientSeq, deviceTotal, nowMs, sessionId: liveSessionId, liveSource });
  if (!result.ok && result.reason === "not_hydrated") {
    // Participant not yet in live state (late join / sponsored auto-create / post-restart).
    // Hydrate them from Postgres once and retry; if they don't exist yet, fall through to the
    // Postgres path (which auto-creates them — the next tick then lands here).
    const added = await ensureParticipantHydrated(raceId, userId);
    if (!added) return false;
    result = await applyProgress({ raceId, userId, requestedSteps: steps, clientSeq, deviceTotal, nowMs, sessionId: liveSessionId, liveSource });
  }
  if (!result.ok) {
    if (result.reason === "not_active") {
      // Race was frozen for finalization between our checks — echo current standing, no accept.
      const rank = await getParticipantRank(raceId, userId).catch(() => null);
      await sendRedisProgressResponse(res, raceId, userId, cfg, rank?.steps ?? 0, { skipped: "not_active" });
      return true;
    }
    // Still not hydrated after a recovery attempt → degrade gracefully; client should retry.
    res.status(503).json({ status: "sync_degraded", retryable: true });
    return true;
  }

  // Reduced-volume audit (2i): only persist flagged events (simulation source / clamped
  // overage), never every tick. The finalization simulation-guard reads these rows; normal
  // ticks leave no audit row, avoiding millions of rows/day.
  if (srcLabel === "simulation" || result.pendingReconciliation) {
    void db.insert(raceStepSyncLogsTable).values({
      raceId,
      userId,
      stepSource: srcLabel,
      latestDeviceSteps: deviceTotal,
      calculatedProgress: steps,
      storedProgress: result.newSteps,
      suspicious: result.pendingReconciliation,
      reason: result.pendingReconciliation ? "rate_exceeded_cumulative" : "simulation_source",
      deviceTime: devTime,
    }).catch(() => { /* audit failures never affect the request */ });
  }

  if (result.justFinished && result.finishOrdinal != null) {
    await persistRedisFinish(raceId, userId, result.finishOrdinal, result.newSteps, nowMs);
    // Finish events are rare and important — always delivered (not coalesced).
    void triggerEvent(`public-live-race-${raceId}`, "participant_finished_goal", {
      participantId: result.participantId,
      userId,
      finishRank: result.finishOrdinal,
    });
  }

  const standings = await getStandingsWithNames(raceId, 20);
  const userRank = standings.find((s) => s.userId === userId)?.rank ?? 0;
  const updatedAt = new Date().toISOString();
  // Compact per-user delta always emits so peers never miss accepted progress.
  // Expensive leaderboard[] payloads remain coalesced via the broadcast lease.
  const includeLeaderboard = result.justFinished
    || (await tryAcquireBroadcastLease(raceId).catch(() => true));
  void triggerEvent(`public-live-race-${raceId}`, "race:progress_updated", {
    raceId,
    participantId: result.participantId,
    userId,
    steps: result.newSteps,
    progress: result.newSteps / Math.max(cfg.targetSteps, 1),
    rank: userRank,
    updatedAt,
    ...(includeLeaderboard ? { leaderboard: standings.slice(0, 20) } : {}),
  });

  await sendRedisProgressResponse(
    res,
    raceId,
    userId,
    cfg,
    result.newSteps,
    result.pendingReconciliation ? { pending_reconciliation: true } : {},
    standings,
  );
  return true;
}

/** Build the progress-sync response from redis-live state (no SQL), matching the legacy shape. */
async function sendRedisProgressResponse(
  res: import("express").Response,
  raceId: string,
  userId: string,
  cfg: NonNullable<Awaited<ReturnType<typeof getRaceConfig>>>,
  raceSteps: number,
  extra: Record<string, unknown>,
  standings?: Awaited<ReturnType<typeof getStandingsWithNames>>,
) {
  const board = standings ?? (await getStandingsWithNames(raceId, 20));
  const me = board.find((s) => s.userId === userId);
  const total = await getParticipantCount(raceId).catch(() => board.length);
  const ctx: LiveRaceProgressContext = {
    raceId,
    userId,
    username: me?.username ?? "Runner",
    raceSteps,
    rank: me?.rank ?? total,
    totalParticipants: total,
    goalSteps: cfg.targetSteps,
    timeLeftSeconds: cfg.challengeEndAtMs ? Math.max(0, Math.floor((cfg.challengeEndAtMs - Date.now()) / 1000)) : 0,
    raceStatus: liveStatusToRaceStatus(cfg.status),
    lastSyncedAt: new Date().toISOString(),
    leaderboard: board,
  };
  return res.json(formatProgressSyncResponse(ctx, extra));
}

// Participant reports their current race step count. Steps only ever increase.
// Optional fields (non-breaking):
//   sequenceId      — monotonic client counter; duplicate/stale syncs are silently
//                     skipped to prevent redundant DB writes.
//   deviceTotalSteps — device-wide total at sync time (baseline + anti-cheat).
//   stepSource      — "healthkit" | "health_connect" | "simulation"
//   deviceTime      — ISO-8601 UTC timestamp from the device at sync time.
router.post("/races/:id/progress", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const raceId = String(req.params.id);
  const { steps, sequenceId, deviceTotalSteps, stepSource, deviceTime, sessionId } = req.body as {
    steps?: unknown;
    sequenceId?: unknown;
    deviceTotalSteps?: unknown;
    stepSource?: unknown;
    deviceTime?: unknown;
    sessionId?: unknown;
  };

  if (typeof steps !== "number" || !Number.isFinite(steps) || steps < 0) {
    return res.status(400).json({ error: "steps must be a non-negative number" });
  }

  // Optional: client sequence counter for deduplication (integer ≥ 0)
  const clientSeq = (typeof sequenceId === "number" && Number.isInteger(sequenceId) && sequenceId >= 0)
    ? sequenceId
    : null;

  // Optional: full device total at sync time
  const deviceTotal = (typeof deviceTotalSteps === "number" && Number.isFinite(deviceTotalSteps))
    ? Math.floor(deviceTotalSteps)
    : null;

  // Optional: step source string for audit logs
  const srcLabel = typeof stepSource === "string" && stepSource.length > 0 ? stepSource : null;

  // Optional: device-reported sync timestamp
  const devTime = typeof deviceTime === "string" ? new Date(deviceTime) : null;

  // Optional live-tracking session id (§8). Only consulted under the hybrid flag; a change binds a
  // new device session and triggers baseline recovery without lowering accepted progress.
  const liveSessionId = config.features.hybridReconciliationEnabled
    && typeof sessionId === "string" && sessionId.length > 0
    ? sessionId.slice(0, 64)
    : null;
  // Normalized provisional live source for the live_source enum column (audit `srcLabel` is kept raw).
  const liveSource = config.features.hybridReconciliationEnabled ? toLiveStepSource(srcLabel) : null;

  // Redis-live canary: for redis-mode races, handle the tick entirely off redis-live (zero
  // SQL). Falls through to the legacy Postgres path for postgres-mode races or if unavailable.
  if (config.features.redisLiveRaceEnabled) {
    const handled = await tryHandleRedisProgress(res, { raceId, userId, steps, clientSeq, deviceTotal, srcLabel, devTime, liveSessionId, liveSource })
      .catch((err) => {
        req.log.error({ err, raceId, userId }, "[redisProgress] handler error — falling back to Postgres");
        return false;
      });
    if (handled) return;
  }

  // Fetch both participant and room in one shot
  const [[participant], [room]] = await Promise.all([
    db
      .select({
        id: raceParticipantsTable.id,
        status: raceParticipantsTable.status,
        currentSteps: raceParticipantsTable.currentSteps,
        finishedGoal: raceParticipantsTable.finishedGoal,
        lastStepSequenceId: raceParticipantsTable.lastStepSequenceId,
        raceBaselineSteps: raceParticipantsTable.raceBaselineSteps,
        lastStepSyncAt: raceParticipantsTable.lastStepSyncAt,
        liveSessionId: raceParticipantsTable.liveSessionId,
      })
      .from(raceParticipantsTable)
      .where(and(eq(raceParticipantsTable.raceRoomId, raceId), eq(raceParticipantsTable.userId, userId)))
      .orderBy(desc(raceParticipantsTable.currentSteps))
      .limit(1),
    db
      .select({
        status: raceRoomsTable.status,
        startedAt: raceRoomsTable.startedAt,
        targetSteps: raceRoomsTable.targetSteps,
        currentPlayers: raceRoomsTable.currentPlayers,
        type: raceRoomsTable.type,
        challengeDurationDays: raceRoomsTable.challengeDurationDays,
        challengeEndAt: raceRoomsTable.challengeEndAt,
        scheduledStartAt: raceRoomsTable.scheduledStartAt,
      })
      .from(raceRoomsTable)
      .where(eq(raceRoomsTable.id, raceId))
      .limit(1),
  ]);

  // For sponsored races: auto-create participant if they are registered but weren't
  // inserted when the race started (e.g. server restarted between race start and first sync).
  let participantData = participant;
  if (!participantData && room?.status === "in_progress" && room?.type === "sponsored") {
    const [reg] = await db
      .select({ id: scheduledRoomRegistrationsTable.id })
      .from(scheduledRoomRegistrationsTable)
      .where(and(
        eq(scheduledRoomRegistrationsTable.raceRoomId, raceId),
        eq(scheduledRoomRegistrationsTable.userId, userId),
        inArray(scheduledRoomRegistrationsTable.status, ["registered", "active"]),
      ))
      .limit(1);

    if (reg) {
      await db.transaction(async (tx) => {
        const lockedRoom = await lockRaceRoom(tx, raceId);
        if (!lockedRoom || lockedRoom.status !== "in_progress") return;
        const lockedReg = await lockScheduledRegistration(tx, raceId, userId);
        if (!lockedReg || (lockedReg.status !== "registered" && lockedReg.status !== "active")) return;

        const participantResult = await joinOrReviveParticipant(tx, {
          raceRoomId: raceId,
          userId,
          currentSteps: 0,
          raceBaselineSteps: 0,
          latestDeviceSteps: deviceTotal,
        });
        if (participantResult.changed) {
          await tx.update(raceRoomsTable)
            .set({ currentPlayers: sql`${raceRoomsTable.currentPlayers} + 1`, updatedAt: new Date() })
            .where(eq(raceRoomsTable.id, raceId));
        }
      });

      const newPRows = await db
        .select({
          id: raceParticipantsTable.id,
          status: raceParticipantsTable.status,
          currentSteps: raceParticipantsTable.currentSteps,
          finishedGoal: raceParticipantsTable.finishedGoal,
          lastStepSequenceId: raceParticipantsTable.lastStepSequenceId,
          raceBaselineSteps: raceParticipantsTable.raceBaselineSteps,
          lastStepSyncAt: raceParticipantsTable.lastStepSyncAt,
          liveSessionId: raceParticipantsTable.liveSessionId,
        })
        .from(raceParticipantsTable)
        .where(and(eq(raceParticipantsTable.raceRoomId, raceId), eq(raceParticipantsTable.userId, userId)))
        .orderBy(desc(raceParticipantsTable.currentSteps))
        .limit(1);

      participantData = newPRows[0];
      req.log.info({ raceId, userId }, "[SponsoredRace] auto-created participant from registration on first sync");
    }
  }

  if (!participantData) return res.status(404).json({ error: "Participant not found" });

  // ── Forfeit / removal guard (§12/§23) ─────────────────────────────────────
  // Once a participant has forfeited, left, or been disqualified, no race-step update is
  // accepted for this race — including queued/delayed syncs. Their verified race-step history
  // is preserved; only new writes are blocked. (Daily-step sync is a separate endpoint.)
  if (
    participantData.status === "forfeited"
    || participantData.status === "left"
    || participantData.status === "disqualified"
  ) {
    req.log.info(
      { raceId, userId, status: participantData.status },
      "[StepSync] rejected — participant no longer active in this race",
    );
    return res.status(409).json({
      error: "You are no longer an active participant in this race.",
      participant_status: participantData.status,
    });
  }

  // ── Session change (§8): device reboot / reinstall / sensor-session rotation ──
  // A new sessionId is baseline recovery, NOT a reset: reset the sequence counter and baseline so
  // the new session re-registers from its next deviceTotal, but never lower currentSteps (the
  // monotonic max below preserves accepted progress). Scoped to (raceId, userId) — a session id
  // minted for another race/user is simply a "new" session here and can never import steps.
  const sessionChanged = liveSessionId !== null
    && participantData.liveSessionId != null
    && participantData.liveSessionId !== liveSessionId;
  if (sessionChanged) {
    req.log.info(
      { raceId, userId, oldSession: participantData.liveSessionId, newSession: liveSessionId },
      "[StepSync] live session changed — baseline recovery, progress preserved",
    );
    // Multi-device conflict signal (§18): a session flip within seconds of the last sync suggests
    // two devices alternating rather than a genuine reboot. We never combine device totals; we flag
    // it for review via an audit row. The replacement still preserves accepted progress.
    const lastSyncMs = participantData.lastStepSyncAt ? participantData.lastStepSyncAt.getTime() : 0;
    if (lastSyncMs > 0 && Date.now() - lastSyncMs < 5_000) {
      req.log.warn({ raceId, userId }, "[StepSync] rapid live-session switch — possible multi-device conflict");
      void db.insert(raceStepSyncLogsTable).values({
        raceId, userId, stepSource: srcLabel, suspicious: true, reason: "session_conflict", deviceTime: devTime,
      }).catch(() => { /* audit best-effort */ });
      // Flag the participant so the finalization reconciliation pass routes them to review (§18):
      // simultaneous conflicting sessions must never auto-finalize on a possibly-tainted total.
      void db.update(raceParticipantsTable)
        .set({ reconciliationReasonCodes: ["session_conflict"] })
        .where(and(
          eq(raceParticipantsTable.raceRoomId, raceId),
          eq(raceParticipantsTable.userId, userId),
          ne(raceParticipantsTable.reconciliationStatus, "finalized"),
        ))
        .catch(() => {});
    }
    participantData.lastStepSequenceId = 0;
    participantData.raceBaselineSteps = 0;
  }

  // ── Sequence-ID deduplication ─────────────────────────────────────────────
  // Skip this sync if the client sent a sequence counter ≤ the one already
  // stored. Prevents redundant DB writes on duplicate / retry requests.
  // Skipped on a legitimate session change (its counter legitimately restarts).
  if (!sessionChanged && clientSeq !== null && clientSeq <= (participantData.lastStepSequenceId ?? 0)) {
    req.log.debug(
      { raceId, userId, clientSeq, lastSeq: participantData.lastStepSequenceId },
      "[StepSync] skipped — duplicate sequenceId",
    );
    return respondWithLiveProgress(res, raceId, userId, participantData.currentSteps, {
      skipped: "duplicate_sequence",
    });
  }

  if (room && room.status !== "in_progress") {
    return respondWithLiveProgress(res, raceId, userId, participantData.currentSteps);
  }

  const nowMs = Date.now();
  if (devTime && Math.abs(nowMs - devTime.getTime()) > MAX_DEVICE_TIME_SKEW_MS) {
    req.log.warn({ raceId, userId, deviceTime, serverTime: new Date(nowMs).toISOString() }, "[RaceStepsSync] rejected due to device time skew");
    return res.status(400).json({
      error: "deviceTime is outside the allowed skew window",
      code: "DEVICE_TIME_SKEW",
    });
  }

  // NOTE: the per-sync delta cap is enforced *after* baseline/backfill resolution as a
  // cumulative budget (see "Cumulative rate cap" below), so it bounds the final stored
  // total — including backend-derived recovery — rather than a single tick's delta.
  let newSteps = Math.max(participantData.currentSteps, Math.floor(steps));
  const targetSteps = room ? targetStepsForRoom(room) : 0;

  // ── Baseline registration + backend-derived step recovery ──────────────────
  // When deviceTotalSteps is included in the sync payload:
  //  • First sync ever  → register deviceTotal as the race baseline (stored
  //    once, never overwritten).
  //  • Subsequent syncs → derive race-relative progress as
  //    (deviceTotal − baseline) and take the higher of that vs client-reported
  //    steps.  This corrects progress after app close/reopen, where the
  //    client-side race counter may have reset to 0.
  let baselineToStore: number | null = null;
  const existingBaseline = participantData.raceBaselineSteps ?? 0;
  if (deviceTotal !== null) {
    if (existingBaseline === 0) {
      baselineToStore = deviceTotal;
      req.log.info({ raceId, userId, baseline: deviceTotal }, "[RaceBaseline] baseline stored");
    } else {
      const backendDerived = Math.max(0, deviceTotal - existingBaseline);
      if (backendDerived > newSteps) {
        req.log.info(
          { raceId, userId, backendDerived, existingBaseline, deviceTotal, clientSteps: Math.floor(steps) },
          "[RaceStepsSync] using backend-derived steps from deviceTotal",
        );
        newSteps = backendDerived;
      } else {
        req.log.info(
          { raceId, userId, existingBaseline },
          "[RaceBaseline] existing baseline reused",
        );
      }
    }
  } else if (existingBaseline === 0) {
    req.log.info({ raceId, userId }, "[RaceBaseline] baseline null — awaiting deviceTotalSteps");
  }

  const baselineNeedsRegistration = baselineToStore !== null;

  // ── Elapsed time + suspicious early-jump detection ────────────────────────
  const elapsedSeconds = room?.startedAt
    ? Math.max(0, (nowMs - room.startedAt.getTime()) / 1000)
    : 0;
  // 3 steps/second = 180 spm — faster than any realistic walking pace.
  const earlyJumpThreshold = Math.ceil(elapsedSeconds * 3);
  const suspiciousEarlyJump = elapsedSeconds < 60 && newSteps > earlyJumpThreshold && newSteps > 0;
  const suspiciousReason = suspiciousEarlyJump
    ? `early_large_step_jump: ${newSteps} steps in ${elapsedSeconds.toFixed(1)}s (threshold ${earlyJumpThreshold})`
    : null;

  if (suspiciousEarlyJump) {
    req.log.warn(
      { raceId, userId, newSteps, elapsedSeconds, earlyJumpThreshold, srcLabel },
      "[RaceStepsSync] suspicious early jump",
    );
  }

  // ── Cumulative rate cap (anti-cheat) ──────────────────────────────────────
  // Bound the participant's TOTAL steps by the plausible race-time budget. This
  // replenishes at MAX_PROGRESS_STEPS_PER_SECOND and carries forward, so it cannot
  // be defeated by a per-tick allowance. Overage (including implausible offline
  // backfill) is clamped to the max and flagged for reconciliation rather than
  // trusted. Skipped only when race start time is unknown (cannot judge plausibility).
  const rawNewSteps = newSteps;
  let pendingReconciliation = false;
  if (room?.startedAt) {
    const maxCumulativeSteps =
      Math.ceil(elapsedSeconds * MAX_PROGRESS_STEPS_PER_SECOND) + MAX_PROGRESS_BURST;
    if (newSteps > maxCumulativeSteps) {
      pendingReconciliation = true;
      newSteps = Math.max(participantData.currentSteps, maxCumulativeSteps);
      req.log.warn(
        { raceId, userId, rawNewSteps, clampedTo: newSteps, maxCumulativeSteps, elapsedSeconds, srcLabel },
        "[RaceStepsSync] steps exceeded cumulative budget — clamped, pending reconciliation",
      );
    }
  }

  req.log.info(
    {
      raceId,
      userId,
      latestDeviceSteps: deviceTotal,
      baselineSteps: baselineToStore ?? existingBaseline,
      calculatedProgress: newSteps,
      targetSteps,
      elapsedSeconds,
      srcLabel,
    },
    "[RaceStepsSync] step sync received",
  );

  // Skip no-change writes — saves a DB round-trip. A session change must still persist the new
  // binding, so it is never treated as a no-op.
  if (newSteps === participantData.currentSteps && clientSeq === null && !baselineNeedsRegistration && !sessionChanged) {
    return respondWithLiveProgress(res, raceId, userId, newSteps, { skipped: "no_change" });
  }

  // Sync-time columns to persist on every accepted write
  const syncCols = {
    lastStepSyncAt: new Date(),
    ...(clientSeq !== null ? { lastStepSequenceId: clientSeq } : {}),
    // On a session change with no client sequence, clear the stored counter so the new session's
    // lower sequence numbers are not rejected as stale on the next tick.
    ...(sessionChanged && clientSeq === null ? { lastStepSequenceId: 0 } : {}),
    ...(baselineToStore !== null ? { raceBaselineSteps: baselineToStore } : {}),
    ...(deviceTotal !== null ? { latestDeviceSteps: deviceTotal } : {}),
    // Hybrid live annotations (only when the flag surfaced a value; otherwise omitted → no-op).
    ...(liveSessionId !== null ? { liveSessionId } : {}),
    ...(liveSource !== null ? { liveSource } : {}),
  };

  // Fire-and-forget audit log — never block the response on this
  void db.insert(raceStepSyncLogsTable).values({
    raceId,
    userId,
    stepSource: srcLabel,
    raceStartedAt: room?.startedAt ?? null,
    baselineSteps: baselineToStore ?? (existingBaseline > 0 ? existingBaseline : null),
    latestDeviceSteps: deviceTotal,
    calculatedProgress: rawNewSteps,
    storedProgress: Math.max(participantData.currentSteps, newSteps),
    suspicious: suspiciousEarlyJump || pendingReconciliation,
    reason: [
      suspiciousReason,
      pendingReconciliation ? `rate_exceeded_cumulative: raw ${rawNewSteps} clamped ${newSteps}` : null,
    ].filter(Boolean).join("; ") || null,
    deviceTime: devTime,
  }).catch(() => { /* audit log failures must never affect the main request */ });

  // Detect first-time goal crossing: steps increased AND now >= target AND not already finished
  const justFinishedGoal =
    newSteps > participantData.currentSteps &&
    targetSteps > 0 &&
    newSteps >= targetSteps &&
    !participantData.finishedGoal;

  if (newSteps > participantData.currentSteps) {
    if (justFinishedGoal) {
      const finishedAtMs = Date.now();
      const updated = await db.transaction(async (tx) => {
        const lockedRoom = await lockRaceRoom(tx, raceId);
        if (!lockedRoom) return null;

        // ── Within-duration guard (§4/§11) ─────────────────────────────────────
        // Record a goal completion ONLY while the race is live and the target was
        // reached at/before the race end time. A late tick after the race ended (but
        // before finalization flips status) must not create a completer.
        if (lockedRoom.status !== "in_progress") return null;
        const raceEndAt = deriveChallengeEndAt(lockedRoom);
        if (raceEndAt && finishedAtMs > raceEndAt.getTime()) return null;

        const [lockedParticipant] = await tx
          .select({
            id: raceParticipantsTable.id,
            finishedGoal: raceParticipantsTable.finishedGoal,
          })
          .from(raceParticipantsTable)
          .where(eq(raceParticipantsTable.id, participantData.id))
          .limit(1)
          .for("update");

        if (!lockedParticipant || lockedParticipant.finishedGoal) {
          return null;
        }

        const [rankRow] = await tx
          .select({ maxRank: sql<number>`coalesce(max(${raceParticipantsTable.finishRank}), 0)::int` })
          .from(raceParticipantsTable)
          .where(eq(raceParticipantsTable.raceRoomId, raceId));
        const computedFinishRank = (rankRow?.maxRank ?? 0) + 1;

        const [nextParticipant] = await tx
          .update(raceParticipantsTable)
          .set({
            currentSteps: newSteps,
            finishedGoal: true,
            finishedAt: new Date(finishedAtMs),
            finishedAtMs,
            finishRank: computedFinishRank,
            ...syncCols,
          })
          .where(and(
            eq(raceParticipantsTable.id, participantData.id),
            eq(raceParticipantsTable.finishedGoal, false),
          ))
          .returning({ finishRank: raceParticipantsTable.finishRank });

        if (!nextParticipant) {
          return null;
        }

        const [finishedCountRow] = await tx
          .select({ cnt: sql<number>`count(distinct ${raceParticipantsTable.userId})::int` })
          .from(raceParticipantsTable)
          .where(and(
            eq(raceParticipantsTable.raceRoomId, raceId),
            eq(raceParticipantsTable.finishedGoal, true),
          ));

        const winnersNeeded =
          typeof lockedRoom.winnerSlotCount === "number" && lockedRoom.winnerSlotCount > 0
            ? lockedRoom.winnerSlotCount
            : getWinnerSlotCount(
                lockedRoom.startingParticipantCount ?? lockedRoom.currentPlayers ?? 2,
              ) || numWinners(lockedRoom.currentPlayers ?? 2);

        return {
          finishRank: nextParticipant.finishRank ?? computedFinishRank,
          finishedCount: finishedCountRow?.cnt ?? 0,
          playerCount: lockedRoom.currentPlayers ?? 2,
          winnersNeeded,
        };
      });

      if (updated) {
        const actualRank = updated.finishRank;

        // Fetch username for broadcast
        const [profile] = await db
          .select({ username: profilesTable.username })
          .from(profilesTable)
          .where(eq(profilesTable.id, userId))
          .limit(1);
        const username = profile?.username ?? "Runner";

        req.log.info(
          { raceId, userId, username, finishRank: actualRank, currentSteps: newSteps, targetSteps },
          "[RaceFinish] participant reached goal",
        );

        const standings = await getLiveRaceStandings(raceId);
        const userRank = standings.find((s) => s.userId === userId)?.rank ?? 0;

        // Broadcast progress + goal completion in parallel
        await Promise.all([
          triggerEvent(`public-live-race-${raceId}`, "race:progress_updated", {
            raceId,
            participantId: participantData.id,
            userId,
            steps: newSteps,
            progress: newSteps / Math.max(targetSteps, 1),
            rank: userRank,
            updatedAt: new Date().toISOString(),
            leaderboard: standings.slice(0, 20),
          }),
          triggerEvent(`public-live-race-${raceId}`, "participant_finished_goal", {
            raceId,
            userId,
            username,
            currentSteps: newSteps,
            targetSteps,
            finishRank: actualRank,
            finishedAt: new Date().toISOString(),
          }),
        ]);

        // ── Early finalization: end race when required winner slots are filled ──
        // Slots frozen at start: 2→1, 3→2, 4–10→3 (free / coins / cash).
        const playerCount = updated.playerCount;
        const winnersNeeded = updated.winnersNeeded;
        const finishedCount = updated.finishedCount;

        req.log.info(
          { raceId, finishedCount, winnersNeeded, playerCount },
          "[RaceFinalize] winner_slots_finalized: %d/%d playerCount: %d",
          finishedCount, winnersNeeded, playerCount,
        );

        const durationCompletion = room
          ? canAutoCompleteDurationChallenge(room, "winners_finalized")
          : { allowed: true, challengeEndAt: null };

        if (finishedCount >= winnersNeeded) {
          // Winner slots always finalize immediately (including multi-day rooms).
          req.log.info({ raceId, finishedCount, winnersNeeded }, "[RaceFinalize] all winner slots filled — triggering immediate finalization");
          autoCompleteRace(raceId, "winners_finalized").catch((err) => {
            req.log.error({ raceId, err }, "[RaceFinalize] early autoCompleteRace failed");
          });
        } else if (!durationCompletion.allowed) {
          req.log.info(
            { raceId, finishedCount, winnersNeeded, challengeEndAt: durationCompletion.challengeEndAt?.toISOString() ?? null },
            "[RaceFinalize] duration challenge — waiting for more finishers or challenge end",
          );
        }
      }
    } else {
      // Normal step update — no goal crossing
      await db
        .update(raceParticipantsTable)
        .set({ currentSteps: newSteps, ...syncCols })
        .where(eq(raceParticipantsTable.id, participantData.id));

      const standings = await getLiveRaceStandings(raceId);
      const userRank = standings.find((s) => s.userId === userId)?.rank ?? 0;

      await triggerEvent(`public-live-race-${raceId}`, "race:progress_updated", {
        raceId,
        participantId: participantData.id,
        userId,
        steps: newSteps,
        progress: newSteps / Math.max(targetSteps, 1),
        rank: userRank,
        updatedAt: new Date().toISOString(),
        leaderboard: standings.slice(0, 20),
      });
    }
  }

  return respondWithLiveProgress(
    res,
    raceId,
    userId,
    newSteps,
    pendingReconciliation ? { pending_reconciliation: true } : {},
  );
});

// ── GET /api/races/:id/leaderboard ───────────────────────────────────────────
router.get("/races/:id/leaderboard", requireAuth, async (req, res) => {
  const raceId = String(req.params.id);
  const [room] = await db
    .select({ status: raceRoomsTable.status, type: raceRoomsTable.type, targetSteps: raceRoomsTable.targetSteps, challengeEndAt: raceRoomsTable.challengeEndAt })
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.id, raceId))
    .limit(1);
  if (!room) return res.status(404).json({ error: "Race not found" });

  const leaderboard = await getLiveRaceStandings(raceId);
  const timeLeftSeconds = room.challengeEndAt
    ? Math.max(0, Math.floor((room.challengeEndAt.getTime() - Date.now()) / 1000))
    : 0;

  return res.json({
    success: true,
    raceId,
    raceStatus: room.status,
    goalSteps: targetStepsForRoom(room),
    timeLeftSeconds,
    leaderboard,
    updatedAt: new Date().toISOString(),
  });
});

// ── POST /api/races/:id/live-activity/register ────────────────────────────────
router.post("/races/:id/live-activity/register", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const raceId = String(req.params.id);
  const parsed = z
    .object({
      activityId: z.string().min(1),
      pushToken: z.string().min(1),
      platform: z.enum(["ios", "android"]).default("ios"),
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }

  const { activityId, pushToken, platform } = parsed.data;

  const [participant] = await db
    .select({ id: raceParticipantsTable.id })
    .from(raceParticipantsTable)
    .where(and(eq(raceParticipantsTable.raceRoomId, raceId), eq(raceParticipantsTable.userId, userId)))
    .limit(1);
  if (!participant) return res.status(404).json({ error: "Participant not found" });

  await db
    .insert(liveActivityTokensTable)
    .values({ raceId, userId, activityId, pushToken, platform, status: "active" })
    .onConflictDoUpdate({
      target: [liveActivityTokensTable.raceId, liveActivityTokensTable.userId],
      set: {
        activityId,
        pushToken,
        platform,
        status: "active",
        updatedAt: new Date(),
      },
    });

  req.log.info({ raceId, userId, activityId }, "[LiveActivity] token registered");
  return res.json({ success: true });
});

// ── POST /api/races/:id/reconcile-steps ──────────────────────────────────────
// Allows a participant to submit HealthKit-verified steps after their app
// was closed/killed during a race. Accepted within 10 minutes of race completion.
// Only updates the result if the submitted steps are HIGHER than what was stored.
router.post("/races/:id/reconcile-steps", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const raceId = String(req.params.id);

  const reconcileSchema = z.object({
    steps: z.number().int().min(0).max(500000),
    source: z.enum(["healthkit", "health_connect", "pedometer"]).default("pedometer"),
    // Additive hybrid verification fields (§12/§13). Ignored unless the hybrid flag is on AND at
    // least one of these is present; otherwise the endpoint behaves exactly as before.
    verificationSource: z.enum(["healthkit", "health_connect"]).optional(),
    measuredAtStart: z.string().datetime().optional(),
    measuredAtEnd: z.string().datetime().optional(),
  });

  const parsed = reconcileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid reconcile data", details: parsed.error.issues });
  }

  const { steps, source } = parsed.data;
  const wantsHybridVerification = config.features.hybridReconciliationEnabled
    && (parsed.data.verificationSource != null || parsed.data.measuredAtEnd != null);

  // Fetch race and existing result in parallel
  const [[room], [existingResult]] = await Promise.all([
    db
      .select({ status: raceRoomsTable.status, completedAt: raceRoomsTable.completedAt, startedAt: raceRoomsTable.startedAt })
      .from(raceRoomsTable)
      .where(eq(raceRoomsTable.id, raceId))
      .limit(1),
    db
      .select({ id: raceResultsTable.id, steps: raceResultsTable.steps, rank: raceResultsTable.rank })
      .from(raceResultsTable)
      .where(and(eq(raceResultsTable.raceRoomId, raceId), eq(raceResultsTable.userId, userId)))
      .limit(1),
  ]);

  if (!room) return res.status(404).json({ error: "Race not found" });
  if (room.status !== "completed") return res.status(409).json({ error: "Race is not yet completed" });

  // Only accept reconciliation within 10 minutes of race completion
  const completedAt = room.completedAt ? new Date(room.completedAt) : null;
  if (!completedAt || Date.now() - completedAt.getTime() > 10 * 60_000) {
    return res.status(409).json({ error: "Reconciliation window has expired" });
  }

  if (!existingResult) {
    // User was not in race results — nothing to reconcile
    return res.status(404).json({ error: "No race result found for this participant" });
  }

  // Authoritative bound: the live-progress sync enforces a strict per-second
  // delta cap during the race, so the server already holds the true running
  // total in raceParticipantsTable. Reconciliation may only nudge the recorded
  // steps UP toward that server-tracked value — never past it. Previously the
  // only cap was a duration-derived ceiling (10 steps/s for the whole race),
  // which let a finisher who barely walked claim the ceiling and get "verified".
  const [participant] = await db
    .select({ currentSteps: raceParticipantsTable.currentSteps, finalSteps: raceParticipantsTable.finalSteps })
    .from(raceParticipantsTable)
    .where(and(eq(raceParticipantsTable.raceRoomId, raceId), eq(raceParticipantsTable.userId, userId)))
    .limit(1);

  const serverSteps = Math.max(participant?.currentSteps ?? 0, participant?.finalSteps ?? 0);

  // ── Hybrid verification ingestion (§12/§13/§14) ───────────────────────────────
  // When the client submits a verified Health Connect / HealthKit total, persist it separately
  // from live progress and run the reconciliation policy. Unlike the legacy path, a verified
  // total that exceeds server-tracked live steps is NOT hard-rejected — it is routed to review by
  // the policy (possible backfill), so a legitimate offline device backfill is not silently lost.
  if (wantsHybridVerification) {
    const result = reconcileParticipant({
      liveSteps: serverSteps,
      verifiedSteps: steps,
      raceEndedAtMs: completedAt.getTime(),
      nowMs: Date.now(),
      tolerances: config.hybridReconciliation,
    });

    // Persist verified values + reconciliation outcome on the participant (idempotent: never
    // overwrite a row already consumed by settlement).
    await db
      .update(raceParticipantsTable)
      .set({
        verifiedCumulativeSteps: steps,
        verificationSource: parsed.data.verificationSource ?? source,
        verifiedMeasuredAt: parsed.data.measuredAtEnd ? new Date(parsed.data.measuredAtEnd) : new Date(),
        verifiedUpdatedAt: new Date(),
        reconciledSteps: result.reconciledSteps,
        reconciliationStatus: result.status,
        reconciledAt: new Date(result.reconciledAtUtc),
        reconciliationReasonCodes: result.reasonCodes,
      })
      .where(and(
        eq(raceParticipantsTable.raceRoomId, raceId),
        eq(raceParticipantsTable.userId, userId),
        ne(raceParticipantsTable.reconciliationStatus, "finalized"),
      ));

    // Mirror the outcome onto the settled result row for display. Only a matched / within-tolerance
    // reconciliation marks the recorded steps "verified"; delayed/review stay pending_verification.
    // This never re-issues a payout (that already ran at completion and is idempotency-guarded).
    const verifiedOutcome = result.status === "matched" || result.status === "within_tolerance";
    const resultSteps = verifiedOutcome
      ? Math.max(existingResult.steps, result.reconciledSteps)
      : existingResult.steps;
    const resultStatus = verifiedOutcome ? "verified" : "pending_verification";
    await db
      .update(raceResultsTable)
      .set({
        steps: resultSteps,
        status: resultStatus,
        reconciliationStatus: result.status,
        authoritativeStepSource: verifiedOutcome ? "reconciled" : "live",
      })
      .where(and(eq(raceResultsTable.raceRoomId, raceId), eq(raceResultsTable.userId, userId)));

    req.log.info(
      { raceId, userId, verifiedSteps: steps, liveSteps: serverSteps, reconciledSteps: result.reconciledSteps,
        status: result.status, reasonCodes: result.reasonCodes },
      "race steps reconciled (hybrid)",
    );

    // Emit the verification-status-changed event (§20) — no raw health data, only status.
    void triggerEvent(`public-live-race-${raceId}`, "participant:verification_status_changed", {
      userId,
      reconciliationStatus: result.status,
      reconciledSteps: result.reconciledSteps,
    });
    if (result.status === "review_required") {
      void triggerEvent(`public-live-race-${raceId}`, "race:review_required", { userId });
    }

    return res.json({
      reconciled: resultSteps > existingResult.steps,
      steps: resultSteps,
      rank: existingResult.rank,
      reconciliationStatus: result.status,
    });
  }

  // ── Legacy reconcile path (flag off, or no verification fields) ────────────────
  const RECONCILE_TOLERANCE = 100; // absorb a few last un-synced steps
  const serverCap = serverSteps + RECONCILE_TOLERANCE;
  if (steps > serverCap) {
    req.log.warn({ raceId, userId, steps, serverSteps }, "reconcile rejected: exceeds server-tracked steps");
    return res.status(400).json({ error: "Step count exceeds server-tracked progress for this race." });
  }

  // Only update if submitted steps are higher than stored value
  if (steps <= existingResult.steps) {
    return res.json({ reconciled: false, steps: existingResult.steps, reason: "Stored steps are already higher" });
  }

  // "verified" requires server-side evidence (continuous synced progress that
  // covers the reconciled value) — NOT the client-supplied source field.
  const status = serverSteps > 0 && steps <= serverCap ? "verified" : "pending_verification";

  await db
    .update(raceResultsTable)
    .set({ steps, status })
    .where(and(eq(raceResultsTable.raceRoomId, raceId), eq(raceResultsTable.userId, userId)));

  req.log.info({ raceId, userId, steps, source, serverSteps, status, prev: existingResult.steps }, "race steps reconciled");
  return res.json({ reconciled: true, steps, rank: existingResult.rank });
});

// ── POST /api/races/:id/verify ────────────────────────────────────────────────
// Periodic VERIFIED race-window total from Health Connect / HealthKit (§12). Stored separately
// from provisional live progress; it never overwrites live state and does not itself reconcile —
// reconciliation runs at finalization (§14/§15). Flag-gated: 404 when hybrid reconciliation is off,
// so the surface is invisible until the feature is enabled. No raw health records are accepted.
router.post("/races/:id/verify", requireAuth, async (req, res) => {
  if (!config.features.hybridReconciliationEnabled) {
    return res.status(404).json({ error: "Not found" });
  }
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const raceId = String(req.params.id);

  const verifySchema = z.object({
    verifiedCumulativeSteps: z.number().int().min(0).max(500000),
    source: z.enum(["healthkit", "health_connect"]),
    intervalStartUtc: z.string().datetime().optional(),
    intervalEndUtc: z.string().datetime().optional(),
    measuredAtUtc: z.string().datetime(),
    clientLiveCumulativeSteps: z.number().int().min(0).max(500000).optional(),
    verificationSessionId: z.string().max(64).optional(),
  });
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid verification data", details: parsed.error.issues });
  }
  const { verifiedCumulativeSteps, source, measuredAtUtc, intervalEndUtc } = parsed.data;

  const [[room], [participant]] = await Promise.all([
    db.select({ status: raceRoomsTable.status, startedAt: raceRoomsTable.startedAt, completedAt: raceRoomsTable.completedAt,
      challengeEndAt: raceRoomsTable.challengeEndAt, challengeDurationDays: raceRoomsTable.challengeDurationDays,
      scheduledStartAt: raceRoomsTable.scheduledStartAt })
      .from(raceRoomsTable).where(eq(raceRoomsTable.id, raceId)).limit(1),
    db.select({ status: raceParticipantsTable.status, verifiedCumulativeSteps: raceParticipantsTable.verifiedCumulativeSteps,
      verifiedMeasuredAt: raceParticipantsTable.verifiedMeasuredAt })
      .from(raceParticipantsTable)
      .where(and(eq(raceParticipantsTable.raceRoomId, raceId), eq(raceParticipantsTable.userId, userId))).limit(1),
  ]);

  if (!room) return res.status(404).json({ error: "Race not found" });
  if (!participant) return res.status(404).json({ error: "Participant not found" });
  // Membership: left/forfeited/disqualified users cannot submit verification (§19).
  if (participant.status === "left" || participant.status === "forfeited" || participant.status === "disqualified") {
    return res.status(409).json({ error: "You are no longer an active participant in this race.", participant_status: participant.status });
  }
  // Race window: accept while in progress, or within the verification window after completion.
  const endAtMs = (room.completedAt ? new Date(room.completedAt) : deriveChallengeEndAt(room))?.getTime() ?? null;
  const withinPostWindow = endAtMs != null && Date.now() - endAtMs <= config.hybridReconciliation.verificationWindowMs;
  if (room.status !== "in_progress" && !withinPostWindow) {
    return res.status(409).json({ error: "Verification window is not open for this race" });
  }

  // Stale-verification guard: ignore a measurement older than the one already stored.
  const measuredAt = new Date(measuredAtUtc);
  if (participant.verifiedMeasuredAt && measuredAt.getTime() < participant.verifiedMeasuredAt.getTime()) {
    return res.json({ accepted: false, reason: "stale_verification", verifiedCumulativeSteps: participant.verifiedCumulativeSteps ?? 0 });
  }
  // Verified totals are cumulative and non-decreasing within the race — never lower the stored value.
  const acceptedVerified = Math.max(participant.verifiedCumulativeSteps ?? 0, verifiedCumulativeSteps);

  await db.update(raceParticipantsTable)
    .set({
      verifiedCumulativeSteps: acceptedVerified,
      verificationSource: source,
      verifiedMeasuredAt: intervalEndUtc ? new Date(intervalEndUtc) : measuredAt,
      verifiedUpdatedAt: new Date(),
    })
    .where(and(eq(raceParticipantsTable.raceRoomId, raceId), eq(raceParticipantsTable.userId, userId)));

  req.log.info({ raceId, userId, verifiedCumulativeSteps: acceptedVerified, source }, "race verification stored");
  void triggerEvent(`public-live-race-${raceId}`, "participant:verification_status_changed", {
    userId, verificationStatus: "received",
  });
  return res.json({ accepted: true, verifiedCumulativeSteps: acceptedVerified });
});

// ── GET /api/races/:id/result-status ──────────────────────────────────────────
// Authoritative per-user result status for the app (§ frontend handling). The backend — never the
// client — decides whether a result is final. Provisional live steps are returned only as
// `liveSteps` (clearly provisional); `steps`/`rank`/`payout` are populated ONLY when finalized.
router.get("/races/:id/result-status", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const raceId = String(req.params.id);
  const [[room], [participant], [result]] = await Promise.all([
    db.select({ status: raceRoomsTable.status, settlementStatus: raceRoomsTable.settlementStatus })
      .from(raceRoomsTable).where(eq(raceRoomsTable.id, raceId)).limit(1),
    db.select({ status: raceParticipantsTable.status, currentSteps: raceParticipantsTable.currentSteps,
      reconciledSteps: raceParticipantsTable.reconciledSteps, reconciliationStatus: raceParticipantsTable.reconciliationStatus })
      .from(raceParticipantsTable)
      .where(and(eq(raceParticipantsTable.raceRoomId, raceId), eq(raceParticipantsTable.userId, userId))).limit(1),
    db.select({ rank: raceResultsTable.rank, steps: raceResultsTable.steps, prizeCents: raceResultsTable.prizeCents,
      status: raceResultsTable.status })
      .from(raceResultsTable)
      .where(and(eq(raceResultsTable.raceRoomId, raceId), eq(raceResultsTable.userId, userId))).limit(1),
  ]);
  if (!room) return res.status(404).json({ error: "Race not found" });
  if (!participant) return res.status(404).json({ error: "Participant not found" });

  const recon = participant.reconciliationStatus;
  const verificationStatus =
    participant.status === "disqualified" ? "verification_rejected"
    : recon === "finalized" ? "finalized"
    : recon === "review_required" ? "review_required"
    : room.status === "in_progress" ? "live"
    : "verification_pending";

  // resolveRaceResult contract: authoritative fields only when finalized; provisional otherwise.
  const finalized = recon === "finalized" && room.status === "completed" && result != null;
  return res.json({
    raceStatus: room.status,
    settlementStatus: room.settlementStatus ?? null,
    verificationStatus,
    // Provisional — never label as final/verified on the client.
    liveSteps: participant.currentSteps,
    // Authoritative — populated only once finalized.
    steps: finalized ? (result!.steps ?? participant.reconciledSteps) : null,
    rank: finalized ? result!.rank : null,
    payoutCents: finalized ? result!.prizeCents : null,
  });
});

// ── POST /api/races/:id/verification-resolve (OPS, admin-key) ──────────────────
// Only the backend issues the final decision for a held (review_required) participant in a strict
// funded race (§13/§15). Ops can:
//   approve → set an authoritative reconciled total and finalize (participant may win/be paid)
//   reject  → disqualify the participant from prizes (excluded from winner selection)
//   resync  → reset to pending so the client can re-submit a verification
// After a decision, completion is re-attempted so a now-fully-resolved race can settle.
router.post("/races/:id/verification-resolve", requireAuth, requireAdminKey, async (req, res) => {
  const raceId = String(req.params.id);
  const schema = z.object({
    userId: z.string().min(1),
    decision: z.enum(["approve", "reject", "resync"]),
    steps: z.number().int().min(0).max(500000).optional(),
    note: z.string().max(500).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid resolution", details: parsed.error.issues });
  const { userId, decision, steps, note } = parsed.data;

  const [participant] = await db
    .select({ currentSteps: raceParticipantsTable.currentSteps, verifiedCumulativeSteps: raceParticipantsTable.verifiedCumulativeSteps,
      reconciliationStatus: raceParticipantsTable.reconciliationStatus })
    .from(raceParticipantsTable)
    .where(and(eq(raceParticipantsTable.raceRoomId, raceId), eq(raceParticipantsTable.userId, userId)))
    .limit(1);
  if (!participant) return res.status(404).json({ error: "Participant not found" });
  // Idempotency: an already-finalized participant is not re-decided.
  if (participant.reconciliationStatus === "finalized") {
    return res.json({ resolved: false, reason: "already_finalized" });
  }

  if (decision === "approve") {
    // Prefer the ops-supplied total, else the participant's own verified total, else capped live.
    // Bound by serverCap (live + tolerance): even an ops decision cannot exceed server-tracked
    // progress — this keeps the selective-payout ceiling (live + tolerance) a true upper bound, so
    // an approved participant can never retroactively displace an already-paid safe winner.
    const serverCap = participant.currentSteps + config.hybridReconciliation.absoluteToleranceSteps;
    const requested = steps ?? participant.verifiedCumulativeSteps ?? participant.currentSteps;
    const finalSteps = Math.min(requested, serverCap);
    await db.update(raceParticipantsTable)
      .set({ reconciledSteps: finalSteps, reconciliationStatus: "finalized", reconciledAt: new Date(),
        reconciliationReasonCodes: ["ops_approved", ...(note ? [`note:${note}`] : [])] })
      .where(and(eq(raceParticipantsTable.raceRoomId, raceId), eq(raceParticipantsTable.userId, userId),
        ne(raceParticipantsTable.reconciliationStatus, "finalized")));
    void writeVerificationAudit({
      raceId, userId, liveSteps: participant.currentSteps, verifiedSteps: participant.verifiedCumulativeSteps ?? null,
      reconciledSteps: finalSteps, verificationStatus: "finalized", decision: "approved_manually",
      reasonCode: "ops_approved", decidedBy: "operations",
    });
  } else if (decision === "reject") {
    // Disqualified participants are excluded from winner selection by the finalization query.
    await db.update(raceParticipantsTable)
      .set({ status: "disqualified", reconciliationStatus: "review_required",
        reconciliationReasonCodes: ["ops_rejected", ...(note ? [`note:${note}`] : [])] })
      .where(and(eq(raceParticipantsTable.raceRoomId, raceId), eq(raceParticipantsTable.userId, userId)));
    void writeVerificationAudit({
      raceId, userId, liveSteps: participant.currentSteps, verifiedSteps: participant.verifiedCumulativeSteps ?? null,
      reconciledSteps: null, verificationStatus: "verification_rejected", decision: "rejected",
      reasonCode: "ops_rejected", decidedBy: "operations",
    });
  } else { // resync
    await db.update(raceParticipantsTable)
      .set({ reconciliationStatus: "pending", reconciliationReasonCodes: ["ops_resync", ...(note ? [`note:${note}`] : [])] })
      .where(and(eq(raceParticipantsTable.raceRoomId, raceId), eq(raceParticipantsTable.userId, userId),
        ne(raceParticipantsTable.reconciliationStatus, "finalized")));
  }

  req.log.info({ raceId, userId, decision, steps }, "[VerificationResolve] ops decision applied");
  // Best-effort: re-attempt completion so a now-resolved funded race can settle. No-op if still held.
  void autoCompleteRace(raceId, "verification_resolved").catch(
    (err) => req.log.error({ err, raceId }, "verification-resolve: completion retry failed"));
  return res.json({ resolved: true, decision });
});

// ── POST /api/races/:id/force-complete (TESTING ONLY) ─────────────────────────
// Immediately marks an in_progress race as completed, stores race_results, announces winners.
// This route is opt-in so a missing NODE_ENV cannot expose it in production.
const testRaceRoutesEnabled = process.env.NODE_ENV === "test" || process.env.ENABLE_TEST_RACE_ROUTES === "true";
if (testRaceRoutesEnabled) {
  router.post("/races/:id/force-complete", requireAuth, requireAdminKey, async (req, res) => {
    const userId = (req as AuthenticatedRequest).descopeUserId;
    const raceId = String(req.params.id);

    const [room] = await db
      .select()
      .from(raceRoomsTable)
      .where(eq(raceRoomsTable.id, raceId))
      .limit(1);

    if (!room) return res.status(404).json({ error: "Race not found" });
    if (room.creatorId !== userId) return res.status(403).json({ error: "Only the host can force-complete." });
    if (room.status !== "in_progress") return res.status(409).json({ error: "Race is not in progress." });

    await autoCompleteRace(raceId, "manual_force_complete");
    req.log.info({ raceId, userId }, "race force-completed");
    return res.json({ success: true });
  });
}

// ── GET /api/races/:id/comments ───────────────────────────────────────────────
router.get("/races/:id/comments", requireAuth, async (req, res) => {
  const raceId = String(req.params.id);
  const rows = await db
    .select({
      id:          liveRaceCommentsTable.id,
      raceRoomId:  liveRaceCommentsTable.raceRoomId,
      userId:      liveRaceCommentsTable.userId,
      username:    liveRaceCommentsTable.username,
      countryFlag: liveRaceCommentsTable.countryFlag,
      avatarColor: liveRaceCommentsTable.avatarColor,
      text:        liveRaceCommentsTable.text,
      createdAt:   liveRaceCommentsTable.createdAt,
      avatarUrl:      profilesTable.avatarUrl,
      avatarVersion:  profilesTable.updatedAt,
    })
    .from(liveRaceCommentsTable)
    .leftJoin(profilesTable, eq(profilesTable.id, liveRaceCommentsTable.userId))
    .where(eq(liveRaceCommentsTable.raceRoomId, raceId))
    .orderBy(asc(liveRaceCommentsTable.createdAt))
    .limit(60);
  return res.json({
    comments: rows.map((r) => ({
      ...r,
      avatarUrl:     r.avatarUrl ?? null,
      avatarVersion: r.avatarVersion?.getTime() ?? 0,
    })),
  });
});

// ── POST /api/races/:id/comments ──────────────────────────────────────────────
router.post("/races/:id/comments", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const raceId = String(req.params.id);
  const { text, clientMessageId } = req.body as { text?: unknown; clientMessageId?: unknown };

  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "text is required" });
  }

  const clientMsgId = typeof clientMessageId === "string" && clientMessageId.length > 0 && clientMessageId.length <= 80
    ? clientMessageId : undefined;

  // Only participants may post comments — otherwise any authenticated user can
  // inject comments and broadcast on the public race channel for a race they
  // are not in.
  if (!(await isRaceParticipant(userId, raceId))) {
    return res.status(403).json({ error: "Only race participants can comment." });
  }

  const [profile] = await db
    .select({ username: profilesTable.username, countryFlag: profilesTable.countryFlag, avatarColor: profilesTable.avatarColor, avatarUrl: profilesTable.avatarUrl, updatedAt: profilesTable.updatedAt })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);

  if (!profile) return res.status(404).json({ error: "Profile not found" });

  const [inserted] = await db.insert(liveRaceCommentsTable).values({
    raceRoomId:  raceId,
    userId,
    username:    profile.username,
    countryFlag: profile.countryFlag ?? "🏳️",
    avatarColor: profile.avatarColor ?? "#00E676",
    text:        text.trim(),
  }).returning();

  const comment = {
    id:            inserted.id,
    raceRoomId:    inserted.raceRoomId,
    userId:        inserted.userId,
    username:      inserted.username,
    countryFlag:   inserted.countryFlag,
    avatarColor:   inserted.avatarColor,
    avatarUrl:     profile.avatarUrl ?? null,
    avatarVersion: profile.updatedAt?.getTime() ?? 0,
    text:          inserted.text,
    createdAt:     inserted.createdAt instanceof Date ? inserted.createdAt.toISOString() : String(inserted.createdAt),
    clientMessageId: clientMsgId,
  };

  await triggerEvent(`public-live-race-${raceId}`, "race:comment_new", { comment });
  return res.json({ comment });
});

// ── POST /api/races/:id/spectate ──────────────────────────────────────────────
// Heartbeat: called every 60s by non-participant viewers to register presence.
router.post("/races/:id/spectate", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const raceId = String(req.params.id);
  const count = registerSpectator(raceId, userId);
  void triggerEvent(`public-live-race-${raceId}`, "race:spectator_count", { count });
  return res.json({ count });
});

// ── GET /api/races/:id/reactions ──────────────────────────────────────────────
router.get("/races/:id/reactions", requireAuth, async (req, res) => {
  const raceId = String(req.params.id);
  const rows = await db
    .select({
      emoji: liveRaceReactionsTable.emoji,
      count: sql<number>`count(*)::int`,
    })
    .from(liveRaceReactionsTable)
    .where(eq(liveRaceReactionsTable.raceRoomId, raceId))
    .groupBy(liveRaceReactionsTable.emoji);
  return res.json({ reactions: rows });
});

// ── POST /api/races/:id/reactions ─────────────────────────────────────────────
router.post("/races/:id/reactions", requireAuth, async (req, res) => {
  const userId  = (req as AuthenticatedRequest).descopeUserId;
  const raceId  = String(req.params.id);
  const { emoji } = req.body as { emoji?: unknown };

  const VALID = ["🔥", "👏", "👑", "🏃", "🏆", "😮", "❤️"];
  if (typeof emoji !== "string" || !VALID.includes(emoji)) {
    return res.status(400).json({ error: "Invalid emoji" });
  }

  await db.insert(liveRaceReactionsTable).values({ raceRoomId: raceId, userId, emoji });

  const counts = await db
    .select({ emoji: liveRaceReactionsTable.emoji, count: sql<number>`count(*)::int` })
    .from(liveRaceReactionsTable)
    .where(eq(liveRaceReactionsTable.raceRoomId, raceId))
    .groupBy(liveRaceReactionsTable.emoji);

  await triggerEvent(`public-live-race-${raceId}`, "race:reaction_updated", { counts });
  return res.json({ success: true, counts });
});

// ── POST /api/races/:id/participants/:userId/remove ───────────────────────────
// Host removes a participant from the waiting room before the race starts.
router.post("/races/:id/participants/:userId/remove", requireAuth, async (req, res) => {
  const currentUserId = (req as AuthenticatedRequest).descopeUserId;
  const raceId = String(req.params.id);
  const targetUserId = String(req.params.userId);

  const [room] = await db
    .select()
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.id, raceId))
    .limit(1);

  if (!room) return res.status(404).json({ error: "Race not found" });
  if (room.creatorId !== currentUserId) {
    return res.status(403).json({ success: false, code: "NOT_AUTHORIZED", error: "Only the host can remove players from this room." });
  }
  if (targetUserId === currentUserId) {
    return res.status(400).json({ success: false, code: "CANNOT_REMOVE_HOST", error: "Host cannot remove themselves." });
  }

  // Removal only allowed before race starts. "open" = spots available, "full" = all slots taken but not started, "scheduled" = future start
  const REMOVABLE_STATUSES = ["open", "full", "scheduled"];
  if (!REMOVABLE_STATUSES.includes(room.status)) {
    return res.status(409).json({ success: false, code: "RACE_ALREADY_STARTED", error: "You cannot remove players after the race has started." });
  }

  const [participant] = await db
    .select({ id: raceParticipantsTable.id })
    .from(raceParticipantsTable)
    .where(and(
      eq(raceParticipantsTable.raceRoomId, raceId),
      eq(raceParticipantsTable.userId, targetUserId),
      ne(raceParticipantsTable.status, "left"),
    ))
    .limit(1);

  if (!participant) return res.status(404).json({ error: "Player not found in this room." });

  // If room was "full", removing a player opens a slot — reset to "open"
  const newRoomStatus = room.status === "full" ? "open" : room.status;

  // Paid rooms: the removed player paid an entry fee. Reuse the same
  // remove-and-refund path as a voluntary leave so the entry fee is credited
  // back idempotently inside one transaction, instead of silently forfeiting it.
  let refundProcessed = false;
  let refundAmount = 0;
  if (room.entryAmountCents > 0) {
    const leaveResult = await createRefundForRaceLeave({
      raceId,
      userId: targetUserId,
      reasonCode: "host_removed",
    });
    refundAmount = leaveResult.refund.succeededCashCents ?? 0;
    refundProcessed = refundAmount > 0;
    // createRefundForRaceLeave decremented currentPlayers but does not reopen a
    // full room; reset the status here so a freed slot is joinable again.
    if (newRoomStatus !== room.status) {
      await db
        .update(raceRoomsTable)
        .set({ status: newRoomStatus, updatedAt: new Date() })
        .where(eq(raceRoomsTable.id, raceId));
    }
  } else {
    await db.transaction(async (tx) => {
      await tx
        .update(raceParticipantsTable)
        .set({ status: "left" })
        .where(and(
          eq(raceParticipantsTable.raceRoomId, raceId),
          eq(raceParticipantsTable.userId, targetUserId),
          ne(raceParticipantsTable.status, "left"),
        ));
      await tx
        .update(raceRoomsTable)
        .set({
          currentPlayers: sql`GREATEST(${raceRoomsTable.currentPlayers} - 1, 0)`,
          status: newRoomStatus,
          updatedAt: new Date(),
        })
        .where(eq(raceRoomsTable.id, raceId));
    });
  }

  const [updatedRoom] = await db
    .select({ currentPlayers: raceRoomsTable.currentPlayers })
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.id, raceId))
    .limit(1);

  const remainingParticipants = await db
    .select({ userId: raceParticipantsTable.userId })
    .from(raceParticipantsTable)
    .where(and(eq(raceParticipantsTable.raceRoomId, raceId), ne(raceParticipantsTable.status, "left")));

  const participantCount = updatedRoom?.currentPlayers ?? 0;

  await triggerEvent(`public-live-race-${raceId}`, "room:participant_removed", {
    raceId,
    removedUserId: targetUserId,
    removedByUserId: currentUserId,
    currentPlayers: participantCount,
    roomStatus: newRoomStatus,
    participantIds: remainingParticipants.map((p) => p.userId),
    refundProcessed,
    refundAmount,
  });

  req.log.info({ raceId, removedUserId: targetUserId, byUserId: currentUserId, newRoomStatus, refundProcessed, refundAmount }, "host removed participant from waiting room");
  return res.json({
    success: true,
    raceId,
    removedUserId: targetUserId,
    participantCount,
    refundProcessed,
    refundAmount,
    message: "Player removed from room",
  });
});


// ── GET /api/races/:id/online-invite-candidates ───────────────────────────────
// Returns random online users eligible to be invited to this room.
// Excludes: current user, joined participants, pending invitees, blocked users.
router.get("/races/:id/online-invite-candidates", requireAuth, async (req, res) => {
  const currentUserId = (req as AuthenticatedRequest).descopeUserId;
  const raceId = String(req.params.id);

  const [room] = await db
    .select({ id: raceRoomsTable.id, status: raceRoomsTable.status, creatorId: raceRoomsTable.creatorId })
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.id, raceId))
    .limit(1);

  if (!room) return res.status(404).json({ error: "Room not found" });
  if (room.creatorId !== currentUserId) return res.status(403).json({ error: "Only the host can view candidates" });
  if (room.status !== "open") return res.status(409).json({ error: "Room is no longer open" });

  const cutoff = new Date(Date.now() - 90_000);

  // IDs already in the room
  const joined = await db
    .select({ userId: raceParticipantsTable.userId })
    .from(raceParticipantsTable)
    .where(and(
      eq(raceParticipantsTable.raceRoomId, raceId),
      ne(raceParticipantsTable.status, "left"),
      ne(raceParticipantsTable.status, "forfeited"),
    ));
  const joinedIds = new Set(joined.map((j) => j.userId));
  joinedIds.add(currentUserId);

  // IDs with pending invites to this room
  const pendingInvites = await db
    .select({ inviteeId: roomInvitesTable.inviteeId })
    .from(roomInvitesTable)
    .where(and(
      eq(roomInvitesTable.raceRoomId, raceId),
      eq(roomInvitesTable.status, "pending"),
    ));
  const pendingIds = new Set(pendingInvites.map((p) => p.inviteeId));

  // Friend IDs of current user
  const friendRows = await db
    .select({ friendId: friendsTable.friendId })
    .from(friendsTable)
    .where(eq(friendsTable.userId, currentUserId));
  const friendIds = new Set(friendRows.map((f) => f.friendId));

  // Blocked user IDs (either direction)
  const blocked = await db
    .select({ blockerId: blockedUsersTable.blockerId, blockedId: blockedUsersTable.blockedId })
    .from(blockedUsersTable)
    .where(or(
      eq(blockedUsersTable.blockerId, currentUserId),
      eq(blockedUsersTable.blockedId, currentUserId),
    ));
  const blockedIds = new Set<string>();
  for (const b of blocked) {
    blockedIds.add(b.blockerId);
    blockedIds.add(b.blockedId);
  }
  blockedIds.delete(currentUserId);

  // Online users (presence within 90s)
  const online = await db
    .select({
      userId: profilesTable.id,
      username: profilesTable.username,
      countryFlag: profilesTable.countryFlag,
      avatarColor: profilesTable.avatarColor,
      avatarUrl: profilesTable.avatarUrl,
      presenceStatus: userPresenceTable.status,
    })
    .from(userPresenceTable)
    .innerJoin(profilesTable, eq(userPresenceTable.userId, profilesTable.id))
    .where(sql`${userPresenceTable.lastSeenAt} > ${cutoff}`)
    .limit(60);

  const candidates = online
    .filter((u) => !joinedIds.has(u.userId) && !blockedIds.has(u.userId))
    .map((u) => ({
      userId: u.userId,
      username: u.username,
      countryFlag: u.countryFlag,
      avatarColor: u.avatarColor ?? "#00E676",
      avatarUrl: u.avatarUrl ?? null,
      status: u.presenceStatus,
      isFriend: friendIds.has(u.userId),
      inviteStatus: pendingIds.has(u.userId) ? "pending" : "none",
    }))
    .slice(0, 20);

  req.log.info({ raceId, count: candidates.length }, "online-invite-candidates: fetched");
  return res.json({ candidates });
});

// ── POST /api/races/:id/invites ───────────────────────────────────────────────
// Host invites a user to join this room. Creates a 20-second expiring invite
// and fires a Pusher event on the invitee's private channel.
router.post("/races/:id/invites", requireAuth, async (req, res) => {
  const currentUserId = (req as AuthenticatedRequest).descopeUserId;
  const raceId = String(req.params.id);
  const { inviteeId } = req.body as { inviteeId?: string };

  if (!inviteeId) return res.status(400).json({ error: "inviteeId required" });

  const [room] = await db
    .select()
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.id, raceId))
    .limit(1);

  if (!room) return res.status(404).json({ error: "Room not found" });
  if (room.status !== "open") return res.status(409).json({ error: "Room is no longer open" });
  if (room.creatorId !== currentUserId) return res.status(403).json({ error: "Only the host can invite" });
  if (room.currentPlayers >= room.maxPlayers) return res.status(409).json({ error: "Room is full" });

  // Check no active pending invite already
  const [existing] = await db
    .select({ id: roomInvitesTable.id })
    .from(roomInvitesTable)
    .where(and(
      eq(roomInvitesTable.raceRoomId, raceId),
      eq(roomInvitesTable.inviteeId, inviteeId),
      eq(roomInvitesTable.status, "pending"),
    ))
    .limit(1);
  if (existing) return res.status(409).json({ error: "Already invited" });

  // Get host profile for the push payload
  const [hostProfile] = await db
    .select({ username: profilesTable.username, avatarColor: profilesTable.avatarColor, avatarUrl: profilesTable.avatarUrl })
    .from(profilesTable)
    .where(eq(profilesTable.id, currentUserId))
    .limit(1);

  const expiresAt = new Date(Date.now() + 20_000);

  const [invite] = await db
    .insert(roomInvitesTable)
    .values({ raceRoomId: raceId, inviterId: currentUserId, inviteeId, status: "pending", expiresAt })
    .returning();

  const challengeLabel = entryTypeLabel(room.entryType);

  // Push invite to invited user's private channel
  triggerEvent(`private-user-${inviteeId}`, "room_invite:new", {
    inviteId: invite.id,
    raceId,
    inviterUserId: currentUserId,
    inviterUsername: hostProfile?.username ?? "Someone",
    inviterAvatarColor: hostProfile?.avatarColor ?? "#00E676",
    inviterAvatarUrl: hostProfile?.avatarUrl ?? null,
    challengeType: `${challengeLabel} Challenge`,
    entryAmountCents: room.entryAmountCents,
    targetSteps: targetStepsForRoom(room),
    isPrivate: room.isPrivate,
    inviteCode: room.isPrivate ? room.inviteCode : null,
    expiresAt: expiresAt.toISOString(),
  }).catch(() => {});

  // Auto-expire after 20s
  setTimeout(() => {
    db.update(roomInvitesTable)
      .set({ status: "expired" })
      .where(and(eq(roomInvitesTable.id, invite.id), eq(roomInvitesTable.status, "pending")))
      .returning()
      .then((updated) => {
        if (updated.length > 0) {
          triggerEvent(`private-user-${inviteeId}`, "room_invite:expired", {
            inviteId: invite.id,
            raceId,
          }).catch(() => {});
          triggerEvent(`private-user-${currentUserId}`, "room_invite:expired", {
            inviteId: invite.id,
            raceId,
            inviteeId,
          }).catch(() => {});
        }
      })
      .catch(() => {});
  }, 20_000);

  req.log.info({ raceId, inviterId: currentUserId, inviteeId, inviteId: invite.id }, "room invite sent");
  return res.json({ invite: { id: invite.id, expiresAt: expiresAt.toISOString() } });
});

// ── POST /api/races/invites/:inviteId/respond ─────────────────────────────────
// Invited user accepts or declines a room invite.
router.post("/races/invites/:inviteId/respond", requireAuth, async (req, res) => {
  const currentUserId = (req as AuthenticatedRequest).descopeUserId;
  const inviteId = String(req.params.inviteId);
  const { action } = req.body as { action?: "accept" | "decline" };

  if (action !== "accept" && action !== "decline") {
    return res.status(400).json({ error: "action must be 'accept' or 'decline'" });
  }

  const [invite] = await db
    .select()
    .from(roomInvitesTable)
    .where(and(eq(roomInvitesTable.id, inviteId), eq(roomInvitesTable.inviteeId, currentUserId)))
    .limit(1);

  if (!invite) return res.status(404).json({ error: "Invite not found" });
  if (invite.status !== "pending") return res.status(409).json({ error: `Invite is already ${invite.status}` });
  if (new Date() > invite.expiresAt) {
    await db.update(roomInvitesTable).set({ status: "expired" }).where(eq(roomInvitesTable.id, inviteId));
    return res.status(410).json({ error: "Invite has expired" });
  }

  const newStatus = action === "accept" ? "accepted" : "declined";
  await db.update(roomInvitesTable).set({ status: newStatus }).where(eq(roomInvitesTable.id, inviteId));

  // Notify host
  triggerEvent(`private-user-${invite.inviterId}`, `room_invite:${newStatus}`, {
    inviteId,
    raceId: invite.raceRoomId,
    inviteeId: currentUserId,
  }).catch(() => {});

  if (action === "accept") {
    const [room] = await db
      .select()
      .from(raceRoomsTable)
      .where(eq(raceRoomsTable.id, invite.raceRoomId))
      .limit(1);
    return res.json({
      status: "accepted",
      raceId: invite.raceRoomId,
      room: room ? {
        id: room.id,
        entryAmountCents: room.entryAmountCents,
        targetSteps: targetStepsForRoom(room),
        maxPlayers: room.maxPlayers,
        isPrivate: room.isPrivate,
        entryType: room.entryType,
        inviteCode: room.inviteCode,
      } : null,
    });
  }

  req.log.info({ inviteId, action, inviteeId: currentUserId }, "room invite responded");
  return res.json({ status: "declined" });
});

// ── GET /api/join/:code ───────────────────────────────────────────────────────
// Deep-link redirect page — sharing produces a real tappable URL.
// Serves HTML that auto-redirects to globalwalkerleague://join/:code so that
// WhatsApp/iMessage/SMS recipients open the app directly when they tap the link.
router.get("/join/:code", (req, res) => {
  const code = String(req.params.code ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  const deepLink = `globalwalkerleague://join/${code}`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Join Walk Champ · ${code}</title>
  <meta http-equiv="refresh" content="1;url=${deepLink}" />
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0f;font-family:system-ui,-apple-system,sans-serif;color:#fff;padding:24px}
    .card{background:#12121e;border:1px solid #2a2a3e;border-radius:24px;padding:40px 28px;max-width:380px;width:100%;text-align:center;display:flex;flex-direction:column;align-items:center;gap:18px}
    .trophy{font-size:52px}
    h1{font-size:24px;font-weight:800;letter-spacing:-0.5px}
    .sub{color:#888;font-size:14px;line-height:1.5}
    .code-wrap{background:#A855F715;border:1.5px solid #A855F740;border-radius:16px;padding:16px 28px;display:flex;flex-direction:column;align-items:center;gap:6px;width:100%}
    .code-label{font-size:11px;color:#888;letter-spacing:1px;text-transform:uppercase}
    .code-val{font-size:38px;font-weight:900;letter-spacing:7px;color:#A855F7}
    .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:linear-gradient(135deg,#A855F7,#7C3AED);color:#fff;text-decoration:none;border-radius:14px;padding:15px 36px;font-weight:700;font-size:16px;width:100%}
    .hint{font-size:12px;color:#555;line-height:1.5}
  </style>
</head>
<body>
  <div class="card">
    <div class="trophy">🏆</div>
    <h1>Walk Champ Invite</h1>
    <p class="sub">You've been invited to join a private walking challenge!</p>
    <div class="code-wrap">
      <span class="code-label">Room Code</span>
      <span class="code-val">${code}</span>
    </div>
    <a class="btn" href="${deepLink}">Open in Walk Champ</a>
    <p class="hint">Opening the app automatically…<br>If it doesn't open, tap the button above.</p>
  </div>
</body>
</html>`);
});

export default router;
