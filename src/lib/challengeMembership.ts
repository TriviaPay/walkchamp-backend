import { and, eq, ne, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import {
  raceRoomsTable,
  raceParticipantsTable,
  scheduledRoomRegistrationsTable,
} from "../../db/src/schema/races.js";
import {
  unlimitedChallengesTable,
  unlimitedChallengeParticipantsTable,
} from "../../db/src/schema/unlimitedChallenge.js";
import { UNLIMITED_NON_ACTIVE_STATUSES } from "./unlimitedChallengeStatuses.js";
import type { DbTx } from "./raceIntegrity.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

type DbOrTx = typeof db | DbTx;

export interface BlockingMembership {
  kind: "race" | "unlimited";
  id: string;
  status: string;
}

/**
 * The shared "one blocking challenge at a time" primitive. A user is blocked from creating/joining
 * ANY challenge while they have a blocking membership in EITHER the classic race system OR the
 * Unlimited Challenge system. Both callers acquire the same advisory lock first (see
 * `acquireOneChallengeLock`) so concurrent joins can't place a user in two challenges.
 */

/** Advisory transaction lock keyed per user — shared by races and unlimited challenges. */
export async function acquireOneChallengeLock(tx: DbTx, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`regular_race_registration:${userId}`}, 0))`);
}

/** Blocking membership in the classic race system (open/full/in_progress/starting/scheduled, non-sponsored). */
export async function getRaceBlockingMembership(dbOrTx: DbOrTx, userId: string): Promise<BlockingMembership | null> {
  const [active] = await dbOrTx
    .select({ id: raceRoomsTable.id, status: raceRoomsTable.status })
    .from(raceParticipantsTable)
    .innerJoin(raceRoomsTable, eq(raceParticipantsTable.raceRoomId, raceRoomsTable.id))
    .where(and(
      eq(raceParticipantsTable.userId, userId),
      inArray(raceParticipantsTable.status, ["joined", "active"]),
      ne(raceRoomsTable.type, "sponsored"),
      inArray(raceRoomsTable.status, ["open", "full", "starting", "in_progress"]),
    ))
    .limit(1);
  if (active) return { kind: "race", id: active.id, status: active.status };

  const [scheduled] = await dbOrTx
    .select({ id: raceRoomsTable.id, status: raceRoomsTable.status })
    .from(scheduledRoomRegistrationsTable)
    .innerJoin(raceRoomsTable, eq(scheduledRoomRegistrationsTable.raceRoomId, raceRoomsTable.id))
    .where(and(
      eq(scheduledRoomRegistrationsTable.userId, userId),
      eq(scheduledRoomRegistrationsTable.status, "registered"),
      ne(raceRoomsTable.type, "sponsored"),
      eq(raceRoomsTable.status, "scheduled"),
    ))
    .limit(1);
  if (scheduled) return { kind: "race", id: scheduled.id, status: scheduled.status };

  return null;
}

/** Blocking membership in the Unlimited Challenge system (waiting/starting/active/settling, not left). */
export async function getUnlimitedBlockingMembership(
  dbOrTx: DbOrTx,
  userId: string,
  opts?: string | { excludeChallengeId?: string; failOpen?: boolean },
): Promise<BlockingMembership | null> {
  const excludeChallengeId = typeof opts === "string" ? opts : opts?.excludeChallengeId;
  const failOpen = typeof opts === "string" ? true : opts?.failOpen ?? true;
  // Feature off ⇒ no unlimited challenges exist to block against. Returning early also guarantees
  // this helper is a no-op on the existing race create/join paths when the flag is disabled (and
  // before the migration has run), so it can NEVER change or break existing race functionality.
  if (!config.features.unlimitedGoalEnabled) return null;
  try {
    const rows = await dbOrTx
      .select({ id: unlimitedChallengesTable.id, status: unlimitedChallengesTable.status })
      .from(unlimitedChallengeParticipantsTable)
      .innerJoin(unlimitedChallengesTable, eq(unlimitedChallengeParticipantsTable.challengeId, unlimitedChallengesTable.id))
      .where(and(
        eq(unlimitedChallengeParticipantsTable.userId, userId),
        notInArray(unlimitedChallengeParticipantsTable.qualificationStatus, [...UNLIMITED_NON_ACTIVE_STATUSES]),
        inArray(unlimitedChallengesTable.status, ["waiting", "starting", "active", "settling"]),
      ))
      .limit(2);
    const hit = rows.find((r) => r.id !== excludeChallengeId);
    return hit ? { kind: "unlimited", id: hit.id, status: hit.status } : null;
  } catch (err) {
    if (!failOpen) throw err;
    // Fail-open: a query error must never break the caller's create/join flow.
    logger.warn({ err, userId }, "[challengeMembership] unlimited blocking check failed (fail-open)");
    return null;
  }
}

/** True if the user has ANY blocking membership across both systems. */
export async function getBlockingMembership(
  dbOrTx: DbOrTx,
  userId: string,
  opts?: { excludeChallengeId?: string },
): Promise<BlockingMembership | null> {
  return (
    (await getUnlimitedBlockingMembership(dbOrTx, userId, opts?.excludeChallengeId))
    ?? (await getRaceBlockingMembership(dbOrTx, userId))
  );
}
