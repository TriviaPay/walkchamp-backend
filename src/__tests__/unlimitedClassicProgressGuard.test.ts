import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");
const races = read("src/routes/races.ts");
const walk = read("src/routes/walk.ts");
const route = read("src/routes/unlimitedChallenge.ts");

// Unlimited must look like a live race in the tray without ever writing classic race progress.
// Its steps go to /api/walk/steps (verified) and .../live-progress (provisional); the classic
// progress endpoint must terminate cleanly for an Unlimited id instead of 404-ing forever.

const progressHandler = races.slice(
  races.indexOf('router.post("/races/:id/progress"'),
  races.indexOf("// ── Forfeit / removal guard"),
);

describe("§1 classic progress short-circuits for Unlimited ids", () => {
  it("answers 200 skipped with the documented code and message", () => {
    expect(progressHandler).toContain('code: "UNLIMITED_USES_WALK_STEPS"');
    expect(progressHandler).toContain("skipped: true");
    expect(progressHandler).toContain(
      "Unlimited challenges use /api/walk/steps and /api/unlimited-challenges/:id/live-progress.",
    );
    // 200, not 404 — a 404 is retryable to native/outbox layers and produced the retry storm.
    const block = progressHandler.slice(progressHandler.indexOf("UNLIMITED_USES_WALK_STEPS") - 400);
    expect(block).toContain("return res.json({");
  });

  it("resolves the id against unlimited_challenges", () => {
    expect(progressHandler).toContain("from(unlimitedChallengesTable)");
    expect(progressHandler).toContain("eq(unlimitedChallengesTable.id, raceId)");
  });

  it("never creates a race_participants row on that path", () => {
    const guard = progressHandler.slice(
      progressHandler.indexOf("if (!participantData) {"),
      progressHandler.indexOf('return res.status(404).json({ error: "Participant not found" });'),
    );
    expect(guard).not.toContain("insert(");
    expect(guard).not.toContain("joinOrReviveParticipant");
    // The sponsored auto-create above is gated on a race_rooms row, which an Unlimited id lacks.
    expect(progressHandler).toContain('room?.type === "sponsored"');
  });

  it("still 404s for a genuinely unknown race id", () => {
    expect(progressHandler).toContain('return res.status(404).json({ error: "Participant not found" });');
  });

  it("costs the hot path nothing — the lookup sits on the not-found branch", () => {
    // A valid classic participant returns before the Unlimited lookup is ever reached.
    expect(progressHandler.indexOf("if (!participantData) {")).toBeLessThan(
      progressHandler.indexOf("from(unlimitedChallengesTable)"),
    );
  });
});

describe("§2 walk/steps reports what it credited", () => {
  const handler = walk.slice(walk.indexOf('router.post("/walk/steps"'), walk.indexOf('router.get("/walk/history"'));

  it("awaits the credit so the response is authoritative", () => {
    expect(handler).toContain("unlimitedCredits = await applyVerifiedStepsToUnlimitedDays({");
    // Must NOT be inside the fire-and-forget broadcast block any more.
    expect(handler.indexOf("unlimitedCredits = await")).toBeLessThan(
      handler.indexOf("// Broadcast, fire-and-forget"),
    );
  });

  it("returns an unlimited block with credited and skipped days", () => {
    expect(handler).toContain("unlimited: {");
    expect(handler).toContain("credited: unlimitedCredits");
    expect(handler).toContain("skipped: unlimitedCredits");
    expect(handler).toContain("verifiedSource: sessionVerified");
  });

  it("gives a machine code AND a human reason for a drift skip", () => {
    expect(handler).toContain('reason: "timezone_drift"');
    expect(handler).toContain('code: "DEVICE_DAY_NOT_CHALLENGE_DAY"');
    expect(handler).toContain("deviceLocalDate: today");
    expect(handler).toContain("lockedTimezone: c.timezone");
    // The message names both dates and the locked zone, so the client can explain it verbatim.
    expect(handler).toContain("Your device is on ${today} but this challenge day is ${c.localDate}");
  });

  it("credited entries carry the participant's own day identity", () => {
    expect(handler).toContain("challengeDayKey: c.localDate");
    expect(handler).toContain("participantTimezone: c.timezone");
    expect(handler).toContain("goalReached: c.goalReached");
    expect(handler).toContain("challengeDaySteps: c.challengeDaySteps");
  });

  it("still credits only verified Health Connect / HealthKit totals", () => {
    expect(handler).toContain("if (sessionVerified) {");
    const ingest = read("src/lib/unlimitedStepIngest.ts");
    expect(ingest).toContain('eq(unlimitedChallengesTable.status, "active")');
  });

  it("still emits progress_updated after crediting", () => {
    expect(handler).toContain('emitUnlimitedRealtime(d.challengeId, "progress_updated"');
    expect(handler.indexOf("unlimitedCredits = await")).toBeLessThan(
      handler.indexOf("findActiveUnlimitedDaysForUser"),
    );
  });
});

describe("§3 my-active restores the Unlimited tray after process death", () => {
  const viewerFn = route.slice(
    route.indexOf("async function buildViewerSchedule"),
    route.indexOf("// ── POST /unlimited-challenges/host"),
  );

  it("my-active carries the full viewer block", () => {
    expect(route).toContain("...(await buildViewerSchedule(r.challenge, userId))");
  });

  it("exposes every field the tray needs to rebuild itself", () => {
    for (const field of [
      "viewerStatus", "resultsStatus", "challengeDayKey", "participantTimezone",
      "dailyGoalSteps", "challengeDaySteps", "raceStartBaselineSteps",
      "prizePoolEligibilityStatus", "registeredParticipantCount",
      "participantsFinishedCount", "participantsPendingCount",
    ]) {
      expect(viewerFn).toContain(`${field}:`);
    }
  });

  it("tells the client which endpoints to write through", () => {
    expect(viewerFn).toContain("unlimitedDailyMode: true");
    expect(viewerFn).toContain('verifiedStepsEndpoint: "/api/walk/steps"');
    expect(viewerFn).toContain("provisionalStepsEndpoint: `/api/unlimited-challenges/${challenge.id}/live-progress`");
  });

  it("the day key is the PARTICIPANT's locked value, not the host's", () => {
    expect(viewerFn).toContain("challengeDayKey: state.currentDayLocalDate");
    expect(viewerFn).toContain("participantTimezone: state.viewerTimezone");
    // Detail prefers the viewer's own key over any roster-derived fallback.
    expect(route).toContain("viewer.challengeDayKey ??");
  });

  it("challengeDaySteps is floored at zero", () => {
    expect(viewerFn).toContain("challengeDaySteps: Math.max(0,");
  });
});

describe("live-progress day-key contract is unchanged", () => {
  it("rejects a wrong day key and names the expected one", () => {
    expect(route).toContain('code: "WRONG_CHALLENGE_DAY"');
    expect(route).toContain("expectedChallengeDayKey: dayRow.localDate");
    // The expected key comes from the participant's own window, not the challenge.
    expect(route).toContain("eq(unlimitedChallengeDaysTable.participantId, membership.participantId)");
    expect(route).toContain("lte(unlimitedChallengeDaysTable.windowStartUtc, now)");
  });

  it("still refuses non-provisional sources and non-participants", () => {
    expect(route).toContain('code: "INVALID_PROVISIONAL_SOURCE"');
    expect(route).toContain('error: "Not an active participant.", accepted: false');
  });
});

describe("guardrails that must not have moved", () => {
  it("provisional never writes step_daily_totals or settles", () => {
    const prov = read("src/lib/unlimitedProvisionalLive.ts");
    expect(prov).not.toContain("stepDailyTotalsTable");
    expect(prov).not.toContain("unlimitedChallengePayoutsTable");
    expect(prov).not.toContain("creditCashChallengePrizes");
  });

  it("settlement authority stays unlimited_challenge_days.verified_steps", () => {
    const settle = read("src/lib/unlimitedChallengeSettlement.ts");
    expect(settle).toContain("evaluateParticipantEligibility(challengeId, pre.durationDays)");
    expect(settle).not.toContain("provisional");
    const results = read("src/lib/unlimitedResults.ts");
    expect(results).toContain("filter (where ${unlimitedChallengeDaysTable.status} = 'passed')");
  });

  it("comments and reactions still check membership", () => {
    expect(route).toContain('notInArray(unlimitedChallengeParticipantsTable.qualificationStatus, ["left", "disqualified"])');
    expect(route.split("isUnlimitedChatParticipant(userId, challengeId)").length - 1).toBe(2);
  });

  it("classic race progress is otherwise untouched", () => {
    // The redis-live fast path and the Postgres fallback both still run for real races.
    expect(progressHandler).toContain("tryHandleRedisProgress(res, {");
    expect(progressHandler).toContain("config.features.redisLiveRaceEnabled");
  });
});
