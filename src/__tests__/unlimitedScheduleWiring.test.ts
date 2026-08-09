import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Source-level guards for the Unlimited per-participant scheduling rewrite. The handlers are
// DB-heavy (same approach as audit-fixes-2026-07/08): the pure math is covered behaviourally in
// unlimitedLocalMidnightSchedule.test.ts, and these pin the wiring that could silently regress
// back to "one UTC instant for everyone".

const read = (p: string) => readFileSync(p, "utf8");

describe("the semantic calendar date is stored and used", () => {
  it("schema carries start_local_date and per-participant boundaries", () => {
    const schema = read("db/src/schema/unlimitedChallenge.ts");
    expect(schema).toContain('startLocalDate: date("start_local_date")');
    expect(schema).toContain('startLocalTime: text("start_local_time")');
    expect(schema).toContain('participantStartAtUtc: timestamp("participant_start_at_utc"');
    expect(schema).toContain('participantEndAtUtc: timestamp("participant_end_at_utc"');
    // Day uniqueness stays per participant — a local date is NOT globally unique across users.
    expect(schema).toContain('uniqueIndex("unlimited_days_participant_day_uniq").on(t.challengeId, t.participantId, t.dayNumber)');
  });

  it("create persists the date the host picked", () => {
    const service = read("src/lib/unlimitedChallengeService.ts");
    expect(service).toContain("const { startLocalDate, startAtUtc, challengeEndAtUtc } = schedule");
    expect(service).toContain("startLocalDate,");
    expect(service).toContain('startLocalTime: "00:00"');
    expect(service).toContain("challengeTimezone: timezone");
  });

  it("windows are built from the local date, never from the shared instant", () => {
    const sched = read("src/lib/unlimitedParticipantSchedule.ts");
    expect(sched).toContain("buildDayWindowsFromLocalDate(");
    expect(sched).toContain("resolveChallengeStartLocalDate(challenge)");

    // The old instant-anchored builder must not be reachable from any live path.
    for (const file of [
      "src/lib/unlimitedChallengeJobs.ts",
      "src/lib/unlimitedChallengeService.ts",
      "src/routes/unlimitedChallenge.ts",
      "src/routes/walk.ts",
    ]) {
      expect(read(file)).not.toContain("buildDayWindows(");
    }
  });
});

describe("join locks a timezone and materializes that participant's own schedule", () => {
  const service = read("src/lib/unlimitedChallengeService.ts");
  const joinFn = service.slice(
    service.indexOf("export async function joinUnlimitedChallenge"),
    service.indexOf("export async function leaveUnlimitedChallenge"),
  );

  it("locks the timezone on the membership row", () => {
    expect(joinFn).toContain("participantTimezone: tz");
    expect(service).toContain("resolveLockableTimezone(pref?.timezone)");
  });

  it("writes the participant's windows at join, not only at challenge start", () => {
    expect(joinFn).toContain("materializeParticipantSchedule(tx, {");
    expect(joinFn).toContain("timezone: tz");
  });

  it("cuts registration off at THIS joiner's local start, not the host's instant", () => {
    expect(joinFn).toContain("participantScheduleFor(");
    expect(joinFn).toContain("Date.now() >= joinerSchedule.startAtUtc.getTime()");
    // The host anchor must no longer be the registration cutoff.
    expect(joinFn).not.toContain("Date.now() >= challenge.startAtUtc.getTime()");
    // The refused response tells the client which boundary applied.
    expect(joinFn).toContain("participantStartAtUtc: joinerSchedule.startAtUtc.toISOString()");
  });

  it("the host auto-join uses the same materialization as any participant", () => {
    const createFn = service.slice(
      service.indexOf("export async function createUnlimitedChallenge"),
      service.indexOf("export async function joinUnlimitedChallenge"),
    );
    expect(createFn).toContain("materializeParticipantSchedule(tx, {");
    expect(createFn).toContain("timezone: hostTz");
  });
});

describe("activation follows the earliest participant, not the host", () => {
  const jobs = read("src/lib/unlimitedChallengeJobs.ts");

  it("start gate uses the minimum participant start", () => {
    expect(jobs).toContain("minParticipantStartAtUtc(challengeId)");
    expect(jobs).toContain("if (Date.now() < earliest.getTime()) return;");
    // A participant east of the host opens day 1 before the host does; waiting for the host would
    // silently drop their first hours.
    expect(jobs).not.toContain("if (pre.status === \"waiting\" && Date.now() < pre.startAtUtc.getTime()) return;");
  });

  it("the reconciler sweeps on participant starts too", () => {
    expect(jobs).toContain("lte(unlimitedChallengeParticipantsTable.participantStartAtUtc, now)");
  });

  it("materialization at start is a heal, and never moves existing days", () => {
    const sched = read("src/lib/unlimitedParticipantSchedule.ts");
    expect(sched).toContain("preserved: true");
    expect(sched).toContain("healMissingParticipantSchedules");
    // Existing day rows are the authority for a participant already mid-run.
    expect(sched).toContain("if ((existing?.count ?? 0) > 0");
  });
});

describe("settlement waits for the last participant on earth", () => {
  const settle = read("src/lib/unlimitedChallengeSettlement.ts");
  const results = read("src/lib/unlimitedResults.ts");

  it("gates on every participant's local end before the finalized-days check", () => {
    // The rule moved into unlimitedResults.areAllParticipantWindowsClosed, which counts against
    // the frozen settlement population instead of an ad-hoc MAX().
    expect(settle).toContain("areAllParticipantWindowsClosed(challengeId)");
    expect(settle).toContain("if (!closure.allClosed)");
    expect(settle.indexOf("areAllParticipantWindowsClosed")).toBeLessThan(
      settle.indexOf("areAllRequiredDaysTerminal"),
    );
  });

  it("refuses to settle when no participant end is resolvable", () => {
    // An unresolved end counts as PENDING, never as finished, so allClosed stays false.
    expect(results).toContain("unresolved: sql<number>`count(*) filter (");
    expect(results).toContain("allClosed: registered > 0 && unresolved === 0 && finished === registered");
  });

  it("still requires every required day to be finalized", () => {
    expect(settle).toContain("areAllRequiredDaysTerminal(challengeId)");
    expect(settle).toContain("if (!validation.allDaysTerminal)");
    expect(settle).toContain("settlement deferred — days not finalized");
    expect(results).toContain("inArray(unlimitedChallengeDaysTable.status, [...NON_TERMINAL_DAY_STATUSES])");
  });

  it("qualification and the equal split are unchanged", () => {
    // Qualified = passed every required day and did not leave/get disqualified — now expressed as
    // an explicit eligibility evaluation rather than an inline filter.
    expect(settle).toContain("evaluateParticipantEligibility(challengeId, pre.durationDays)");
    expect(settle).toContain('eligibility.filter((e) => e.status === "eligible")');
    expect(results).toContain("passedDays === durationDays");
    expect(settle).toContain("computeEqualSplit(pre.prizePoolCents");
  });

  it("excludes participants who left from holding settlement open", () => {
    const sched = read("src/lib/unlimitedParticipantSchedule.ts");
    const fn = sched.slice(sched.indexOf("export async function maxParticipantEndAtUtc"), sched.length);
    expect(fn).toContain("qualificationStatus} <> 'left'");
  });
});

describe("notifications use each participant's own boundaries", () => {
  const jobs = read("src/lib/unlimitedChallengeJobs.ts");

  it("start notifications are driven by participant_start_at_utc", () => {
    expect(jobs).toContain("export async function notifyDueParticipantStarts");
    expect(jobs).toContain("lte(unlimitedChallengeParticipantsTable.participantStartAtUtc, now)");
    expect(jobs).toContain("dedupeKey: `unlimited_started:${p.challengeId}:${p.userId}`");
  });

  it("the reconciler keeps notifying participants as their midnights arrive", () => {
    const reconcile = jobs.slice(jobs.indexOf("export async function reconcileUnlimitedChallenges"));
    expect(reconcile).toContain("notifyDueParticipantStarts(now)");
  });
});

describe("APIs return viewer-personalized state", () => {
  const route = read("src/routes/unlimitedChallenge.ts");

  it("detail and my-active both carry the viewer block", () => {
    expect(route).toContain("async function buildViewerSchedule");
    expect(route).toContain("...viewer,");
    expect(route).toContain("...(await buildViewerSchedule(r.challenge, userId))");
  });

  it("exposes the fields the Walk screen and the Android FGS need", () => {
    const fn = route.slice(route.indexOf("async function buildViewerSchedule"), route.indexOf("// ── POST /unlimited-challenges/host"));
    for (const field of [
      "startLocalDate", "durationDays", "viewerStatus", "viewerTimezone", "viewerStartAt", "viewerEndAt",
      "currentDayIndex", "currentDayLocalDate", "currentDayStartAt", "currentDayEndAt", "currentDayStatus",
      "remainingDaysAfterToday", "completedDays", "failedDays", "dailyGoalSteps", "currentSteps",
    ]) {
      expect(fn).toContain(`${field}:`);
    }
  });

  it("canJoin is evaluated against the viewer's own would-be start", () => {
    expect(route).toContain("participantScheduleFor(challenge, viewerTimezone).startAtUtc");
    expect(route).toContain("Date.now() < wouldStartAt.getTime()");
  });

  it("serializes the semantic date alongside the legacy instant", () => {
    expect(route).toContain("startLocalDate: c.startLocalDate");
    expect(route).toContain("hostTimezone: c.challengeTimezone");
    expect(route).toContain("startAtUtc: c.startAtUtc");
  });

  it("create accepts the semantic form and still accepts the legacy one", () => {
    expect(route).toContain("startLocalDate: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/).optional()");
    expect(route).toContain("startAtIso: z.string().optional()");
    expect(route).toContain("Provide startLocalDate (YYYY-MM-DD) or startAtIso.");
  });
});

describe("migration is additive and does not reinterpret running challenges", () => {
  const sql = read("db/migrations/0027_unlimited_participant_local_schedule.sql");

  it("only adds nullable/defaulted columns and an index", () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "start_local_date" date');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "participant_start_at_utc" timestamp with time zone');
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS");
    expect(sql).not.toMatch(/DROP\s+(COLUMN|TABLE)/i);
    expect(sql).not.toMatch(/ALTER COLUMN .* SET NOT NULL/i);
  });

  it("backfills participant schedules from existing day rows first", () => {
    // Day rows are what a running participant has already been living by; recomputing them could
    // retroactively pass or fail a day.
    const fromDays = sql.indexOf('MIN("window_start_utc")');
    const fromDate = sql.indexOf('AT TIME ZONE p."participant_timezone"');
    expect(fromDays).toBeGreaterThan(-1);
    expect(fromDays).toBeLessThan(fromDate);
    expect(sql).toContain('AND p."participant_start_at_utc" IS NULL');
  });

  it("records rather than invents timezone history it cannot reconstruct", () => {
    expect(sql).toContain("unlimited_challenge.local_schedule_backfill_uncertain");
    expect(sql).toContain('WHERE c."challenge_timezone" IS NULL');
  });

  it("is registered in the drizzle journal", () => {
    const journal = read("db/migrations/meta/_journal.json");
    expect(journal).toContain("0027_unlimited_participant_local_schedule");
  });
});

describe("Classic race timing is untouched", () => {
  it("no Unlimited scheduling helper leaks into the Classic race paths", () => {
    for (const file of ["src/routes/races.ts", "src/lib/raceIntegrity.ts", "src/lib/raceSettlement.ts"]) {
      const source = read(file);
      expect(source).not.toContain("unlimitedParticipantSchedule");
      expect(source).not.toContain("buildDayWindowsFromLocalDate");
      expect(source).not.toContain("participantScheduleFor");
    }
  });

  it("scheduled Classic rooms still start on one shared instant", () => {
    const races = read("src/routes/races.ts");
    // activateRoomAndStart remains the single synchronized transition for Classic rooms.
    expect(races).toContain("export async function activateRoomAndStart");
    expect(races).toContain("materializeRegistrations");
  });
});
