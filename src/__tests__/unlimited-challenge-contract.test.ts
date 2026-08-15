import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Contract tests (source-grep) pinning the Unlimited Challenge wiring, money safety, idempotency,
// rollback flag, and "don't touch existing types" invariants. Pure money/window logic is covered by
// unlimitedChallengeMoney.test.ts + challengeDayWindow.test.ts.

const config = readFileSync("src/lib/config.ts", "utf8");
const service = readFileSync("src/lib/unlimitedChallengeService.ts", "utf8");
const settlement = readFileSync("src/lib/unlimitedChallengeSettlement.ts", "utf8");
const jobs = readFileSync("src/lib/unlimitedChallengeJobs.ts", "utf8");
const router = readFileSync("src/routes/unlimitedChallenge.ts", "utf8");
const worker = readFileSync("src/worker.ts", "utf8");
const scheduler = readFileSync("src/lib/scheduler.ts", "utf8");
const races = readFileSync("src/routes/races.ts", "utf8");
const coinsBattle = readFileSync("src/routes/coinsBattle.ts", "utf8");
const walk = readFileSync("src/routes/walk.ts", "utf8");
const membership = readFileSync("src/lib/challengeMembership.ts", "utf8");
const schema = readFileSync("db/src/schema/unlimitedChallenge.ts", "utf8");

describe("rollback flag", () => {
  it("is env-driven (FEATURE_UNLIMITED_GOAL) and gates the router", () => {
    expect(config).toContain("unlimitedGoalEnabled: parseBoolean(rawEnv.FEATURE_UNLIMITED_GOAL, true)");
    expect(router).toContain("if (!config.features.unlimitedGoalEnabled)");
    expect(router).toContain('code: "FEATURE_DISABLED"');
  });

  it("worker start/settle handlers are NOT behind the flag (in-flight challenges still complete)", () => {
    expect(worker).not.toMatch(/unlimitedGoalEnabled[\s\S]*unlimited\.start/);
    expect(worker).toContain('case "unlimited.start"');
    expect(worker).toContain('case "unlimited.settle"');
  });
});

describe("money safety (integer cents, fixed $0.50, no double charge)", () => {
  it("charges entry + fixed $0.50 platform fee via a dedicated idempotency key", () => {
    expect(service).toContain("debitAmountCents: computeTotalChargeCents(");
    expect(service).toContain("idempotencyKey: `unlimited_entry:${challenge.id}:${userId}`");
    expect(service).toContain("idempotencyKey: `unlimited_entry:${challengeId}:${userId}`");
  });

  it("join is idempotent — already-joined returns without re-charging or re-incrementing the pool", () => {
    expect(service).toContain("already joined — idempotent");
    expect(service).toContain("You cannot rejoin a challenge you left.");
  });

  it("pre-start leave decrements the pool + count (post-start leave leaves them intact)", () => {
    // Pre-start USD leave refunds the entry and removes the contribution from the pool.
    expect(service).toContain("GREATEST(${unlimitedChallengesTable.prizePoolCents} - ${participant.entryContributionCents}, 0)");
    // Count decrement is a lock-protected read-modify-write (see paid-leave-cancel.test.ts).
    expect(service).toContain("const nextCount = Math.max(challenge.paidParticipantCount - 1, 0)");
    expect(service).toContain('.limit(1).for("update")');
    // Post-start still keeps the contribution in the pool (guarded by the preStart branch).
    expect(service).toContain("Post-start: contribution stays in the pool");
  });
});

describe("one-blocking-challenge spans both systems", () => {
  it("service checks getBlockingMembership under a shared advisory lock", () => {
    expect(service).toContain("acquireOneChallengeLock(tx, userId)");
    expect(service).toContain("getBlockingMembership(tx, userId");
    expect(membership).toContain("regular_race_registration:${userId}"); // same lock key as races
  });
  it("race create/join also block against unlimited challenges (all entry paths)", () => {
    // Present on every race create + join guard (host-create, /races, quick-join-free, join, join-paid).
    expect((races.match(/getUnlimitedBlockingMembership\(db, userId\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("the unlimited blocking check is flag-gated + fail-open so it CANNOT break existing race paths", () => {
    // When the feature is off it returns null before touching the new tables; a query error also
    // returns null (fail-open) rather than 500-ing the existing race create/join flow.
    expect(membership).toContain("if (!config.features.unlimitedGoalEnabled) return null;");
    expect(membership).toContain("Fail-open");
    expect(membership).toMatch(/catch \(err\)[\s\S]*return null;/);
  });

  it("streak membership blocks non-sponsored classic registration and coins battle under the user lock", () => {
    expect(membership).toContain("notInArray(unlimitedChallengeParticipantsTable.qualificationStatus, [...UNLIMITED_NON_ACTIVE_STATUSES])");
    expect(membership).toContain("if (!failOpen) throw err;");

    const scheduledRegister = races.slice(
      races.indexOf('"/rooms/:roomId/register"'),
      races.indexOf('"/rooms/:roomId/cancel-registration"'),
    );
    expect(scheduledRegister).toContain('if (room.type !== "sponsored")');
    expect(scheduledRegister).toContain("getUnlimitedBlockingMembership(tx, userId, { failOpen: false })");
    expect(scheduledRegister).toContain("oneChallengeAtATimeConflictBody(unlimitedBlock)");

    expect(races).toContain("getActiveUnlimitedChallengeForUser");
    expect(races).toContain('challenge_type: "unlimited_goal"');

    expect(coinsBattle).toContain("acquireOneChallengeLock(tx, userId)");
    expect(coinsBattle).toContain('ne(raceRoomsTable.type, "sponsored")');
    expect(coinsBattle).toContain("getUnlimitedBlockingMembership(tx, userId, { failOpen: false })");
    expect(coinsBattle).toContain("oneChallengeAtATimeConflictBody(txUnlimitedBlock)");
  });
});

describe("leave: pre-start refund, post-start no refund, never cancels", () => {
  it("leave never cancels the challenge and there is no host-cancel endpoint", () => {
    expect(router).not.toContain("/cancel");
    expect(router).toContain("challengeContinues: true");
  });
  it("server-authoritative refund boundary + idempotent refund key", () => {
    expect(service).toContain("challenge.status === \"waiting\" && Date.now() < challenge.startAtUtc.getTime()");
    expect(service).toContain("`unlimited_leave:${challengeId}:${userId}`");
    expect(service).toContain('sourceType: "unlimited_challenge"');
  });
  it("entry is debited as refundable (entry fee), enabling the pre-start refund", () => {
    expect(service).toContain("refundableAmountCents: input.entryFeeCents");   // host auto-join
    expect(service).toContain("refundableAmountCents: challenge.entryFeeCents"); // joiner
  });
});

describe("settlement: equal split, idempotent, zero-winner policy", () => {
  it("claims active->settling via compare-and-set and equal-splits the pool", () => {
    expect(settlement).toContain('eq(unlimitedChallengesTable.status, "active")');
    expect(settlement).toContain("computeEqualSplit(pre.prizePoolCents");
  });
  it("payout rows are idempotent and wallet credit reuses the guarded credit helper", () => {
    expect(settlement).toContain("onConflictDoNothing()");
    expect(settlement).toContain("creditCashChallengePrizes(tx");
    expect(schema).toContain("unlimited_payouts_challenge_participant_uniq"); // one payout per participant
  });
  it("zero winners applies the configured policy without auto-crediting the platform", () => {
    expect(settlement).toContain('action: "unlimited_challenge.zero_winner"');
    expect(settlement).toContain("no auto-credit");
    expect(config).toContain('zeroWinnerPolicy: unlimitedGoalZeroWinnerPolicy');
  });

  it("refund_entry_contributions policy actually refunds entries idempotently (platform fee kept)", () => {
    expect(settlement).toContain('policy === "refund_entry_contributions"');
    expect(settlement).toContain("creditEntryRefunds(tx");
    const payments = readFileSync("src/lib/cashChallengePayments.ts", "utf8");
    expect(payments).toContain("export async function creditEntryRefunds");
    expect(payments).toContain("idempotencyKey: `refund:${input.sourceId}:${userId}`");
    expect(payments).toContain('transactionType: "race_entry_refund"');
  });
  it("settlement defers until all days are finalized", () => {
    expect(settlement).toContain("settlement deferred — days not finalized");
  });
});

describe("daily qualification: one failed day permanently disqualifies", () => {
  it("finalize marks passed/failed from verified daily totals and DQs on a miss", () => {
    expect(jobs).toContain("stepDailyTotalsTable");
    expect(jobs).toContain('disqualificationReason: "missed_daily_goal"');
    expect(jobs).toContain("passed ? now : null"); // passedAt only when passed
  });
  it("uses locked-tz per-day windows anchored to the challenge DATE (unique per participant/day)", () => {
    // Superseded assertion: this used to require buildDayWindows(pre.startAtUtc, p.tz), i.e.
    // projecting one shared UTC instant into each participant's zone. That is the India→US
    // early-start bug — windows now come from the challenge's calendar date resolved in each
    // participant's own timezone. See unlimitedLocalMidnightSchedule.test.ts.
    expect(jobs).toContain("materializeParticipantSchedule(db, {");
    expect(jobs).not.toContain("buildDayWindows(pre.startAtUtc");
    expect(schema).toContain("unlimited_days_participant_day_uniq");
  });
});

describe("durable jobs + reconciliation", () => {
  it("start/settle jobs are enqueued and reconciled", () => {
    expect(service).toContain('"unlimited.start"');
    expect(jobs).toContain('"unlimited.settle"');
    expect(scheduler).toContain("reconcileUnlimitedChallenges(now)");
  });
});

describe("capacity is explicitly unlimited (no fake max/full)", () => {
  it("serializer reports unlimited capacity and null max", () => {
    expect(router).toContain('capacityMode: "unlimited"');
    expect(router).toContain("maxParticipants: null");
  });
  it("listing + leaderboard are paginated (bounded responses)", () => {
    expect(router).toContain("pagination: { limit, offset");
    expect(router).toContain(".limit(limit)");
  });
  it("detail response includes all non-left players for waiting room rendering", () => {
    expect(router).toContain("loadChallengePlayers");
    expect(router).toContain("players,");
    expect(router).toContain("participants: players");
    const liveProgress = readFileSync("src/lib/unlimitedLiveProgress.ts", "utf8");
    const detail = router.slice(
      router.indexOf('router.get("/unlimited-challenges/:id"'),
      router.indexOf("// ── POST /unlimited-challenges/:id/live-progress"),
    );
    expect(detail).toContain("participantCount: players.length");
    expect(liveProgress).toContain("gt(unlimitedChallengeParticipantsTable.entryContributionCents, 0)");
    expect(liveProgress).toContain("notInArray(unlimitedChallengeParticipantsTable.qualificationStatus, [...UNLIMITED_NON_ACTIVE_STATUSES])");
    expect(liveProgress).toContain("isCurrentUser: p.userId === currentUserId");
  });

  it("my-active and detail expose the same challenge summary fields clients render from", () => {
    expect(router).toContain("async function loadChallengeParticipantCounts");
    const myActive = router.slice(
      router.indexOf('router.get("/unlimited-challenges/my-active"'),
      router.indexOf("// ── GET /unlimited-challenges (paginated public listing)"),
    );
    const detail = router.slice(
      router.indexOf('router.get("/unlimited-challenges/:id"'),
      router.indexOf("// ── POST /unlimited-challenges/:id/live-progress"),
    );
    for (const field of ["startAtUtc", "registrationClosesAtUtc", "resultsReadyAt", "createdAt"]) {
      expect(router).toContain(`${field} = isoOrNull(c.${field})`);
    }
    expect(router).toContain("function resolveChallengeEndAtIso");
    expect(router).toContain("const challengeEndAtUtc = resolveChallengeEndAtIso(c)");
    expect(router).toContain("challenge_end_at: challengeEndAtUtc");
    expect(router).toContain("prizePoolCents: c.prizePoolCents");
    expect(router).toContain("participantCount: opts.participantCount ?? c.paidParticipantCount");
    expect(myActive).toContain("const participantCount = participantCounts.get(r.challenge.id) ?? 0");
    expect(myActive).toContain("const viewer = await buildViewerSchedule(r.challenge, userId)");
    expect(myActive).toContain("...serializeChallenge(r.challenge, { participantCount })");
    expect(myActive).toContain("viewer,");
    expect(myActive).not.toContain("...(await buildViewerSchedule(r.challenge, userId))");
    expect(myActive).toContain("return res.json({ challenge: challenges[0] ?? null, challenges, count: challenges.length })");
    expect(detail).toContain("challenge: serializeChallenge(challenge, { participantCount: players.length })");
    expect(detail).not.toContain("challenge: {");
  });
});

describe("USD Unlimited strict midnight scheduling", () => {
  it("create path routes through the shared validateUnlimitedSchedule (no ad-hoc date checks)", () => {
    expect(service).toContain("validateUnlimitedSchedule({");
    expect(service).not.toContain("MIN_START_LEAD_MS"); // old ≥1h lead check removed
  });
  it("persists the resolved challenge timezone (optional input, host fallback)", () => {
    expect(service).toContain("input.challengeTimezone?.trim()");
    expect(service).toContain("challengeTimezone: timezone");
    expect(schema).toContain('challengeTimezone: text("challenge_timezone")');
    expect(router).toContain("challengeTimezone: z.string()");
    expect(router).toContain("challengeTimezone: c.challengeTimezone");
  });
  it("scheduling rules stay scoped to the unlimited path — the race engine is untouched", () => {
    expect(races).not.toContain("validateUnlimitedSchedule");
  });
});

describe("viewer membership on read paths (Next Race must not infer 'mine' from host id)", () => {
  it("list overlays the viewer's own membership per challenge (batched, terminal statuses excluded)", () => {
    expect(router).toContain("!UNLIMITED_NON_ACTIVE_STATUSES.includes");
    expect(router).toContain("participationStatus: status");
    // batched lookup via overlayMembership helper, not N+1
    expect(router).toContain("async function overlayMembership");
    expect(router).toContain("unlimitedChallengeParticipantsTable.challengeId");
    expect(router).toContain("rows.map((r) => r.id)");
  });
  it("list cards expose a trimmed roster and live paid count after membership overlay", () => {
    expect(router).toContain("async function overlayChallengeListCards");
    expect(router).toContain("loadChallengeParticipantCounts(challengeIds)");
    expect(router).toContain("participantCount: participantCounts.get(challenge.id) ?? 0");
    expect(router).toContain("players,");
    expect(router).toContain("participants: players");
    expect(router).toContain("async function loadActiveChallengeCardPlayers");
    expect(router).toContain("async function loadCompletedChallengeCardPlayers");
    expect(router).toContain("p.entry_contribution_cents > 0");
    expect(router).toContain("p.qualification_status NOT IN");
    expect(router).toContain("INNER JOIN unlimited_challenge_days d ON d.participant_id = p.id");

    const detail = router.slice(
      router.indexOf('router.get("/unlimited-challenges/:id"'),
      router.indexOf("// ── POST /unlimited-challenges/:id/live-progress"),
    );
    expect(detail).toContain("loadChallengePlayers(challengeId, userId, challenge.hostUserId)");
    expect(detail).not.toContain("overlayChallengeListCards");
  });
  it("detail exposes an explicit currentUserRegistered boolean alongside membership.status", () => {
    expect(router).toContain("membership.status as typeof UNLIMITED_NON_ACTIVE_STATUSES[number]");
  });
  it("leave response self-describes released membership + refundAmountCents alias", () => {
    expect(router).toContain("currentUserRegistered: false");
    expect(router).toContain("refundAmountCents: result.data.refundAmountCents");
    expect(races).toContain("currentUserRegistered: false");
    expect(races).toContain("refundAmountCents: refundAmount");
  });
});

describe("live step progress on unlimited challenges (no more hardcoded 0)", () => {
  it("detail players list computes live currentSteps from step_daily_totals, not a constant", () => {
    const liveProgress = readFileSync("src/lib/unlimitedLiveProgress.ts", "utf8");
    // shared helper owns the query — router must call it
    expect(router).toContain("loadChallengePlayers");
    // Display uses the provisional/verified lane split; the settlement total deliberately
    // uses verified-only so provisional live steps can never inflate a multi-day payout.
    expect(liveProgress).toContain("currentSteps: displayToday");
    expect(liveProgress).toContain("totalChallengeSteps: finalizedSteps + verifiedToday");
    expect(liveProgress).toContain("from(stepDailyTotalsTable)");
    expect(liveProgress).toContain("lte(unlimitedChallengeDaysTable.windowStartUtc, now)");
    expect(liveProgress).toContain("gt(unlimitedChallengeDaysTable.windowEndUtc, now)");
  });
  it("leaderboard currentSteps is active-day progress, not multi-day total", () => {
    expect(router).toContain("loadActiveDayProgressByChallenge");
    expect(router).not.toContain("currentSteps: r.totalSteps");
    expect(router).toContain("currentSteps,");
    expect(router).toContain("challengeDayKey: live?.challengeDayKey");
  });
  it("step ingestion broadcasts progress_updated on the unlimited-challenge channel", () => {
    expect(walk).toContain("emitUnlimitedRealtime");
    expect(walk).toContain('"progress_updated"');
    expect(walk).toContain("findActiveUnlimitedDaysForUser");
    // Classic Live Detail compatibility mirror
    expect(walk).toContain('event: "race:progress_updated"');
    expect(walk).toContain("challengeDayKey");
  });
});

describe("unified GET /races/my-upcoming ('mine' = active participation)", () => {
  it("merges scheduled fixed races (registered) + unlimited challenges (active participant)", () => {
    expect(races).toContain('router.get("/races/my-upcoming"');
    expect(races).toContain('eq(scheduledRoomRegistrationsTable.status, "registered")');
    expect(races).toContain("notInArray(unlimitedChallengeParticipantsTable.qualificationStatus, [...UNLIMITED_NON_ACTIVE_STATUSES])");
    expect(races).toContain('inArray(unlimitedChallengesTable.status, ["waiting", "starting", "active", "settling"])');
  });
  it("tags each item by kind and never treats host id alone as membership", () => {
    expect(races).toContain('kind: "fixed" as const');
    expect(races).toContain('kind: "unlimited" as const');
    expect(races).toContain("currentUserRegistered: true");
  });
});
