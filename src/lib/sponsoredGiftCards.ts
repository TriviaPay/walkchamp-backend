import { inArray } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import {
  profilesTable,
  sponsoredGiftCardAwardsTable,
} from "../../db/src/schema/index.js";
import { logger } from "./logger.js";

export type CreateSponsoredGiftCardAwardsParams = {
  raceRoomId: string;
  winnerUserIds?: string[];
  prizeAmountCents?: number;
  awards?: Array<{ userId: string; prizeAmountCents: number }>;
  currency?: string;
  provider?: string;
  metadata?: Record<string, unknown>;
  database?: Pick<typeof db, "select" | "insert">;
};

export async function createPendingSponsoredGiftCardAwards({
  raceRoomId,
  winnerUserIds = [],
  prizeAmountCents = 0,
  awards,
  currency = "usd",
  provider = "amazon",
  metadata,
  database = db,
}: CreateSponsoredGiftCardAwardsParams): Promise<number> {
  const awardByUserId = new Map<string, number>();
  for (const award of awards ?? []) {
    if (award.userId && award.prizeAmountCents > 0) {
      awardByUserId.set(award.userId, award.prizeAmountCents);
    }
  }
  if (awardByUserId.size === 0 && prizeAmountCents > 0) {
    for (const userId of winnerUserIds) {
      if (userId) awardByUserId.set(userId, prizeAmountCents);
    }
  }

  const uniqueWinnerIds = [...awardByUserId.keys()];
  if (uniqueWinnerIds.length === 0) return 0;

  const profileRows = await database
    .select({ userId: profilesTable.id, email: profilesTable.email })
    .from(profilesTable)
    .where(inArray(profilesTable.id, uniqueWinnerIds));
  const emailByUserId = new Map(profileRows.map((row) => [row.userId, row.email]));

  const inserted = await database
    .insert(sponsoredGiftCardAwardsTable)
    .values(uniqueWinnerIds.map((userId) => ({
      raceRoomId,
      userId,
      prizeAmountCents: awardByUserId.get(userId) ?? 0,
      currency,
      provider,
      recipientEmail: emailByUserId.get(userId) ?? null,
      metadata,
    })))
    .onConflictDoNothing()
    .returning({ id: sponsoredGiftCardAwardsTable.id });

  logger.info({
    raceRoomId,
    requested: uniqueWinnerIds.length,
    inserted: inserted.length,
  }, "[SponsoredGiftCards] pending awards ensured");

  return inserted.length;
}
