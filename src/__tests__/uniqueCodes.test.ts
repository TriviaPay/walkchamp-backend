import { afterEach, describe, expect, it, vi } from "vitest";

// Each entry answers one "is this code already taken?" probe, in order. Missing entries default
// to "free", so a test only has to describe the collisions it cares about.
const mocks = vi.hoisted(() => ({
  probeResults: [] as boolean[],
  alwaysTaken: false,
  probeCount: 0,
}));

vi.mock("../../db/src/index.js", () => {
  const takenRows = () => {
    mocks.probeCount += 1;
    const taken = mocks.alwaysTaken || (mocks.probeResults.shift() ?? false);
    return taken ? [{ id: "taken" }] : [];
  };
  return {
    db: {
      select: vi.fn(() => {
        const q: Record<string, unknown> = {
          from: vi.fn(() => q),
          where: vi.fn(() => q),
          limit: vi.fn(async () => takenRows()),
        };
        return q;
      }),
    },
  };
});

vi.mock("../lib/config.js", () => ({
  config: { logLevel: "silent" },
}));

vi.mock("../lib/logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  allocateReferralCode,
  allocateRoomCode,
  isUniqueViolation,
  withUniqueReferralCode,
} from "../lib/uniqueCodes.js";

const SHORT_CODE = /^[A-Z2-9]{6}$/;

describe("short code allocation", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.probeResults = [];
    mocks.alwaysTaken = false;
    mocks.probeCount = 0;
  });

  it("hands out a 6-character room code that is free in the database", async () => {
    const code = await allocateRoomCode();
    expect(code).toMatch(SHORT_CODE);
    expect(mocks.probeCount).toBe(1);
  });

  it("skips a code that is already taken and retries", async () => {
    mocks.probeResults = [true, true];
    const code = await allocateRoomCode();
    expect(code).toMatch(SHORT_CODE);
    expect(mocks.probeCount).toBe(3);
  });

  it("gives up rather than issuing a longer code when the space is saturated", async () => {
    mocks.alwaysTaken = true;
    await expect(allocateRoomCode()).rejects.toThrow(/Could not allocate a free room code/);
  });

  it("issues a 6-character invitation code for a new profile", async () => {
    const code = await allocateReferralCode();
    expect(code).toMatch(SHORT_CODE);
  });

  it("retries the insert when another signup claims the same invitation code", async () => {
    const attempted: string[] = [];
    const result = await withUniqueReferralCode(async (code) => {
      attempted.push(code);
      if (attempted.length === 1) {
        throw Object.assign(new Error("duplicate key"), {
          code: "23505",
          constraint: "profiles_referral_code_unique",
        });
      }
      return { referralCode: code };
    });

    expect(attempted).toHaveLength(2);
    expect(attempted[0]).not.toBe(attempted[1]);
    expect(result.referralCode).toBe(attempted[1]);
  });

  it("does not swallow unrelated unique violations (e.g. duplicate email)", async () => {
    const emailConflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "profiles_email_unique",
    });
    let calls = 0;
    await expect(withUniqueReferralCode(async () => { calls += 1; throw emailConflict; }))
      .rejects.toBe(emailConflict);
    expect(calls).toBe(1); // no retry on someone else's constraint
    expect(isUniqueViolation(emailConflict, "referral_code")).toBe(false);
    expect(isUniqueViolation(emailConflict, "email")).toBe(true);
  });
});
