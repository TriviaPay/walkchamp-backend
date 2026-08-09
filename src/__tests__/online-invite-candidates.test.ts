import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { ONLINE_THRESHOLD_MS, isOnlineNow, onlineAfter, walkingAfter } from "../lib/presence.js";

// The Waiting Room "Online Players" tab reads GET /api/races/:id/online-invite-candidates. Two
// things kept it wrong: it computed its own presence window, and it dropped everyone already in
// the room. These guard both. The handler itself is DB-heavy, so it is asserted at the source
// level (same approach as audit-fixes-2026-07/08).

const read = (p: string) => readFileSync(p, "utf8");

const candidatesBlock = () => {
  const races = read("src/routes/races.ts");
  return races.slice(
    races.indexOf('router.get("/races/:id/online-invite-candidates"'),
    races.indexOf('router.post("/races/:id/invites"'),
  );
};

describe("shared presence window", () => {
  it("is the 90s window every presence surface agrees on", () => {
    expect(ONLINE_THRESHOLD_MS).toBe(90_000);

    const delta = Date.now() - onlineAfter().getTime();
    expect(delta).toBeGreaterThanOrEqual(90_000);
    expect(delta).toBeLessThan(91_000);

    expect(Date.now() - walkingAfter().getTime()).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it("requires a fresh heartbeat AND a non-offline status", () => {
    // POST /presence/offline only flips status; it does not backdate last_seen_at, so freshness
    // alone would keep a signed-off user visible for another 90 seconds.
    const { sql } = new PgDialect().sqlToQuery(isOnlineNow());
    expect(sql).toContain("last_seen_at");
    expect(sql).toContain(">=");
    expect(sql).toContain("<>");
  });

  it("is used by the scoped presence routes and the invite candidates route", () => {
    const presence = read("src/routes/presence.ts");
    expect(presence).toContain('from "../lib/presence.js"');
    // No route may re-derive its own cutoff.
    expect(presence).not.toContain("Date.now() - 90_000");
    expect(presence).not.toContain('ne(userPresenceTable.status, "offline")');

    const block = candidatesBlock();
    expect(block).toContain("isOnlineNow()");
    expect(block).not.toContain("Date.now() - 90_000");
    expect(block).not.toContain("lastSeenAt} > ");
  });
});

describe("online invite candidates include the people already in the room", () => {
  it("tags membership from both participants and scheduled registrations", () => {
    const block = candidatesBlock();
    expect(block).toContain("raceParticipantsTable");
    expect(block).toContain("scheduledRoomRegistrationsTable");
    expect(block).toContain('membershipByUser.set(r.userId, "registered")');
    expect(block).toContain('membershipByUser.set(j.userId, "joined")');
    expect(block).toContain("hasJoined");
    expect(block).toContain("membership,");
  });

  it("returns members instead of filtering them out", () => {
    const block = candidatesBlock();
    // The old handler built a joinedIds set purely to drop those users from the response.
    expect(block).not.toContain("joinedIds");
    expect(block).toContain("inArray(profilesTable.id, memberIds)");
    expect(block).toContain("notInArray(profilesTable.id, memberIds)");
  });

  it("never lets a busy lobby truncate the room's own players", () => {
    const block = candidatesBlock();
    // Members come from their own uncapped query; only strangers are limited.
    expect(block).toContain("NON_MEMBER_CANDIDATE_LIMIT");
    expect(block).toContain("...onlineMembers.map(toCandidate)");
    expect(block.indexOf("onlineMembers.map(toCandidate)"))
      .toBeLessThan(block.indexOf("others.filter((c) => c.isFriend)"));
  });

  it("keeps friends in the list and never marks a member as invitable", () => {
    const block = candidatesBlock();
    expect(block).toContain("isFriend: friendIds.has(u.userId)");
    expect(block).toContain('inviteStatus: hasJoined ? "none"');
  });

  it("still excludes the host and blocked users from the invitable set", () => {
    const block = candidatesBlock();
    expect(block).toContain("membershipByUser.delete(currentUserId)");
    expect(block).toContain("const excludedIds = [currentUserId, ...blockedIds]");
    expect(block).toContain("notInArray(profilesTable.id, excludedIds)");
    expect(block).toContain("Only the host can view candidates");
  });
});
