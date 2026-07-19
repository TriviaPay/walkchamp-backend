import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("profile username update", () => {
  it("allows saving an unchanged self-owned reserved username", () => {
    const profileRoute = readFileSync("src/routes/profile.ts", "utf8");

    const existingLookup = profileRoute.indexOf("const existing = await db");
    const takenCheck = profileRoute.indexOf("existing.length > 0 && existing[0].id !== userId");
    const blockedCheck = profileRoute.indexOf("isBlocked(lower) && existing[0]?.id !== userId");

    expect(existingLookup).toBeGreaterThan(-1);
    expect(takenCheck).toBeGreaterThan(existingLookup);
    expect(blockedCheck).toBeGreaterThan(takenCheck);
  });
});
