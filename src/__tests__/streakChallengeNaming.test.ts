import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_STREAK_CHALLENGE_API_BASE,
  STREAK_CHALLENGE_API_BASE,
  rewriteLegacyStreakChallengeUrl,
} from "../lib/streakChallengeContract.js";

const read = (path: string) => readFileSync(path, "utf8");
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe("Streak Challenge public naming", () => {
  it("rewrites every former public route while preserving suffixes and queries", () => {
    expect(STREAK_CHALLENGE_API_BASE).toBe("/streak-challenges");
    expect(LEGACY_STREAK_CHALLENGE_API_BASE).toBe("/unlimited-challenges");
    expect(rewriteLegacyStreakChallengeUrl("/unlimited-challenges")).toBe("/streak-challenges");
    expect(rewriteLegacyStreakChallengeUrl("/unlimited-challenges/live?limit=20")).toBe(
      "/streak-challenges/live?limit=20",
    );
    expect(rewriteLegacyStreakChallengeUrl("/admin/unlimited-challenges/cancel-all")).toBe(
      "/admin/streak-challenges/cancel-all",
    );
    expect(rewriteLegacyStreakChallengeUrl("/unlimited-challenges-old")).toBe(
      "/unlimited-challenges-old",
    );
  });

  it("publishes canonical routes and marks legacy aliases deprecated", () => {
    const route = read("src/routes/unlimitedChallenge.ts");
    const admin = read("src/routes/admin.ts");
    expect(route).toContain('router.get("/streak-challenges/:id"');
    expect(route).toContain('router.post("/streak-challenges/host"');
    expect(route).toContain('res.setHeader("Deprecation", "true")');
    expect(admin).toContain('router.post("/admin/streak-challenges/cancel-all"');
    expect(admin).toContain('router.post("/admin/streak-challenges/:id/cancel"');
  });

  it("uses canonical environment variables with explicit legacy fallbacks", () => {
    const config = read("src/lib/config.ts");
    for (const canonical of [
      "FEATURE_STREAK_CHALLENGE",
      "STREAK_CHALLENGE_GRACE_HOURS",
      "STREAK_CHALLENGE_VERIFICATION_MODE",
      "STREAK_CHALLENGE_ZERO_WINNER_POLICY",
    ]) {
      expect(config).toContain(canonical);
    }
    expect(config).toContain("rawEnv.FEATURE_STREAK_CHALLENGE ?? rawEnv.FEATURE_UNLIMITED_GOAL");
    expect(config).toContain("rawEnv.STREAK_CHALLENGE_GRACE_HOURS ?? rawEnv.UNLIMITED_GOAL_GRACE_HOURS");
    expect(config).toContain("rawEnv.STREAK_CHALLENGE_VERIFICATION_MODE");
    expect(config).toContain("?? rawEnv.UNLIMITED_VERIFICATION_MODE");
  });

  it("prefers canonical runtime values over legacy aliases", async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      FEATURE_STREAK_CHALLENGE: "false",
      FEATURE_UNLIMITED_GOAL: "true",
      STREAK_CHALLENGE_GRACE_HOURS: "6",
      UNLIMITED_GOAL_GRACE_HOURS: "2",
      STREAK_CHALLENGE_VERIFICATION_MODE: "manual",
      UNLIMITED_VERIFICATION_MODE: "client_source",
      STREAK_CHALLENGE_ZERO_WINNER_POLICY: "refund_entry_contributions",
      UNLIMITED_GOAL_ZERO_WINNER_POLICY: "manual_review",
    };
    vi.resetModules();
    const { config } = await import("../lib/config.js");
    expect(config.features.streakChallengeEnabled).toBe(false);
    expect(config.streakChallenge.graceHours).toBe(6);
    expect(config.streakChallenge.verificationMode).toBe("manual");
    expect(config.streakChallenge.zeroWinnerPolicy).toBe("refund_entry_contributions");
  });

  it("still accepts the former environment names during migration", async () => {
    const cleanEnv = { ...originalEnv };
    delete cleanEnv.FEATURE_STREAK_CHALLENGE;
    delete cleanEnv.STREAK_CHALLENGE_GRACE_HOURS;
    delete cleanEnv.STREAK_CHALLENGE_VERIFICATION_MODE;
    delete cleanEnv.STREAK_CHALLENGE_ZERO_WINNER_POLICY;
    process.env = {
      ...cleanEnv,
      NODE_ENV: "test",
      FEATURE_UNLIMITED_GOAL: "false",
      UNLIMITED_GOAL_GRACE_HOURS: "3",
      UNLIMITED_VERIFICATION_MODE: "client_source",
      UNLIMITED_GOAL_ZERO_WINNER_POLICY: "rollover_prize_pool",
    };
    vi.resetModules();
    const { config } = await import("../lib/config.js");
    expect(config.features.streakChallengeEnabled).toBe(false);
    expect(config.streakChallenge.graceHours).toBe(3);
    expect(config.streakChallenge.verificationMode).toBe("client_source");
    expect(config.streakChallenge.zeroWinnerPolicy).toBe("rollover_prize_pool");
  });

  it("documents the endpoint and Coolify migration contract", () => {
    const docs = read("docs/streak-challenge-api.md");
    const compose = read("docker-compose.coolify.yml");
    const openapi = read("api-spec/openapi.yaml");
    expect(docs).toContain("/streak-challenges/:id/final-verification");
    expect(docs).toContain('`challengeKind: "streak_challenge"`');
    expect(compose).toContain("FEATURE_STREAK_CHALLENGE:");
    expect(compose).toContain("STREAK_CHALLENGE_VERIFICATION_MODE:");
    expect(openapi).toContain("/streak-challenges/{id}/daily-history:");
  });
});
