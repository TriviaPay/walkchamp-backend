import { describe, expect, it } from "vitest";
import {
  buildDayWindowsFromLocalDate,
  computeParticipantSchedule,
  parseLocalDate,
  validateUnlimitedSchedule,
} from "../lib/challengeDayWindow.js";
import { deriveViewerState, type ScheduleSourceChallenge } from "../lib/unlimitedParticipantSchedule.js";

// The reported bug: a host in Asia/Kolkata picked 2026-08-09 12:00 AM and a participant in
// America/Chicago was started around Aug 8 in the AFTERNOON, Chicago time. The schedule was one
// shared UTC instant; every participant's days were derived by projecting that instant into their
// own zone. These tests pin the rule that replaces it — the schedule is a CALENDAR DATE, and every
// participant begins at 00:00 on that date in their own locked timezone.

const CHALLENGE_DATE = "2026-08-09";

/** Wall-clock rendering of an instant in a zone — how the participant's phone would show it. */
function wallClock(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(instant).replace(", ", " ");
}

describe("creation keeps the semantic calendar date", () => {
  it("stores the date the host picked, not a timezone-shifted one", () => {
    const result = validateUnlimitedSchedule({
      startLocalDate: CHALLENGE_DATE,
      durationDays: 7,
      timezone: "Asia/Kolkata",
      nowMs: Date.parse("2026-08-01T00:00:00Z"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.startLocalDate).toBe("2026-08-09");
    // The host anchor is still IST midnight, for audit and ordering.
    expect(result.startAtUtc.toISOString()).toBe("2026-08-08T18:30:00.000Z");
  });

  it("accepts the legacy instant form and reduces it to the same date", () => {
    const legacy = validateUnlimitedSchedule({
      startAtIso: "2026-08-08T18:30:00.000Z", // = 2026-08-09 00:00 IST
      durationDays: 7,
      timezone: "Asia/Kolkata",
      nowMs: Date.parse("2026-08-01T00:00:00Z"),
    });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    expect(legacy.startLocalDate).toBe("2026-08-09");
  });

  it("rejects a bad duration, a junk timezone, a fake date and a past date", () => {
    const base = { startLocalDate: CHALLENGE_DATE, timezone: "Asia/Kolkata", nowMs: Date.parse("2026-08-01T00:00:00Z") };
    expect(validateUnlimitedSchedule({ ...base, durationDays: 14 })).toMatchObject({ code: "invalid_duration" });
    expect(validateUnlimitedSchedule({ ...base, durationDays: 7, timezone: "Not/AZone" })).toMatchObject({ code: "invalid_timezone" });
    expect(validateUnlimitedSchedule({ ...base, durationDays: 7, startLocalDate: "2026-02-31" })).toMatchObject({ code: "invalid_start" });
    expect(validateUnlimitedSchedule({ ...base, durationDays: 7, nowMs: Date.parse("2026-08-20T00:00:00Z") })).toMatchObject({ code: "start_not_future" });
    // Abbreviations are not IANA identifiers and carry no DST rules.
    expect(validateUnlimitedSchedule({ ...base, durationDays: 7, timezone: "IST" })).toMatchObject({ code: "invalid_timezone" });
  });

  it("parseLocalDate rejects non-calendar dates", () => {
    expect(parseLocalDate("2026-08-09")).toEqual({ year: 2026, month: 8, day: 9 });
    expect(parseLocalDate("2026-02-31")).toBeNull();
    expect(parseLocalDate("2026-13-01")).toBeNull();
    expect(parseLocalDate("garbage")).toBeNull();
  });
});

describe("every participant starts at 12:00 AM on the challenge date, in their own zone", () => {
  const cases = [
    { tz: "Asia/Kolkata", expectedUtc: "2026-08-08T18:30:00.000Z" },
    { tz: "America/Chicago", expectedUtc: "2026-08-09T05:00:00.000Z" },
    { tz: "America/New_York", expectedUtc: "2026-08-09T04:00:00.000Z" },
    { tz: "Europe/London", expectedUtc: "2026-08-08T23:00:00.000Z" },
  ];

  for (const { tz, expectedUtc } of cases) {
    it(`${tz} day 1 opens at local midnight on ${CHALLENGE_DATE}`, () => {
      const s = computeParticipantSchedule({ startLocalDate: CHALLENGE_DATE, timezone: tz, durationDays: 7, goalSteps: 10000 });
      expect(s.startAtUtc.toISOString()).toBe(expectedUtc);
      // The participant's own phone reads exactly midnight on the chosen date.
      expect(wallClock(s.startAtUtc, tz)).toBe("2026-08-09 00:00");
      expect(s.windows[0].localDate).toBe(CHALLENGE_DATE);
    });
  }

  it("REGRESSION: a Chicago participant is not started on Aug 8 afternoon", () => {
    const s = computeParticipantSchedule({ startLocalDate: CHALLENGE_DATE, timezone: "America/Chicago", durationDays: 7, goalSteps: 10000 });
    const local = wallClock(s.startAtUtc, "America/Chicago");
    expect(local).not.toContain("2026-08-08");
    expect(local).toBe("2026-08-09 00:00");
    // The host's IST anchor is what the old code handed to everyone — it lands mid-afternoon here.
    expect(wallClock(new Date("2026-08-08T18:30:00.000Z"), "America/Chicago")).toBe("2026-08-08 13:30");
  });

  it("REGRESSION: a US host does not push an India participant onto the next day", () => {
    // Host in Chicago; the old instant-projection put India's day 1 on Aug 10 IST.
    const india = computeParticipantSchedule({ startLocalDate: CHALLENGE_DATE, timezone: "Asia/Kolkata", durationDays: 7, goalSteps: 10000 });
    expect(india.windows[0].localDate).toBe("2026-08-09");
    expect(wallClock(india.startAtUtc, "Asia/Kolkata")).toBe("2026-08-09 00:00");
  });

  it("the host is scheduled by the same rule as everyone else", () => {
    const host = computeParticipantSchedule({ startLocalDate: CHALLENGE_DATE, timezone: "Asia/Kolkata", durationDays: 7, goalSteps: 10000 });
    const guest = computeParticipantSchedule({ startLocalDate: CHALLENGE_DATE, timezone: "Asia/Kolkata", durationDays: 7, goalSteps: 10000 });
    expect(host.startAtUtc.toISOString()).toBe(guest.startAtUtc.toISOString());
  });
});

describe("duration produces exactly N windows and a calendar-correct end", () => {
  const expectedEnds: Record<number, string> = {
    7: "2026-08-16",
    10: "2026-08-19",
    30: "2026-09-08",
    60: "2026-10-08",
    90: "2026-11-07",
  };

  for (const duration of [7, 10, 30, 60, 90]) {
    it(`${duration} days → ${duration} windows, exclusive end ${expectedEnds[duration]} 00:00 local`, () => {
      const tz = "America/Chicago";
      const s = computeParticipantSchedule({ startLocalDate: CHALLENGE_DATE, timezone: tz, durationDays: duration, goalSteps: 10000 });
      expect(s.windows).toHaveLength(duration);
      expect(s.windows[0].localDate).toBe(CHALLENGE_DATE);
      expect(s.windows.map((w) => w.dayNumber)).toEqual(
        Array.from({ length: duration }, (_, i) => i + 1),
      );
      // Exclusive end = midnight opening the day AFTER the last required date.
      expect(wallClock(s.endAtUtc, tz)).toBe(`${expectedEnds[duration]} 00:00`);
      // Windows tile the run with no gap or overlap.
      for (let i = 1; i < s.windows.length; i++) {
        expect(s.windows[i].windowStartUtc.toISOString()).toBe(s.windows[i - 1].windowEndUtc.toISOString());
      }
    });
  }

  it("never uses start + N*24h — the 90-day run crosses DST and is not 90*24 hours", () => {
    const s = computeParticipantSchedule({ startLocalDate: CHALLENGE_DATE, timezone: "America/Chicago", durationDays: 90, goalSteps: 10000 });
    const elapsedHours = (s.endAtUtc.getTime() - s.startAtUtc.getTime()) / 3_600_000;
    // 2026-11-01 falls back inside this range, so the run is one hour LONGER than 90*24.
    expect(elapsedHours).toBe(90 * 24 + 1);
  });
});

describe("DST: a local day stays one challenge day whatever its UTC length", () => {
  it("spring forward is a 23-hour day and does not shift any local date", () => {
    // 2026-03-08, America/Chicago.
    const w = buildDayWindowsFromLocalDate("2026-03-06", "America/Chicago", 7, 10000);
    const dst = w.find((d) => d.localDate === "2026-03-08")!;
    expect((dst.windowEndUtc.getTime() - dst.windowStartUtc.getTime()) / 3_600_000).toBe(23);
    expect(w.map((d) => d.localDate)).toEqual([
      "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12",
    ]);
    expect(wallClock(dst.windowStartUtc, "America/Chicago")).toBe("2026-03-08 00:00");
  });

  it("fall back is a 25-hour day and does not shift any local date", () => {
    // 2026-11-01, America/Chicago.
    const w = buildDayWindowsFromLocalDate("2026-10-30", "America/Chicago", 7, 10000);
    const dst = w.find((d) => d.localDate === "2026-11-01")!;
    expect((dst.windowEndUtc.getTime() - dst.windowStartUtc.getTime()) / 3_600_000).toBe(25);
    expect(wallClock(dst.windowStartUtc, "America/Chicago")).toBe("2026-11-01 00:00");
    expect(wallClock(dst.windowEndUtc, "America/Chicago")).toBe("2026-11-02 00:00");
  });

  it("every day in a 90-day Southern-Hemisphere run still starts at local midnight", () => {
    // Australia/Sydney springs forward 2026-10-04 — the opposite direction from the US.
    const w = buildDayWindowsFromLocalDate("2026-09-15", "Australia/Sydney", 90, 10000);
    for (const d of w) {
      expect(wallClock(d.windowStartUtc, "Australia/Sydney")).toBe(`${d.localDate} 00:00`);
    }
    const springForward = w.find((d) => d.localDate === "2026-10-04")!;
    expect((springForward.windowEndUtc.getTime() - springForward.windowStartUtc.getTime()) / 3_600_000).toBe(23);
  });
});

// ── Viewer-personalized status ────────────────────────────────────────────────

const challenge: ScheduleSourceChallenge = {
  id: "ch-1",
  startLocalDate: CHALLENGE_DATE,
  challengeTimezone: "Asia/Kolkata",
  startAtUtc: new Date("2026-08-08T18:30:00.000Z"),
  durationDays: 7,
  dailyGoalSteps: 10000,
};

function participantFor(tz: string, qualificationStatus = "active") {
  const s = computeParticipantSchedule({ startLocalDate: CHALLENGE_DATE, timezone: tz, durationDays: 7, goalSteps: 10000 });
  return {
    participant: {
      participantTimezone: tz,
      participantStartAtUtc: s.startAtUtc,
      participantEndAtUtc: s.endAtUtc,
      qualificationStatus,
    },
    days: s.windows.map((w) => ({
      dayNumber: w.dayNumber,
      localDate: w.localDate,
      windowStartUtc: w.windowStartUtc,
      windowEndUtc: w.windowEndUtc,
      status: "pending",
    })),
  };
}

describe("one participant may be active while another is still scheduled", () => {
  // 2026-08-08 20:00Z: 01:30 Aug 9 in India (running), 15:00 Aug 8 in Chicago (not yet).
  const now = new Date("2026-08-08T20:00:00.000Z");

  it("India is active at the same instant Chicago is scheduled", () => {
    const india = deriveViewerState({ challenge, ...participantFor("Asia/Kolkata"), now });
    const chicago = deriveViewerState({ challenge, ...participantFor("America/Chicago"), now });

    expect(india.viewerStatus).toBe("active");
    expect(india.currentDayIndex).toBe(1);
    expect(india.currentDayLocalDate).toBe("2026-08-09");

    expect(chicago.viewerStatus).toBe("scheduled");
    expect(chicago.currentDayIndex).toBeNull();
    expect(chicago.viewerStartAt?.toISOString()).toBe("2026-08-09T05:00:00.000Z");
    expect(chicago.remainingDaysAfterToday).toBe(7);
  });

  it("reports the viewer's own current day, not a challenge-wide one", () => {
    // Aug 12 06:00Z: India is on day 4 (11:30 Aug 12 IST), Chicago on day 3 (01:00 Aug 12 CDT).
    const mid = new Date("2026-08-12T06:00:00.000Z");
    const india = deriveViewerState({ challenge, ...participantFor("Asia/Kolkata"), now: mid });
    const chicago = deriveViewerState({ challenge, ...participantFor("America/Chicago"), now: mid });
    expect(india.currentDayIndex).toBe(4);
    expect(india.currentDayLocalDate).toBe("2026-08-12");
    expect(chicago.currentDayIndex).toBe(4);
    expect(chicago.currentDayLocalDate).toBe("2026-08-12");
    // Same local date, different UTC windows — that is the whole point.
    expect(india.currentDayStartAt!.getTime()).not.toBe(chicago.currentDayStartAt!.getTime());
  });

  it("a new local midnight moves the viewer to the next day", () => {
    const beforeMidnight = new Date("2026-08-09T18:29:00.000Z"); // 23:59 Aug 9 IST
    const afterMidnight = new Date("2026-08-09T18:31:00.000Z"); // 00:01 Aug 10 IST
    expect(deriveViewerState({ challenge, ...participantFor("Asia/Kolkata"), now: beforeMidnight }).currentDayIndex).toBe(1);
    expect(deriveViewerState({ challenge, ...participantFor("Asia/Kolkata"), now: afterMidnight }).currentDayIndex).toBe(2);
  });

  it("terminal membership states override the clock", () => {
    const now2 = new Date("2026-08-12T06:00:00.000Z");
    expect(deriveViewerState({ challenge, ...participantFor("Asia/Kolkata", "left"), now: now2 }).viewerStatus).toBe("left");
    expect(deriveViewerState({ challenge, ...participantFor("Asia/Kolkata", "disqualified"), now: now2 }).viewerStatus).toBe("failed");
    expect(deriveViewerState({ challenge, participant: null, days: [], now: now2 }).viewerStatus).toBe("not_joined");
  });
});

describe("miss one required day and qualification is gone", () => {
  const afterRun = new Date("2026-08-20T00:00:00.000Z");

  it("a single finalized failed day is terminal even if every later day passes", () => {
    const { participant, days } = participantFor("Asia/Kolkata");
    const scored = days.map((d) => ({ ...d, status: d.dayNumber === 4 ? "failed" : "passed" }));
    const state = deriveViewerState({ challenge, participant, days: scored, now: afterRun });

    expect(state.failedDays).toBe(1);
    expect(state.completedDays).toBe(6);
    expect(state.viewerStatus).toBe("failed");
  });

  it("all seven days passed is completed", () => {
    const { participant, days } = participantFor("Asia/Kolkata");
    const scored = days.map((d) => ({ ...d, status: "passed" }));
    const state = deriveViewerState({ challenge, participant, days: scored, now: afterRun });
    expect(state.viewerStatus).toBe("completed");
    expect(state.completedDays).toBe(7);
  });

  it("run over but a day still unverified stays active with verificationPending", () => {
    const { participant, days } = participantFor("Asia/Kolkata");
    const scored = days.map((d) => ({ ...d, status: d.dayNumber === 7 ? "pending_verification" : "passed" }));
    const state = deriveViewerState({ challenge, participant, days: scored, now: afterRun });
    expect(state.viewerStatus).toBe("active");
    expect(state.verificationPending).toBe(true);
  });
});

describe("settlement envelope spans the latest participant, not the host", () => {
  it("a Chicago participant is still running after the India host has finished", () => {
    const host = computeParticipantSchedule({ startLocalDate: CHALLENGE_DATE, timezone: "Asia/Kolkata", durationDays: 7, goalSteps: 10000 });
    const chicago = computeParticipantSchedule({ startLocalDate: CHALLENGE_DATE, timezone: "America/Chicago", durationDays: 7, goalSteps: 10000 });

    expect(host.endAtUtc.toISOString()).toBe("2026-08-15T18:30:00.000Z");
    expect(chicago.endAtUtc.toISOString()).toBe("2026-08-16T05:00:00.000Z");
    expect(chicago.endAtUtc.getTime()).toBeGreaterThan(host.endAtUtc.getTime());

    // At the host's end instant the Chicago participant can still qualify — settling here would
    // pay out mid-run for them.
    const atHostEnd = deriveViewerState({ challenge, ...participantFor("America/Chicago"), now: host.endAtUtc });
    expect(atHostEnd.viewerStatus).toBe("active");
  });

  it("the +26h settlement timer covers the widest possible timezone spread", () => {
    // Earliest local midnight anywhere (UTC+14) to the latest (UTC-12) for one calendar date.
    const earliest = computeParticipantSchedule({ startLocalDate: CHALLENGE_DATE, timezone: "Pacific/Kiritimati", durationDays: 7, goalSteps: 0 });
    const latest = computeParticipantSchedule({ startLocalDate: CHALLENGE_DATE, timezone: "Etc/GMT+12", durationDays: 7, goalSteps: 0 });
    const spreadHours = (latest.endAtUtc.getTime() - earliest.endAtUtc.getTime()) / 3_600_000;
    expect(spreadHours).toBe(26);
  });
});
