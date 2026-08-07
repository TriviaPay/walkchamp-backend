import { eq } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import { profilesTable, raceRoomsTable, unlimitedChallengesTable } from "../../db/src/schema/index.js";
import { generateReferralCode, generateRoomCode } from "./inviteCodes.js";
import { logger } from "./logger.js";

// Short (6-char) codes trade entropy for readability: 32^6 ≈ 1.07e9 values, so a birthday
// collision becomes likely somewhere around ~40k live codes. Every short code therefore goes
// through an allocator that probes the unique index before use, and every insert path also
// tolerates the (much rarer) lost-race case where two requests probe the same free code
// concurrently — see isUniqueViolation / withUniqueReferralCode below.

const MAX_ALLOCATION_ATTEMPTS = 12;

async function allocate(
  label: string,
  generate: () => string,
  isTaken: (code: string) => Promise<boolean>,
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
    const code = generate();
    if (!(await isTaken(code))) {
      if (attempt > 1) logger.warn({ label, attempt }, "[codes] short code needed a retry");
      return code;
    }
  }
  // Only reachable if the code space is effectively saturated — never silently widen the code,
  // because clients and printed material assume 6 characters.
  throw new Error(`Could not allocate a free ${label} after ${MAX_ALLOCATION_ATTEMPTS} attempts`);
}

/** 6-char join code for a private race room, unique across race_rooms. */
export function allocateRoomCode(): Promise<string> {
  return allocate("room code", generateRoomCode, async (code) => {
    const [row] = await db
      .select({ id: raceRoomsTable.id })
      .from(raceRoomsTable)
      .where(eq(raceRoomsTable.inviteCode, code))
      .limit(1);
    return !!row;
  });
}

/** 6-char join code for a private Unlimited Challenge, unique across unlimited_challenges. */
export function allocateChallengeCode(): Promise<string> {
  return allocate("challenge code", generateRoomCode, async (code) => {
    const [row] = await db
      .select({ id: unlimitedChallengesTable.id })
      .from(unlimitedChallengesTable)
      .where(eq(unlimitedChallengesTable.inviteCode, code))
      .limit(1);
    return !!row;
  });
}

/** 6-char invitation code for a new profile, unique across profiles. Issued once, never rotated. */
export function allocateReferralCode(): Promise<string> {
  return allocate("referral code", generateReferralCode, async (code) => {
    const [row] = await db
      .select({ id: profilesTable.id })
      .from(profilesTable)
      .where(eq(profilesTable.referralCode, code))
      .limit(1);
    return !!row;
  });
}

/** True when `err` is a Postgres unique violation on the given constraint/index. */
export function isUniqueViolation(err: unknown, constraintFragment: string): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === "23505" && !!e.constraint?.includes(constraintFragment);
}

/**
 * Run `insert` with a freshly allocated invitation code, retrying on the unique-index race where
 * another signup claimed the same code between our probe and our insert. Any other error (e.g. a
 * duplicate email) propagates untouched so callers keep their own handling.
 */
export async function withUniqueReferralCode<T>(insert: (referralCode: string) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const referralCode = await allocateReferralCode();
    try {
      return await insert(referralCode);
    } catch (err) {
      if (!isUniqueViolation(err, "referral_code")) throw err;
      lastErr = err;
      logger.warn({ attempt }, "[codes] referral code lost an insert race — retrying");
    }
  }
  throw lastErr;
}
