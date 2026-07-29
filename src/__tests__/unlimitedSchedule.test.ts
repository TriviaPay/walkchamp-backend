import { describe, expect, it } from "vitest";
import { validateUnlimitedSchedule } from "../lib/challengeDayWindow.js";

// USD Unlimited scheduling rules: start at exactly local midnight in the challenge timezone,
// tomorrow-or-later, supported duration; end is backend-computed as start-local-date + duration at
// local midnight (DST-correct). The validator is visibility-agnostic, so public/private parity is
// inherent (same function drives both create paths).

const NOW_UTC = Date.UTC(2026, 6, 29, 12, 0, 0); // 2026-07-29 12:00 UTC
const ok = (r: ReturnType<typeof validateUnlimitedSchedule>) => {
  expect(r.ok).toBe(true);
  return r as Extract<typeof r, { ok: true }>;
};
const run = (over: Partial<Parameters<typeof validateUnlimitedSchedule>[0]>) =>
  validateUnlimitedSchedule({ startAtIso: "2026-07-30T00:00:00.000Z", durationDays: 7, timezone: "UTC", nowMs: NOW_UTC, ...over });

describe("start date (tomorrow or later, in the challenge tz)", () => {
  it("accepts tomorrow at local 00:00", () => expect(run({}).ok).toBe(true));
  it("accepts a later future date at local 00:00", () => expect(run({ startAtIso: "2026-08-15T00:00:00.000Z" }).ok).toBe(true));
  it("rejects today at local 00:00", () => {
    const r = run({ startAtIso: "2026-07-29T00:00:00.000Z" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("start_not_future");
  });
  it("rejects a past date", () => expect(run({ startAtIso: "2026-07-01T00:00:00.000Z" }).ok).toBe(false));
  it("rejects a missing/unparseable start", () => {
    const r = run({ startAtIso: "not-a-date" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_start");
  });
});

describe("start time (must be exactly local midnight)", () => {
  const reject = (iso: string) => {
    const r = run({ startAtIso: iso });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("start_not_midnight");
  };
  it("rejects 12:01 AM", () => reject("2026-07-30T00:01:00.000Z"));
  it("rejects 1:00 AM", () => reject("2026-07-30T01:00:00.000Z"));
  it("rejects 3:28 PM", () => reject("2026-07-30T15:28:00.000Z"));
  it("rejects 11:59 PM", () => reject("2026-07-30T23:59:00.000Z"));
  it("rejects non-zero seconds", () => reject("2026-07-30T00:00:30.000Z"));
  it("rejects non-zero milliseconds", () => reject("2026-07-30T00:00:00.500Z"));
});

describe("duration", () => {
  for (const d of [7, 10, 30, 60, 90]) {
    it(`accepts ${d} days`, () => expect(run({ durationDays: d }).ok).toBe(true));
  }
  for (const d of [1, 5, 14, 45, 100]) {
    it(`rejects ${d} days`, () => {
      const r = run({ durationDays: d });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_duration");
    });
  }
});

describe("authoritative end date (UTC tz — no DST, end = start + duration days at 00:00)", () => {
  for (const [d, endIso] of [
    [7, "2026-08-06T00:00:00.000Z"],
    [10, "2026-08-09T00:00:00.000Z"],
    [30, "2026-08-29T00:00:00.000Z"],
    [60, "2026-09-28T00:00:00.000Z"],
    [90, "2026-10-28T00:00:00.000Z"],
  ] as const) {
    it(`duration ${d} → end ${endIso}`, () => {
      const r = ok(run({ durationDays: d }));
      expect(r.challengeEndAtUtc.toISOString()).toBe(endIso);
    });
  }
});

describe("DST correctness (America/Chicago)", () => {
  it("spring-forward: end stays local midnight (start Mar 7 → end Mar 14 00:00 CDT = 05:00Z)", () => {
    // 2026-03-07 00:00 CST (UTC-6) = 2026-03-07T06:00:00Z; DST begins 2026-03-08.
    const r = ok(validateUnlimitedSchedule({
      startAtIso: "2026-03-07T06:00:00.000Z", durationDays: 7, timezone: "America/Chicago",
      nowMs: Date.UTC(2026, 0, 1),
    }));
    // NOT 06:00Z (that would be +7×24h ignoring DST) — DST-correct local midnight is 05:00Z (CDT).
    expect(r.challengeEndAtUtc.toISOString()).toBe("2026-03-14T05:00:00.000Z");
  });
  it("fall-back: end stays local midnight (start Oct 28 → end Nov 4 00:00 CST = 06:00Z)", () => {
    // 2026-10-28 00:00 CDT (UTC-5) = 2026-10-28T05:00:00Z; DST ends 2026-11-01.
    const r = ok(validateUnlimitedSchedule({
      startAtIso: "2026-10-28T05:00:00.000Z", durationDays: 7, timezone: "America/Chicago",
      nowMs: Date.UTC(2026, 0, 1),
    }));
    expect(r.challengeEndAtUtc.toISOString()).toBe("2026-11-04T06:00:00.000Z");
  });
});

describe("timezone handling", () => {
  it("rejects an invalid IANA timezone", () => {
    const r = validateUnlimitedSchedule({ startAtIso: "2026-07-30T00:00:00.000Z", durationDays: 7, timezone: "Not/AZone", nowMs: NOW_UTC });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_timezone");
  });
  it("preserves local midnight across UTC conversion (Asia/Kolkata, UTC+5:30)", () => {
    // 2026-07-30 00:00 IST = 2026-07-29T18:30:00Z. now = before that.
    const r = ok(validateUnlimitedSchedule({
      startAtIso: "2026-07-29T18:30:00.000Z", durationDays: 7, timezone: "Asia/Kolkata",
      nowMs: Date.UTC(2026, 6, 28, 0, 0, 0),
    }));
    // End = 2026-08-06 00:00 IST = 2026-08-05T18:30:00Z.
    expect(r.challengeEndAtUtc.toISOString()).toBe("2026-08-05T18:30:00.000Z");
  });
  it("a non-midnight local time in a +5:30 zone is rejected", () => {
    // 2026-07-29T19:00:00Z = 2026-07-30 00:30 IST → not midnight.
    const r = validateUnlimitedSchedule({ startAtIso: "2026-07-29T19:00:00.000Z", durationDays: 7, timezone: "Asia/Kolkata", nowMs: Date.UTC(2026, 6, 28) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("start_not_midnight");
  });
});
