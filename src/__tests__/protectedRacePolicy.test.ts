import { describe, expect, it } from "vitest";
import {
  canonicalPayloadHash,
  classifyContinuity,
  classifyOffline,
  classifyReconciliation,
  closeResultGroups,
  closeResultThreshold,
  isProtectedPrizeCandidate,
  validateProtectedDuration,
  type ProtectedPolicySnapshot,
} from "../lib/protectedRacePolicy.js";
import { classifyIntegrityChallenge } from "../lib/protectedRaceIntegrity.js";

const policy: ProtectedPolicySnapshot = {
  policyVersion: "test-v1",
  minimumDurationMinutes: 60,
  closeResultAbsoluteSteps: 100,
  closeResultPercent: 0.01,
  reconciliationAbsoluteSteps: 100,
  reconciliationPercent: 0.02,
  verificationGraceMs: 4 * 60 * 60_000,
  reviewWindowMs: 48 * 60 * 60_000,
  maxContinuousOfflineMs: 10 * 60_000,
  maxOfflineRaceFraction: 0.2,
  finalEvidenceUploadGraceMs: 15 * 60_000,
  heartbeatIntervalMs: 60_000,
};

describe("protected prize eligibility", () => {
  it("protects cash, coin-entry, and sponsored prizes but not ordinary free races", () => {
    expect(isProtectedPrizeCandidate({ entryAmountCents: 100 })).toBe(true);
    expect(isProtectedPrizeCandidate({ entryType: "coins_battle" })).toBe(true);
    expect(isProtectedPrizeCandidate({ type: "sponsored" })).toBe(true);
    expect(isProtectedPrizeCandidate({ entryAmountCents: 0, entryType: "free", type: "quick" })).toBe(false);
  });

  it("rejects 59 minutes and accepts the 60-minute V1 boundary", () => {
    expect(validateProtectedDuration(59).ok).toBe(false);
    expect(validateProtectedDuration(60).ok).toBe(true);
  });
});

describe("protected reconciliation", () => {
  it("accepts a 50-step delta and reviews a 500-step delta", () => {
    expect(classifyReconciliation(10_000, 9_950, policy)).toBe("CLEAR");
    expect(classifyReconciliation(10_000, 9_500, policy)).toBe("RECONCILIATION_REVIEW");
  });
});

describe("protected offline policy", () => {
  const classify = (maxMinutes: number, cumulativeMinutes: number) => classifyOffline({
    maxContinuousOfflineMs: maxMinutes * 60_000,
    cumulativeOfflineMs: cumulativeMinutes * 60_000,
    raceDurationMs: 60 * 60_000,
    policy,
  });

  it("allows 5 minutes and the exact 10-minute boundary", () => {
    expect(classify(5, 5)).toBe("CLEAR");
    expect(classify(10, 10)).toBe("CLEAR");
  });

  it("reviews an 11-minute continuous gap or cumulative time above 20%", () => {
    expect(classify(11, 11)).toBe("OFFLINE_REVIEW");
    expect(classify(5, 13)).toBe("OFFLINE_REVIEW");
  });
});

describe("continuity classification", () => {
  it("does not turn a force kill or same-device reboot into a breach", () => {
    expect(classifyContinuity({ bindingChanged: false, sourceChanged: false, permissionStatus: "granted" }))
      .toEqual({ continuityStatus: "HEALTHY", reviewReasons: [] });
  });

  it("routes permission/device changes and source mutation to their review reasons", () => {
    expect(classifyContinuity({ bindingChanged: true, sourceChanged: false, permissionStatus: "granted" }))
      .toEqual({ continuityStatus: "USER_CONTINUITY_BREACH", reviewReasons: ["CONTINUITY_REVIEW"] });
    expect(classifyContinuity({ bindingChanged: false, sourceChanged: false, permissionStatus: "revoked" }).continuityStatus)
      .toBe("USER_CONTINUITY_BREACH");
    expect(classifyContinuity({ bindingChanged: false, sourceChanged: true, permissionStatus: "granted" }).reviewReasons)
      .toEqual(["SOURCE_REVIEW"]);
  });
});

describe("close-result prize boundaries", () => {
  it("treats 99 steps and exactly 100 steps as close, but 101 as clear", () => {
    const group = (margin: number) => closeResultGroups([
      { userId: "first", qualifyingSteps: 10_000 },
      { userId: "second", qualifyingSteps: 10_000 - margin },
    ], 1, policy);
    expect(group(99).get("first")).toBe(group(99).get("second"));
    expect(group(100).get("first")).toBe(group(100).get("second"));
    expect(group(101).get("first")).not.toBe(group(101).get("second"));
  });

  it("uses the percentage threshold when it is larger", () => {
    expect(closeResultThreshold(50_000, policy)).toBe(500);
  });

  it("checks every paid boundary, including last-paid versus first-unpaid", () => {
    const groups = closeResultGroups([
      { userId: "one", qualifyingSteps: 12_000 },
      { userId: "two", qualifyingSteps: 11_000 },
      { userId: "three", qualifyingSteps: 10_000 },
      { userId: "four", qualifyingSteps: 9_950 },
    ], 3, policy);
    expect(groups.get("three")).toBe(groups.get("four"));
  });
});

describe("canonical integrity binding", () => {
  const payload = {
    raceId: "race-a",
    participantId: "participant-a",
    verificationSessionId: "session-a",
    registeredDeviceId: "device-a",
    qualifyingSteps: 10_000,
  };

  it("is deterministic across object key order", () => {
    expect(canonicalPayloadHash(payload)).toBe(canonicalPayloadHash({
      qualifyingSteps: 10_000,
      registeredDeviceId: "device-a",
      verificationSessionId: "session-a",
      participantId: "participant-a",
      raceId: "race-a",
    }));
  });

  it.each([
    ["qualifying steps", { ...payload, qualifyingSteps: 9_999 }],
    ["race", { ...payload, raceId: "race-b" }],
    ["session", { ...payload, verificationSessionId: "session-b" }],
    ["device", { ...payload, registeredDeviceId: "device-b" }],
  ])("changes when bound %s changes", (_label, changed) => {
    expect(canonicalPayloadHash(changed)).not.toBe(canonicalPayloadHash(payload));
  });
});

describe("one-time integrity challenges", () => {
  const now = new Date("2026-08-24T12:00:00.000Z");

  it("accepts a live, bound, unused challenge", () => {
    expect(classifyIntegrityChallenge({
      existsAndBound: true, challengeHashMatches: true, consumedAt: null,
      expiresAt: new Date(now.getTime() + 60_000), now,
    })).toBeNull();
  });

  it("rejects wrong race/session/device binding, replay, and expiry", () => {
    expect(classifyIntegrityChallenge({
      existsAndBound: false, challengeHashMatches: true, consumedAt: null,
      expiresAt: new Date(now.getTime() + 60_000), now,
    })).toBe("INTEGRITY_CHALLENGE_INVALID");
    expect(classifyIntegrityChallenge({
      existsAndBound: true, challengeHashMatches: true, consumedAt: now,
      expiresAt: new Date(now.getTime() + 60_000), now,
    })).toBe("INTEGRITY_CHALLENGE_REPLAYED");
    expect(classifyIntegrityChallenge({
      existsAndBound: true, challengeHashMatches: true, consumedAt: null,
      expiresAt: now, now,
    })).toBe("INTEGRITY_CHALLENGE_EXPIRED");
  });
});
