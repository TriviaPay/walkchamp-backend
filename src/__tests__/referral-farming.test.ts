import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  REFERRAL_BONUS_VELOCITY_WINDOW_MS,
  referralBonusDailyCap,
} from "../lib/referralBonusService.js";

// Audit 2026-08-16 F-07: every award mints $6 of wallet value ($3 referrer + $3 referred), so a
// referrer must be capped per rolling window — otherwise N farmed accounts scale linearly into
// real money. These tests pin the cap knob and the gate's position in the service.

describe("referral bonus velocity cap", () => {
  afterEach(() => {
    delete process.env.REFERRAL_BONUS_MAX_PER_REFERRER_PER_DAY;
  });

  it("defaults to 5 awards per referrer per 24h", () => {
    expect(referralBonusDailyCap()).toBe(5);
    expect(REFERRAL_BONUS_VELOCITY_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("is tunable via REFERRAL_BONUS_MAX_PER_REFERRER_PER_DAY", () => {
    process.env.REFERRAL_BONUS_MAX_PER_REFERRER_PER_DAY = "2";
    expect(referralBonusDailyCap()).toBe(2);
    // 0 is a valid kill switch: no bonuses credit at all.
    process.env.REFERRAL_BONUS_MAX_PER_REFERRER_PER_DAY = "0";
    expect(referralBonusDailyCap()).toBe(0);
  });

  it("falls back to the default on garbage input", () => {
    process.env.REFERRAL_BONUS_MAX_PER_REFERRER_PER_DAY = "not-a-number";
    expect(referralBonusDailyCap()).toBe(5);
    process.env.REFERRAL_BONUS_MAX_PER_REFERRER_PER_DAY = "-3";
    expect(referralBonusDailyCap()).toBe(5);
  });

  it("gates the award insert on the referrer's recent award count", () => {
    const source = readFileSync("src/lib/referralBonusService.ts", "utf8");
    const capCheck = source.indexOf("recentAwardCount >= velocityCap");
    const capExit = source.indexOf('reason: "referrer_velocity_capped"');
    const awardInsert = source.indexOf(".insert(referralBonusAwardsTable)");

    expect(capCheck).toBeGreaterThan(-1);
    expect(capExit).toBeGreaterThan(capCheck);
    // The cap must be evaluated before the award row (and thus any wallet credit) is created.
    expect(awardInsert).toBeGreaterThan(capExit);
  });

  it("logs an abuse signal when the cap trips, for the post-launch watch list", () => {
    const source = readFileSync("src/lib/referralBonusService.ts", "utf8");
    expect(source).toContain('action: "referral_bonus_velocity_capped"');
  });

  it("reaches the deployed container via the compose env", () => {
    const compose = readFileSync("docker-compose.coolify.yml", "utf8");
    expect(compose).toContain("REFERRAL_BONUS_MAX_PER_REFERRER_PER_DAY:");
  });
});
