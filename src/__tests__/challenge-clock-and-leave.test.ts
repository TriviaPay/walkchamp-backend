import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UNLIMITED_LEFT_STATUSES } from "../lib/unlimitedChallengeStatuses.js";

const MS_PER_HOUR = 60 * 60 * 1000;
const startedAt = new Date("2026-08-14T09:00:00Z");

// races.ts pulls in the whole route graph on import; the clock helper is pure, so import it
// lazily and only once rather than standing the module up per test.
async function loadDisplayChallengeEndAt() {
  const mod = await import("../routes/races.js");
  return mod.displayChallengeEndAt;
}

describe("displayed challenge clock", () => {
  it("gives a started classic race a 24h deadline when the column was never written", async () => {
    const displayChallengeEndAt = await loadDisplayChallengeEndAt();
    // The legacy shape: started before the start hook began writing challengeEndAt.
    const end = displayChallengeEndAt({
      challengeEndAt: null,
      challengeDurationDays: 0,
      startedAt,
      scheduledStartAt: null,
      type: "quick",
    });
    expect(end).not.toBeNull();
    expect(end!.getTime() - startedAt.getTime()).toBe(24 * MS_PER_HOUR);
  });

  it("gives a started sponsored event 3h, not 24h", async () => {
    const displayChallengeEndAt = await loadDisplayChallengeEndAt();
    const end = displayChallengeEndAt({
      challengeEndAt: null,
      challengeDurationDays: 0,
      startedAt,
      scheduledStartAt: null,
      type: "sponsored",
    });
    expect(end!.getTime() - startedAt.getTime()).toBe(3 * MS_PER_HOUR);
  });

  it("always prefers an explicitly stored challengeEndAt over the fallback", async () => {
    const displayChallengeEndAt = await loadDisplayChallengeEndAt();
    const stored = new Date("2026-08-20T00:00:00Z");
    const end = displayChallengeEndAt({
      challengeEndAt: stored,
      challengeDurationDays: 0,
      startedAt,
      scheduledStartAt: null,
      type: "quick",
    });
    expect(end!.toISOString()).toBe(stored.toISOString());
  });

  it("stays null before the race starts, so a waiting room shows no countdown", async () => {
    const displayChallengeEndAt = await loadDisplayChallengeEndAt();
    expect(
      displayChallengeEndAt({
        challengeEndAt: null,
        challengeDurationDays: 0,
        startedAt: null,
        scheduledStartAt: new Date("2026-08-15T09:00:00Z"),
        type: "quick",
      }),
    ).toBeNull();
  });

  it("leaves multi-day duration challenges to the existing derivation", async () => {
    const displayChallengeEndAt = await loadDisplayChallengeEndAt();
    const end = displayChallengeEndAt({
      challengeEndAt: null,
      challengeDurationDays: 7,
      startedAt,
      scheduledStartAt: null,
      type: "quick",
    });
    // 7 days from start — NOT collapsed to the 24h classic fallback.
    expect(end!.getTime() - startedAt.getTime()).toBe(7 * 24 * MS_PER_HOUR);
  });

  it("does not feed the settlement path — deriveChallengeEndAt keeps returning null there", () => {
    const races = readFileSync("src/routes/races.ts", "utf8");
    // raceEndAtForSettlement filters which finishers count; widening it would retroactively
    // exclude finishers on legacy in-progress races.
    expect(races).toContain("const raceEndAtForSettlement = deriveChallengeEndAt(room)");
    expect(races).not.toContain("const raceEndAtForSettlement = displayChallengeEndAt(room)");
  });
});

describe("unlimited leave idempotency", () => {
  it("treats every already-gone status as terminal, not just 'left'", () => {
    expect([...UNLIMITED_LEFT_STATUSES]).toEqual(
      expect.arrayContaining(["left", "forfeited", "quit"]),
    );

    const service = readFileSync("src/lib/unlimitedChallengeService.ts", "utf8");
    expect(service).toContain(
      "(UNLIMITED_LEFT_STATUSES as readonly string[]).includes(participant.qualificationStatus)",
    );
    // The old single-status check would let a forfeited row fall through and re-run the leave
    // path, rewriting status and attempting a second pre-start refund.
    expect(service).not.toContain('if (participant.qualificationStatus === "left") return');
  });
});

describe("push dedupe batching", () => {
  const pushService = readFileSync("src/lib/pushNotificationService.ts", "utf8");

  it("resolves the whole recipient batch in one query instead of one per user", () => {
    expect(pushService).toContain("inArray(pushNotificationLogsTable.userId, userIds)");
    // The sequential-await loop is what made a single global-chat message issue one Neon
    // round-trip per user. Neither dedupe helper may reintroduce it.
    expect(pushService).not.toMatch(/for \(const uid of userIds\)/);
  });

  it("keeps both dedupe helpers on the single batched implementation", () => {
    expect(pushService).toContain("return filterRecentlySentRecipients(userIds, dedupeKey)");
    expect(pushService.match(/async function filterRecentlySentRecipients/g)).toHaveLength(1);
  });
});
