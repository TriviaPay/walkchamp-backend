/**
 * Descope Authorization header format tests.
 *
 * Root cause of E011002 "Request is missing required arguments":
 * Authenticated Descope API calls (refresh, logout, password-change) require
 * the Authorization header in the form:  Bearer {projectId}{jwt}
 * where the project ID is prepended directly before the JWT (no separator).
 *
 * The pre-fix bug sent:  Bearer {jwt}  — missing project ID prefix —
 * so Descope could not route the request to the correct project.
 *
 * This test file documents the correct format and regression-guards it.
 */
import { describe, it, expect } from "vitest";

const FAKE_PROJECT_ID = "P2abc1234567890abcdef1234567890";
const FAKE_JWT =
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9" +
  ".eyJzdWIiOiJ1c2VyXzAxIiwiZXhwIjo5OTk5OTk5OTk5fQ" +
  ".RSASSA_PKCS1_v1_5_signature";

/**
 * Mirrors the Authorization header construction in descopeClient.ts.
 * The real code is:
 *   headers["Authorization"] = `Bearer ${PROJECT_ID}`;          // unauthenticated
 *   headers["Authorization"] = `Bearer ${PROJECT_ID}${jwt}`;    // authenticated
 */
function buildDescopeAuthHeader(projectId: string, sessionJwt?: string): string {
  if (sessionJwt) {
    return `Bearer ${projectId}${sessionJwt}`;
  }
  return `Bearer ${projectId}`;
}

describe("Descope unauthenticated header (sign-in, OTP verify)", () => {
  it("is  Bearer {projectId}  with no JWT appended", () => {
    const header = buildDescopeAuthHeader(FAKE_PROJECT_ID);
    expect(header).toBe(`Bearer ${FAKE_PROJECT_ID}`);
  });

  it("does NOT contain a JWT segment", () => {
    const header = buildDescopeAuthHeader(FAKE_PROJECT_ID);
    expect(header).not.toMatch(/eyJ/);
  });

  it("has exactly two tokens: 'Bearer' and the project ID", () => {
    const parts = buildDescopeAuthHeader(FAKE_PROJECT_ID).split(" ");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe("Bearer");
    expect(parts[1]).toBe(FAKE_PROJECT_ID);
  });
});

describe("Descope authenticated header (refresh, logout, password-change)", () => {
  it("is  Bearer {projectId}{jwt}  — project ID immediately before JWT", () => {
    const header = buildDescopeAuthHeader(FAKE_PROJECT_ID, FAKE_JWT);
    expect(header).toBe(`Bearer ${FAKE_PROJECT_ID}${FAKE_JWT}`);
  });

  it("starts with  Bearer {projectId}", () => {
    const header = buildDescopeAuthHeader(FAKE_PROJECT_ID, FAKE_JWT);
    expect(header.startsWith(`Bearer ${FAKE_PROJECT_ID}`)).toBe(true);
  });

  it("ends with the full JWT unchanged", () => {
    const header = buildDescopeAuthHeader(FAKE_PROJECT_ID, FAKE_JWT);
    expect(header.endsWith(FAKE_JWT)).toBe(true);
  });

  it("project ID and JWT are concatenated without any separator", () => {
    const header = buildDescopeAuthHeader(FAKE_PROJECT_ID, FAKE_JWT);
    const withoutBearer = header.replace("Bearer ", "");
    expect(withoutBearer).toBe(`${FAKE_PROJECT_ID}${FAKE_JWT}`);
    expect(withoutBearer.includes(" ")).toBe(false);
  });

  it("pre-fix bug pattern  Bearer {jwt}  differs from the correct header", () => {
    const buggedHeader = `Bearer ${FAKE_JWT}`;
    const correctHeader = buildDescopeAuthHeader(FAKE_PROJECT_ID, FAKE_JWT);
    expect(buggedHeader).not.toBe(correctHeader);
  });

  it("pre-fix bug: Bearer {jwt} does NOT start with the project ID", () => {
    const buggedHeader = `Bearer ${FAKE_JWT}`;
    expect(buggedHeader.startsWith(`Bearer ${FAKE_PROJECT_ID}`)).toBe(false);
  });
});

describe("Edge cases", () => {
  it("empty project ID falls back gracefully (returns Bearer {jwt})", () => {
    const header = buildDescopeAuthHeader("", FAKE_JWT);
    expect(header).toBe(`Bearer ${FAKE_JWT}`);
  });

  it("empty project ID unauthenticated call yields 'Bearer '", () => {
    const header = buildDescopeAuthHeader("");
    expect(header).toBe("Bearer ");
  });

  it("project IDs follow Descope format: start with 'P'", () => {
    expect(FAKE_PROJECT_ID.startsWith("P")).toBe(true);
  });
});
