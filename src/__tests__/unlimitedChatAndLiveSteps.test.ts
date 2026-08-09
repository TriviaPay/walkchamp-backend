import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");
const route = read("src/routes/unlimitedChallenge.ts");
const races = read("src/routes/races.ts");
const walk = read("src/routes/walk.ts");

/** The Unlimited chat block, isolated from the rest of the router. */
const chatBlock = route.slice(
  route.indexOf("// Chat: comments + reactions"),
  route.indexOf("// ── GET /unlimited-challenges/:id/leaderboard"),
);

describe("Unlimited chat mirrors the race contract", () => {
  it("registers all four endpoints", () => {
    expect(route).toContain('router.get("/unlimited-challenges/:id/comments"');
    expect(route).toContain('router.post("/unlimited-challenges/:id/comments"');
    expect(route).toContain('router.get("/unlimited-challenges/:id/reactions"');
    expect(route).toContain('router.post("/unlimited-challenges/:id/reactions"');
  });

  it("returns the same comment fields the race endpoint returns", () => {
    // Field-for-field parity, including `raceRoomId`, so the existing chat component works
    // against an Unlimited challenge id with no client change.
    for (const field of [
      "id:", "raceRoomId:", "userId:", "username:", "countryFlag:", "avatarColor:",
      "text:", "createdAt:", "avatarUrl:", "avatarVersion:", "clientMessageId:",
    ]) {
      expect(chatBlock).toContain(field);
    }
    expect(chatBlock).toContain("comments: rows.map((r) => ({");
    expect(chatBlock).toContain("avatarVersion: r.avatarVersion?.getTime() ?? 0");
    expect(chatBlock).toContain("return res.json({ comment });");
  });

  it("keeps the same validation and limits as the race endpoint", () => {
    expect(chatBlock).toContain('return res.status(400).json({ error: "text is required" })');
    expect(chatBlock).toContain("clientMessageId.length <= 80");
    expect(chatBlock).toContain(".limit(60)");
    // Same emoji whitelist as the classic reaction set.
    const raceEmoji = /const VALID = (\[[^\]]+\])/.exec(races)?.[1];
    const unlimitedEmoji = /const VALID_REACTION_EMOJI = (\[[^\]]+\])/.exec(route)?.[1];
    expect(unlimitedEmoji).toBe(raceEmoji);
    expect(chatBlock).toContain('return res.status(400).json({ error: "Invalid emoji" })');
  });

  it("returns reactions as grouped emoji counts, like the race endpoint", () => {
    expect(chatBlock).toContain("return res.json({ reactions: rows });");
    expect(chatBlock).toContain("return res.json({ success: true, counts });");
    expect(chatBlock).toContain(".groupBy(liveRaceReactionsTable.emoji)");
  });

  it("reuses the live_race tables keyed by challenge id — no new table needed", () => {
    expect(chatBlock).toContain("eq(liveRaceCommentsTable.raceRoomId, challengeId)");
    expect(chatBlock).toContain("raceRoomId:  challengeId");
    expect(chatBlock).toContain("eq(liveRaceReactionsTable.raceRoomId, challengeId)");
    // Safe only because race_room_id is plain text with no FK to race_rooms.
    const schema = read("db/src/schema/liveRace.ts");
    expect(schema).toContain('raceRoomId: text("race_room_id").notNull()');
    expect(schema).not.toContain("references(");
  });
});

describe("chat membership is checked against unlimited participants", () => {
  it("gates on unlimited_challenge_participants, never race_participants", () => {
    expect(chatBlock).toContain("async function isUnlimitedChatParticipant");
    expect(chatBlock).toContain("eq(unlimitedChallengeParticipantsTable.challengeId, challengeId)");
    expect(chatBlock).toContain("eq(unlimitedChallengeParticipantsTable.userId, userId)");
    expect(chatBlock).not.toContain("isRaceParticipant");
    expect(chatBlock).not.toContain("raceParticipantsTable");
  });

  it("excludes left and disqualified participants", () => {
    expect(chatBlock).toContain('notInArray(unlimitedChallengeParticipantsTable.qualificationStatus, ["left", "disqualified"])');
  });

  it("refuses non-participants on both write endpoints", () => {
    expect(chatBlock).toContain('Only challenge participants can comment.');
    expect(chatBlock).toContain('Only challenge participants can react.');
    // Two guards, one per POST.
    expect(chatBlock.split("isUnlimitedChatParticipant(userId, challengeId)").length - 1).toBe(2);
  });

  it("does not gate the read endpoints, matching the race behaviour", () => {
    const getComments = chatBlock.slice(
      chatBlock.indexOf('router.get("/unlimited-challenges/:id/comments"'),
      chatBlock.indexOf('router.post("/unlimited-challenges/:id/comments"'),
    );
    expect(getComments).not.toContain("isUnlimitedChatParticipant");
  });
});

describe("chat broadcasts on the Unlimited channels", () => {
  it("uses the same fan-out helper as progress_updated", () => {
    expect(chatBlock).toContain('emitUnlimitedRealtime(challengeId, "comment_new", { comment }, {');
    expect(chatBlock).toContain('emitUnlimitedRealtime(challengeId, "reaction_updated", { counts }, {');
  });

  it("carries the classic event names on the compatibility channel", () => {
    // public-live-race-{id} is where the existing chat client already binds.
    expect(chatBlock).toContain('event: "race:comment_new"');
    expect(chatBlock).toContain('event: "race:reaction_updated"');
    const realtime = read("src/lib/unlimitedRealtime.ts");
    expect(realtime).toContain("`unlimited-challenge-${challengeId}`");
    expect(realtime).toContain("`public-live-race-${challengeId}`");
  });
});

describe("verified step totals broadcast progress_updated immediately", () => {
  it("POST /walk/steps emits progress_updated, not only the provisional endpoint", () => {
    const handler = walk.slice(walk.indexOf('router.post("/walk/steps"'), walk.indexOf('router.get("/walk/history"'));
    expect(handler).toContain('emitUnlimitedRealtime(d.challengeId, "progress_updated", payload');
    expect(handler).toContain('event: "race:progress_updated"');
    // Both the provisional-overlay payload and the verified-only fallback emit.
    expect(handler.split('"progress_updated"').length - 1).toBe(2);
  });

  it("resolves target challenges by locked window, not by the client's date", () => {
    const handler = walk.slice(walk.indexOf('router.post("/walk/steps"'), walk.indexOf('router.get("/walk/history"'));
    expect(handler).toContain("findActiveUnlimitedDaysForUser(userId, emitNow)");
    const resolver = read("src/lib/unlimitedLiveProgress.ts");
    expect(resolver).toContain("lte(unlimitedChallengeDaysTable.windowStartUtc, now)");
    expect(resolver).toContain("gt(unlimitedChallengeDaysTable.windowEndUtc, now)");
  });

  it("credits the day BEFORE broadcasting so the event carries the fresh total", () => {
    const handler = walk.slice(walk.indexOf('router.post("/walk/steps"'), walk.indexOf('router.get("/walk/history"'));
    expect(handler.indexOf("applyVerifiedStepsToUnlimitedDays")).toBeLessThan(
      handler.indexOf("findActiveUnlimitedDaysForUser"),
    );
    // One block, so the ordering actually holds rather than racing two IIFEs.
    expect(handler).toContain("// Credit + broadcast, in that order and in ONE block");
  });

  it("emits the same payload shape as the provisional endpoint", () => {
    const handler = walk.slice(walk.indexOf('router.post("/walk/steps"'), walk.indexOf('router.get("/walk/history"'));
    for (const field of [
      "challengeId", "userId", "participantId", "currentSteps", "verifiedTodaySteps",
      "provisionalTodaySteps", "progressSource", "verificationStatus", "dayNumber",
      "dailyGoalSteps", "goalReached", "challengeDayKey", "localDate", "timezone", "updatedAt",
    ]) {
      expect(handler).toContain(`${field}`);
    }
  });

  it("never claims goalReached from provisional steps", () => {
    const handler = walk.slice(walk.indexOf('router.post("/walk/steps"'), walk.indexOf('router.get("/walk/history"'));
    expect(handler).toContain("goalReached: currentSteps >= d.goalSteps");
    expect(handler).not.toContain("goalReached: displayedLiveSteps >=");
  });
});

describe("live-display baseline never reaches money", () => {
  const schema = read("db/src/schema/unlimitedChallenge.ts");
  const ingest = read("src/lib/unlimitedStepIngest.ts");

  it("is stored per participant-day, defaulted to 0", () => {
    expect(schema).toContain('startBaselineSteps: integer("start_baseline_steps").notNull().default(0)');
    expect(schema).toContain('baselineCapturedAt: timestamp("baseline_captured_at"');
    const sql = read("db/migrations/0028_unlimited_day_start_baseline.sql");
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "start_baseline_steps" integer DEFAULT 0 NOT NULL');
    expect(read("db/migrations/meta/_journal.json")).toContain("0028_unlimited_day_start_baseline");
  });

  it("is captured once, when the day row activates", () => {
    expect(ingest).toContain('const activating = day.dayStatus === "pending" && day.baselineCapturedAt == null');
    expect(ingest).toContain("...(activating ? { startBaselineSteps: baseline, baselineCapturedAt: now } : {})");
    // Capped by the day's own credited total so it can never exceed what the day holds.
    expect(ingest).toContain("Math.min(day.verifiedSteps, input.verifiedTotal)");
  });

  it("is exposed as raceStartBaselineSteps plus a derived challengeDaySteps", () => {
    const progress = read("src/lib/unlimitedLiveProgress.ts");
    expect(progress).toContain("raceStartBaselineSteps: cur?.startBaselineSteps ?? 0");
    expect(progress).toContain("challengeDaySteps: cur?.challengeDaySteps ?? displayToday");
    expect(route).toContain("raceStartBaselineSteps: live?.startBaselineSteps ?? 0");
    expect(walk).toContain("raceStartBaselineSteps: d.startBaselineSteps");
  });

  it("qualification and settlement still read the full daily total", () => {
    const jobs = read("src/lib/unlimitedChallengeJobs.ts");
    const settle = read("src/lib/unlimitedChallengeSettlement.ts");
    // Finalization compares the FULL verified total against the goal, never the baseline-adjusted
    // figure — the baseline is display sugar and must never decide a payout.
    expect(jobs).toContain("const passed = verified >= d.goalSteps;");
    expect(jobs).not.toContain("startBaselineSteps");
    expect(settle).not.toContain("startBaselineSteps");
    expect(settle).not.toContain("challengeDaySteps");
  });

  it("is floored at zero everywhere it is derived", () => {
    for (const source of [ingest, read("src/lib/unlimitedLiveProgress.ts"), walk, route]) {
      // Collapse whitespace so a derivation wrapped across lines is matched the same way.
      const flat = source.replace(/\s+/g, " ");
      const derivations = flat.match(/challengeDaySteps: [^,;]*[,;]/g) ?? [];
      for (const line of derivations) {
        if (line.includes("??")) continue; // fallback form, no subtraction
        if (/challengeDaySteps: (number|string);/.test(line)) continue; // type declaration
        expect(line).toContain("Math.max(0,");
      }
    }
  });
});
