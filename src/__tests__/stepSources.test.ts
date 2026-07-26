import { describe, expect, it } from "vitest";
import {
  normalizeSource,
  isVerifiedDailySource,
  isProvisionalLiveSource,
  isRaceVerificationSource,
  isRejectedDailySource,
  classifyDailySource,
  rollUpDailySourceClass,
  toLiveStepSource,
} from "../lib/stepSources.js";

describe("normalizeSource", () => {
  it("maps legacy names to canonical", () => {
    expect(normalizeSource("ios_healthkit")).toBe("healthkit");
    expect(normalizeSource("android_health_connect")).toBe("health_connect");
    expect(normalizeSource("android_counter")).toBe("android_step_counter");
    expect(normalizeSource("phone_sensor")).toBe("android_step_counter");
    expect(normalizeSource("device_sensor")).toBe("android_step_counter");
    expect(normalizeSource("sensor_estimate")).toBe("android_step_counter");
  });
  it("passes canonical names through", () => {
    expect(normalizeSource("healthkit")).toBe("healthkit");
    expect(normalizeSource("health_connect")).toBe("health_connect");
    expect(normalizeSource("ios_pedometer")).toBe("ios_pedometer");
  });
  it("is case-insensitive and trims", () => {
    expect(normalizeSource("  HealthKit ")).toBe("healthkit");
  });
  it("returns null for empty/absent", () => {
    expect(normalizeSource(null)).toBeNull();
    expect(normalizeSource(undefined)).toBeNull();
    expect(normalizeSource("")).toBeNull();
  });
});

describe("verified daily separation (§5)", () => {
  it("accepts health_connect and healthkit as verified daily", () => {
    expect(isVerifiedDailySource("health_connect")).toBe(true);
    expect(isVerifiedDailySource("healthkit")).toBe(true);
    expect(isVerifiedDailySource("ios_healthkit")).toBe(true); // legacy alias
    expect(isVerifiedDailySource("android_health_connect")).toBe(true); // legacy alias
  });
  it("rejects provisional sensors as verified daily", () => {
    expect(isVerifiedDailySource("android_step_counter")).toBe(false);
    expect(isVerifiedDailySource("ios_pedometer")).toBe(false);
    expect(isVerifiedDailySource("phone_sensor")).toBe(false);
  });
  it("classifies daily source for the source_class flag", () => {
    expect(classifyDailySource("healthkit")).toBe("verified");
    expect(classifyDailySource("android_step_counter")).toBe("unverified");
    expect(classifyDailySource(null)).toBe("unverified");
  });
});

describe("provisional live sources (§3/§6)", () => {
  it("accepts step counter / pedometer for live race", () => {
    expect(isProvisionalLiveSource("android_step_counter")).toBe(true);
    expect(isProvisionalLiveSource("ios_pedometer")).toBe(true);
  });
  it("does not treat verified health sources as provisional", () => {
    expect(isProvisionalLiveSource("healthkit")).toBe(false);
    expect(isProvisionalLiveSource("health_connect")).toBe(false);
  });
});

describe("race verification sources (§12)", () => {
  it("permits only health sources for verification", () => {
    expect(isRaceVerificationSource("healthkit")).toBe(true);
    expect(isRaceVerificationSource("health_connect")).toBe(true);
    expect(isRaceVerificationSource("android_step_counter")).toBe(false);
    expect(isRaceVerificationSource("pedometer")).toBe(false);
  });
});

describe("rejected daily sources (safe ignore)", () => {
  it("flags clearly-fake/unknown sources for safe ignore", () => {
    expect(isRejectedDailySource("totally_made_up")).toBe(true);
    expect(isRejectedDailySource("random")).toBe(true);
  });
  it("does not reject known or absent sources", () => {
    expect(isRejectedDailySource(null)).toBe(false);
    expect(isRejectedDailySource("healthkit")).toBe(false);
    expect(isRejectedDailySource("android_step_counter")).toBe(false);
    expect(isRejectedDailySource("simulation")).toBe(false); // handled by race anti-cheat, not rejected here
  });
});

describe("rollUpDailySourceClass", () => {
  it("all verified → verified", () => {
    expect(rollUpDailySourceClass(["verified", "verified"])).toBe("verified");
  });
  it("all unverified → unverified", () => {
    expect(rollUpDailySourceClass(["unverified"])).toBe("unverified");
  });
  it("blend → mixed", () => {
    expect(rollUpDailySourceClass(["verified", "unverified"])).toBe("mixed");
  });
  it("empty → unverified", () => {
    expect(rollUpDailySourceClass([])).toBe("unverified");
  });
});

describe("toLiveStepSource (enum mapping)", () => {
  it("maps to enum values", () => {
    expect(toLiveStepSource("ios_healthkit")).toBe("healthkit");
    expect(toLiveStepSource("android_step_counter")).toBe("android_step_counter");
    expect(toLiveStepSource("simulation")).toBe("simulation");
  });
  it("unknown present value → 'unknown', absent → null", () => {
    expect(toLiveStepSource("weird")).toBe("unknown");
    expect(toLiveStepSource(null)).toBeNull();
  });
});
