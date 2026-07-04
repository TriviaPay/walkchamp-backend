import { describe, expect, it } from "vitest";
import { readinessStatusCode, shouldExposeReadinessDetails } from "../lib/healthVisibility";

describe("health visibility", () => {
  it("shows readiness details outside production", () => {
    expect(shouldExposeReadinessDetails({
      nodeEnv: "test",
      configuredToken: null,
      requestToken: null,
    })).toBe(true);
  });

  it("hides production readiness details without a token", () => {
    expect(shouldExposeReadinessDetails({
      nodeEnv: "production",
      configuredToken: null,
      requestToken: null,
    })).toBe(false);
  });

  it("shows production readiness details when the token matches", () => {
    expect(shouldExposeReadinessDetails({
      nodeEnv: "production",
      configuredToken: "secret",
      requestToken: "secret",
    })).toBe(true);
  });

  it("keeps degraded readiness HTTP-200 for load balancer compatibility", () => {
    expect(readinessStatusCode("ready")).toBe(200);
    expect(readinessStatusCode("degraded")).toBe(200);
    expect(readinessStatusCode("not_ready")).toBe(503);
  });
});
