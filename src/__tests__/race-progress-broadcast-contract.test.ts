/**
 * Source-contract tests for Classic progress broadcast behavior.
 * Run: npx vitest run src/__tests__/race-progress-broadcast-contract.test.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const racesSrc = readFileSync(
  resolve(__dirname, "../routes/races.ts"),
  "utf8",
);

describe("classic race progress broadcast contract", () => {
  it("uses leftJoin for live participant profile enrichment", () => {
    expect(racesSrc).toContain(
      ".leftJoin(profilesTable, eq(raceParticipantsTable.userId, profilesTable.id))",
    );
    expect(racesSrc).toContain('username: p.username?.trim() || "Walker"');
  });

  it("always emits compact race:progress_updated and coalesces leaderboard separately", () => {
    expect(racesSrc).toContain("includeLeaderboard");
    expect(racesSrc).toContain("tryAcquireBroadcastLease");
    // Compact delta fields
    expect(racesSrc).toContain("updatedAt");
    expect(racesSrc).toMatch(
      /void triggerEvent\(`public-live-race-\$\{raceId\}`, "race:progress_updated"/,
    );
    // Must not gate the entire emit behind shouldBroadcast alone
    expect(racesSrc).not.toMatch(
      /if \(shouldBroadcast\) \{\s*void triggerEvent\(`public-live-race-\$\{raceId\}`, "race:progress_updated"/,
    );
  });
});
