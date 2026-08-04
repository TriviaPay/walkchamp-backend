/**
 * Run: npx tsx Backend/src/__tests__/unlimitedProvisionalLive.unit.test.ts
 * (or from Backend: npx vitest run src/__tests__/unlimitedProvisionalLive.unit.test.ts)
 */
import { describe, expect, it } from "vitest";
import {
  displayedFromLanes,
  progressSourceFromLanes,
} from "../lib/unlimitedProvisionalLive.js";
import {
  isProvisionalLiveSource,
  isVerifiedDailySource,
  normalizeSource,
} from "../lib/stepSources.js";
import { readFileSync } from "node:fs";

describe("Unlimited dual-lane display helpers", () => {
  it("displayed = max(verified, provisional)", () => {
    expect(displayedFromLanes(28, 40)).toBe(40);
    expect(displayedFromLanes(40, 28)).toBe(40);
    expect(displayedFromLanes(0, 125)).toBe(125);
  });

  it("progressSource separates lanes", () => {
    expect(progressSourceFromLanes(28, 40)).toBe("mixed");
    expect(progressSourceFromLanes(0, 40)).toBe("provisional");
    expect(progressSourceFromLanes(40, 0)).toBe("verified");
  });
});

describe("Verified daily source contract", () => {
  it("accepts only HC/HK as verified", () => {
    expect(isVerifiedDailySource("health_connect")).toBe(true);
    expect(isVerifiedDailySource("healthkit")).toBe(true);
    expect(isVerifiedDailySource("android_step_counter")).toBe(false);
    expect(isVerifiedDailySource("ios_pedometer")).toBe(false);
  });

  it("classifies sensor sources as provisional", () => {
    expect(isProvisionalLiveSource("android_step_counter")).toBe(true);
    expect(isProvisionalLiveSource("ios_pedometer")).toBe(true);
    expect(isProvisionalLiveSource(normalizeSource("phone_sensor"))).toBe(true);
  });
});

describe("Unlimited provisional route is additive and separated", () => {
  const route = readFileSync("src/routes/unlimitedChallenge.ts", "utf8");
  const walk = readFileSync("src/routes/walk.ts", "utf8");

  it("exposes POST live-progress", () => {
    expect(route).toContain('"/unlimited-challenges/:id/live-progress"');
    expect(route).toContain("applyUnlimitedProvisionalLive");
    expect(route).toContain("Never writes step_daily_totals");
  });

  it("provisional route never marks goalReached from provisional alone", () => {
    expect(route).toContain("goalReached: verifiedTodaySteps >= dayRow.goalSteps");
  });

  it("walk/steps ignores provisional sensor sources", () => {
    expect(walk).toContain("isProvisionalLiveSource(source)");
    expect(walk).toContain("provisional_not_verified");
  });
});
