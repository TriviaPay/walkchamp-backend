import { Router } from "express";
import { db } from "@db";
import {
  raceRoomsTable,
  raceParticipantsTable,
  profilesTable,
  coinBalancesTable,
  coinTransactionsTable,
} from "@db/schema";
import { eq, and, ne, inArray } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth";
import { z } from "zod";
import { triggerEvent } from "../lib/pusher";
import { logger } from "../lib/logger";
import { getCoinBalance } from "../lib/coinsService";

const router = Router();

const VALID_COIN_ENTRIES = [500, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];

// ── Helper: is user already in an active race? ───────────────────────────────
async function getActiveRaceForUser(userId: string) {
  const [row] = await db
    .select({ roomId: raceRoomsTable.id, roomStatus: raceRoomsTable.status })
    .from(raceRoomsTable)
    .innerJoin(
      raceParticipantsTable,
      and(
        eq(raceParticipantsTable.raceRoomId, raceRoomsTable.id),
        eq(raceParticipantsTable.userId, userId),
        inArray(raceParticipantsTable.status, ["joined", "active"]),
      ),
    )
    .where(inArray(raceRoomsTable.status, ["open", "full", "in_progress"]))
    .limit(1);
  return row ?? null;
}

// ── POST /api/coins-battle/host ───────────────────────────────────────────────
// Creates a Coins Battle waiting room. Coins are NOT deducted here —
// they are deducted for all participants when the host taps "Start Race".
const VALID_TRACK_LAYOUTS = [
  "bg", "bg1", "galaxy", "daylightStadium", "forest", "city",
  "lava", "ice", "candy", "farm", "underwater", "musicfest",
  "barbie", "desert", "gold", "nightforest", "skykingdom",
  "rain", "storm", "mountain", "waterfall", "webcity",
  "bridge", "newyork", "pirateisland", "paradise", "musicfest2",
  "chocolate", "fireworks", "moon", "rainbow_road", "runway", "toy_race", "water_park",
] as const;

const hostSchema = z.object({
  coinEntryAmount: z.number().int().refine((v) => VALID_COIN_ENTRIES.includes(v), {
    message: "Invalid coin entry amount",
  }),
  maxPlayers: z.number().int().min(2).max(10),
  targetSteps: z.number().int().min(50).max(1_000_000),
  trackLayout: z.enum(VALID_TRACK_LAYOUTS).default("bg"),
  isPrivate: z.boolean().default(false),
});

router.post("/coins-battle/host", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;

  const parsed = hostSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }

  const { coinEntryAmount, maxPlayers, targetSteps, trackLayout, isPrivate } = parsed.data;

  const alreadyActive = await getActiveRaceForUser(userId);
  if (alreadyActive) {
    return res.status(409).json({
      success: false,
      code: "ACTIVE_RACE_EXISTS",
      message: "You are already in an active race.",
      active_race_id: alreadyActive.roomId,
    });
  }

  // Soft balance check — actual deduction happens at race start
  const balance = await getCoinBalance(userId);
  if (balance.currentBalance < coinEntryAmount) {
    return res.status(402).json({
      error: "Insufficient coins",
      code: "INSUFFICIENT_COINS",
      currentBalance: balance.currentBalance,
      required: coinEntryAmount,
    });
  }

  const [room] = await db
    .insert(raceRoomsTable)
    .values({
      creatorId: userId,
      title: "Coins Battle",
      type: "quick",
      entryType: "coins_battle",
      entryAmountCents: 0,
      coinEntryAmount,
      coinPrizePool: 0,       // pool grows when coins are charged at race start
      targetSteps,
      maxPlayers,
      currentPlayers: 1,
      trackLayout,
      isPrivate,
      status: "open",
      scheduleType: "now",
    })
    .returning();

  const [participant] = await db
    .insert(raceParticipantsTable)
    .values({ raceRoomId: room.id, userId, status: "joined" })
    .returning();

  logger.info({ raceId: room.id, userId, coinEntryAmount, maxPlayers }, "[CoinsBattle] room created (coins held until start)");

  triggerEvent("public-rooms-available", "room:created", {
    room_id: room.id,
    entry_type: "coins_battle",
    coin_entry_amount: coinEntryAmount,
    coin_prize_pool: 0,
    current_players: 1,
    max_players: maxPlayers,
  }).catch(() => {});

  triggerEvent("public-presence", "coins_battle.created", {
    room_id: room.id,
    coinEntryAmount,
    hostUserId: userId,
  }).catch(() => {});

  return res.status(201).json({
    success: true,
    raceId: room.id,
    race: room,
    participant,
    coinBalance: balance.currentBalance,
  });
});

// ── POST /api/coins-battle/:id/join ──────────────────────────────────────────
// Joins a Coins Battle waiting room. Coins are NOT deducted here —
// they are deducted for all participants when the host taps "Start Race".
router.post("/coins-battle/:id/join", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const raceId = String(req.params.id);

  const [room] = await db
    .select()
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.id, raceId))
    .limit(1);

  if (!room) return res.status(404).json({ error: "Room not found" });
  if (room.entryType !== "coins_battle") return res.status(400).json({ error: "Not a Coins Battle room" });
  if (room.status !== "open") return res.status(409).json({ error: "Room is not open for joining", code: "ROOM_NOT_OPEN" });
  if (room.currentPlayers >= room.maxPlayers) return res.status(409).json({ error: "Room is full", code: "ROOM_FULL" });

  const alreadyActive = await getActiveRaceForUser(userId);
  if (alreadyActive) {
    return res.status(409).json({
      success: false,
      code: "ACTIVE_RACE_EXISTS",
      message: "You are already in an active race.",
      active_race_id: alreadyActive.roomId,
    });
  }

  const [existingParticipant] = await db
    .select({ id: raceParticipantsTable.id })
    .from(raceParticipantsTable)
    .where(
      and(
        eq(raceParticipantsTable.raceRoomId, raceId),
        eq(raceParticipantsTable.userId, userId),
        ne(raceParticipantsTable.status, "left"),
      ),
    )
    .limit(1);

  if (existingParticipant) {
    return res.status(409).json({ error: "Already joined this room", code: "ALREADY_JOINED" });
  }

  // Soft balance check — actual deduction happens at race start
  const balance = await getCoinBalance(userId);
  if (balance.currentBalance < room.coinEntryAmount) {
    return res.status(402).json({
      error: "Insufficient coins",
      code: "INSUFFICIENT_COINS",
      currentBalance: balance.currentBalance,
      required: room.coinEntryAmount,
    });
  }

  const [participant] = await db
    .insert(raceParticipantsTable)
    .values({ raceRoomId: raceId, userId, status: "joined" })
    .returning();

  const newPlayerCount = room.currentPlayers + 1;

  const [updatedRoom] = await db
    .update(raceRoomsTable)
    .set({
      currentPlayers: newPlayerCount,
      status: newPlayerCount >= room.maxPlayers ? "full" : "open",
      updatedAt: new Date(),
    })
    .where(eq(raceRoomsTable.id, raceId))
    .returning();

  const profile = await db
    .select({ username: profilesTable.username, avatarColor: profilesTable.avatarColor, countryFlag: profilesTable.countryFlag })
    .from(profilesTable)
    .where(eq(profilesTable.id, userId))
    .limit(1);

  logger.info({ raceId, userId, newPlayerCount }, "[CoinsBattle] player joined (coins held until start)");

  triggerEvent(`public-live-race-${raceId}`, "coins_battle.joined", {
    raceId,
    userId,
    username: profile[0]?.username ?? "Player",
    avatarColor: profile[0]?.avatarColor ?? "#00E676",
    countryFlag: profile[0]?.countryFlag ?? "🏳️",
    currentPlayers: updatedRoom.currentPlayers,
    maxPlayers: updatedRoom.maxPlayers,
    coinPrizePool: updatedRoom.coinPrizePool,
  }).catch(() => {});

  triggerEvent("public-rooms-available", "room:participant_joined", {
    room_id: raceId,
    current_players: updatedRoom.currentPlayers,
    coin_prize_pool: updatedRoom.coinPrizePool,
  }).catch(() => {});

  triggerEvent(`private-user-${room.creatorId}`, "coins_battle.joined", {
    raceId,
    newPlayer: { username: profile[0]?.username ?? "Player" },
    currentPlayers: updatedRoom.currentPlayers,
  }).catch(() => {});

  return res.json({
    success: true,
    raceId,
    participant,
    currentPlayers: updatedRoom.currentPlayers,
    coinPrizePool: updatedRoom.coinPrizePool,
    coinBalance: balance.currentBalance,
  });
});

// ── POST /api/coins-battle/:id/cancel ────────────────────────────────────────
// Cancels the waiting room before the race starts.
// Since coins are only charged at race start, no refunds are needed.
router.post("/coins-battle/:id/cancel", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const raceId = String(req.params.id);

  const [room] = await db
    .select()
    .from(raceRoomsTable)
    .where(eq(raceRoomsTable.id, raceId))
    .limit(1);

  if (!room) return res.status(404).json({ error: "Room not found" });
  if (room.entryType !== "coins_battle") return res.status(400).json({ error: "Not a Coins Battle room" });
  if (room.creatorId !== userId) return res.status(403).json({ error: "Only the host can cancel this room." });
  if (room.status !== "open" && room.status !== "full") {
    return res.status(409).json({ error: "Only open rooms can be cancelled." });
  }

  await db
    .update(raceRoomsTable)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(raceRoomsTable.id, raceId));

  const participants = await db
    .select({ userId: raceParticipantsTable.userId })
    .from(raceParticipantsTable)
    .where(and(eq(raceParticipantsTable.raceRoomId, raceId), ne(raceParticipantsTable.status, "left")));

  logger.info({ raceId, userId, playerCount: participants.length }, "[CoinsBattle] room cancelled (no coins charged)");

  triggerEvent(`public-live-race-${raceId}`, "coins_battle.cancelled", { raceId, refundCoins: 0 }).catch(() => {});
  triggerEvent("public-rooms-available", "room:cancelled", { room_id: raceId }).catch(() => {});

  for (const p of participants) {
    triggerEvent(`private-user-${p.userId}`, "coins_battle.cancelled", { raceId }).catch(() => {});
  }

  return res.json({ success: true, cancelled: true });
});

export default router;
