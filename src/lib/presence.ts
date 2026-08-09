import { and, gte, ne, type SQL } from "drizzle-orm";
import { userPresenceTable } from "../../db/src/schema/index.js";

// Online  = last_seen_at within 90 seconds
// Walking = last_walk_activity_at within 5 minutes
// These thresholds are shared by every presence-derived surface (summary counts, scoped online
// lists, invite candidates) so the "X online" badge and the lists below it never disagree.
export const ONLINE_THRESHOLD_MS = 90_000;
export const WALKING_THRESHOLD_MS = 5 * 60_000;

export function onlineAfter(): Date {
  return new Date(Date.now() - ONLINE_THRESHOLD_MS);
}

export function walkingAfter(): Date {
  return new Date(Date.now() - WALKING_THRESHOLD_MS);
}

/**
 * The filter every scoped presence endpoint applies: a fresh heartbeat AND a status the user has
 * not explicitly turned off. `POST /presence/offline` only flips status, it does not backdate
 * last_seen_at, so the freshness check alone would keep a signed-off user "online" for 90s.
 */
export function isOnlineNow(): SQL {
  return and(
    gte(userPresenceTable.lastSeenAt, onlineAfter()),
    ne(userPresenceTable.status, "offline"),
  ) as SQL;
}
