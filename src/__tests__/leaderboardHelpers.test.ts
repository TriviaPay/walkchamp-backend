import { describe, expect, it } from "vitest";
import { canonicalCountryCode, countryCodeMatchSet, normalizeCountryCode } from "../lib/country.js";
import { getLeaderboardPeriodDates, isValidDateStr } from "../lib/leaderboardPeriods.js";
import { isCoinsWonRewardCode, isRewardedRaceWinResult } from "../lib/leaderboardPredicates.js";

describe("normalizeCountryCode", () => {
  it("trims and uppercases country codes", () => {
    expect(normalizeCountryCode(" us ")).toBe("US");
    expect(normalizeCountryCode("ind")).toBe("IND");
  });

  it("returns null for empty or non-string input", () => {
    expect(normalizeCountryCode("  ")).toBeNull();
    expect(normalizeCountryCode(null)).toBeNull();
  });
});

describe("country canonicalization", () => {
  it("resolves ISO-3 codes and full names to one canonical ISO-2 bucket", () => {
    for (const variant of ["US", "us", " usa ", "United States", "UNITED STATES OF AMERICA"]) {
      expect(canonicalCountryCode(variant)).toBe("US");
    }
    for (const variant of ["IN", "ind", "India"]) {
      expect(canonicalCountryCode(variant)).toBe("IN");
    }
    expect(canonicalCountryCode("gbr")).toBe("GB");
    expect(canonicalCountryCode("uk")).toBe("GB");
  });

  it("keeps an unknown code in its own bucket rather than merging or dropping it", () => {
    expect(canonicalCountryCode("zz")).toBe("ZZ");
    expect(countryCodeMatchSet("zz")).toEqual(["ZZ"]);
    expect(canonicalCountryCode("  ")).toBeNull();
    expect(countryCodeMatchSet(null)).toEqual([]);
  });

  it("expands a viewer's country to every stored spelling of the same country", () => {
    const us = countryCodeMatchSet("US");
    expect(us).toContain("US");
    expect(us).toContain("USA");
    expect(us).toContain("UNITED STATES");
    // A viewer whose own profile stores the ISO-3 form still gets the same bucket.
    expect(new Set(countryCodeMatchSet("USA"))).toEqual(new Set(us));
  });

  it("never merges two different countries into one bucket", () => {
    const us = new Set(countryCodeMatchSet("US"));
    for (const other of ["IN", "GB", "DE", "AE"]) {
      for (const alias of countryCodeMatchSet(other)) {
        expect(us.has(alias)).toBe(false);
      }
    }
  });
});

describe("leaderboard period dates", () => {
  const now = new Date("2026-08-14T12:00:00Z");

  it("rejects rollover dates", () => {
    expect(isValidDateStr("2026-02-31")).toBe(false);
    expect(isValidDateStr("2026-02-28")).toBe(true);
  });

  it("uses recent localDate for today and rejects far future dates", () => {
    expect(getLeaderboardPeriodDates("today", "2026-08-14", undefined, undefined, now)).toEqual({
      startDate: "2026-08-14",
      endDate: "2026-08-14",
    });
    expect(getLeaderboardPeriodDates("today", "2026-09-14", undefined, undefined, now)).toEqual({
      startDate: "2026-08-14",
      endDate: "2026-08-14",
    });
  });

  it("clamps weekStart and monthStart to bounded recent windows", () => {
    expect(getLeaderboardPeriodDates("week", "2026-08-14", "2026-08-10", undefined, now).startDate).toBe("2026-08-10");
    expect(getLeaderboardPeriodDates("week", "2026-08-14", "2026-07-01", undefined, now).startDate).toBe("2026-08-10");
    expect(getLeaderboardPeriodDates("month", "2026-08-14", undefined, "2026-08-01", now).startDate).toBe("2026-08-01");
    expect(getLeaderboardPeriodDates("month", "2026-08-14", undefined, "2026-01-01", now).startDate).toBe("2026-08-01");
  });
});

describe("leaderboard predicates", () => {
  it("counts only rewarded race results as wins", () => {
    expect(isRewardedRaceWinResult({ eligibleForPrize: true })).toBe(true);
    expect(isRewardedRaceWinResult({ eligibleForPrize: false })).toBe(false);
  });

  it("classifies coins-won reward codes", () => {
    expect(isCoinsWonRewardCode("COINS_BATTLE_WIN_1_race")).toBe(true);
    expect(isCoinsWonRewardCode("FREE_RACE_WIN_2")).toBe(true);
    expect(isCoinsWonRewardCode("PUBLIC_ROOM_WIN")).toBe(true);
    expect(isCoinsWonRewardCode("sponsored_consolation")).toBe(false);
    expect(isCoinsWonRewardCode("FRIEND_ACCEPT")).toBe(false);
    expect(isCoinsWonRewardCode(null)).toBe(false);
  });
});
