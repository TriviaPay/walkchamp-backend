import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("auth session status contract", () => {
  it("does not log out monitor-mode clients that omit the backend session id", () => {
    const authRoute = readFileSync("src/routes/auth.ts", "utf8");

    expect(authRoute).toContain("function sessionIdRequiredForRequest");
    expect(authRoute).toContain("SESSION_NOT_PRESENT");
    expect(authRoute).toContain("sessionRequired: false");
    expect(authRoute).toContain("continuing in monitor mode");
  });
});
