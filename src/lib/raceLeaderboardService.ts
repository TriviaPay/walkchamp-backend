import { db } from "@db";
import { profilesTable, raceParticipantsTable, raceRoomsTable } from "@db/schema";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

export interface LiveRaceStanding {
  userId: string;
  username: string;
  raceSteps: number;
  rank: number;
  finishedGoal: boolean;
  finishRank: number | null;
}

export interface LiveRaceProgressContext {
  raceId: string;
  userId: string;
  username: string;
  raceSteps: number;
  rank: number;
  totalParticipants: number;
  goalSteps: number;
  timeLeftSeconds: number;
  raceStatus: string;
  lastSyncedAt: string;
  leaderboard: LiveRaceStanding[];
}

const ACTIVE_PARTICIPANT_STATUSES = ["joined", "active", "completed"] as const;

function computeTimeLeftSeconds(challengeEndAt: Date | null): number {
  if (!challengeEndAt) return 0;
  return Math.max(0, Math.floor((challengeEndAt.getTime() - Date.now()) / 1000));
}

/** Sort participants for live standings: higher steps first; goal finishers by finish order. */
function sortStandings(
  rows: Array<{
    userId: string;
    username: string | null;
    currentSteps: number;
    finishedGoal: boolean;
    finishRank: number | null;
  }>,
): LiveRaceStanding[] {
  const sorted = [...rows].sort((a, b) => {
    if (a.finishedGoal && b.finishedGoal) {
      return (a.finishRank ?? 999) - (b.finishRank ?? 999);
    }
    if (a.finishedGoal !== b.finishedGoal) return a.finishedGoal ? -1 : 1;
    if (b.currentSteps !== a.currentSteps) return b.currentSteps - a.currentSteps;
    return a.userId.localeCompare(b.userId);
  });

  return sorted.map((row, idx) => ({
    userId: row.userId,
    username: row.username ?? "Runner",
    raceSteps: row.currentSteps,
    rank: idx + 1,
    finishedGoal: row.finishedGoal,
    finishRank: row.finishRank,
  }));
}

export async function getLiveRaceStandings(raceId: string): Promise<LiveRaceStanding[]> {
  const rows = await db
    .select({
      userId: raceParticipantsTable.userId,
      username: profilesTable.username,
      currentSteps: raceParticipantsTable.currentSteps,
      finishedGoal: raceParticipantsTable.finishedGoal,
      finishRank: raceParticipantsTable.finishRank,
      status: raceParticipantsTable.status,
    })
    .from(raceParticipantsTable)
    .innerJoin(profilesTable, eq(profilesTable.id, raceParticipantsTable.userId))
    .where(
      and(
        eq(raceParticipantsTable.raceRoomId, raceId),
        inArray(raceParticipantsTable.status, [...ACTIVE_PARTICIPANT_STATUSES]),
      ),
    )
    .orderBy(desc(raceParticipantsTable.currentSteps), asc(raceParticipantsTable.joinedAt));

  const activeRows = rows;

  return sortStandings(activeRows);
}

export async function buildLiveRaceProgressContext(
  raceId: string,
  userId: string,
  raceSteps: number,
): Promise<LiveRaceProgressContext | null> {
  const [room] = await db
    .select({
      status: raceRoomsTable.status,
      targetSteps: raceRoomsTable.targetSteps,
      challengeEndAt: raceRoomsTable.challengeEndAt,
    })
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.id, raceId))
    .limit(1);

  if (!room) return null;

  const leaderboard = await getLiveRaceStandings(raceId);
  const me = leaderboard.find((p) => p.userId === userId);
  const [profile] = await db
    .select({ username: profilesTable.username })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);

  return {
    raceId,
    userId,
    username: me?.username ?? profile?.username ?? "Runner",
    raceSteps,
    rank: me?.rank ?? leaderboard.length,
    totalParticipants: leaderboard.length,
    goalSteps: room.targetSteps,
    timeLeftSeconds: computeTimeLeftSeconds(room.challengeEndAt),
    raceStatus: room.status,
    lastSyncedAt: new Date().toISOString(),
    leaderboard,
  };
}

export function formatProgressSyncResponse(ctx: LiveRaceProgressContext, extra: Record<string, unknown> = {}) {
  return {
    success: true,
    raceId: ctx.raceId,
    userId: ctx.userId,
    username: ctx.username,
    raceSteps: ctx.raceSteps,
    steps: ctx.raceSteps,
    accepted_race_steps: ctx.raceSteps,
    rank: ctx.rank,
    totalParticipants: ctx.totalParticipants,
    goalSteps: ctx.goalSteps,
    timeLeftSeconds: ctx.timeLeftSeconds,
    raceStatus: ctx.raceStatus,
    race_status: ctx.raceStatus,
    progress: ctx.goalSteps > 0 ? ctx.raceSteps / ctx.goalSteps : 0,
    lastSyncedAt: ctx.lastSyncedAt,
    server_time: ctx.lastSyncedAt,
    ...extra,
  };
}
