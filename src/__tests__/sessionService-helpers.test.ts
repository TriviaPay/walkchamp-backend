/**
 * sessionService — pure security helpers (no DB): session id entropy and provider-claim
 * extraction. The transactional register/replace path is exercised against a live DB via the
 * integration verification steps (it requires the auth_sessions table).
 */
import { describe, it, expect } from "vitest";
import { generateSessionId, extractDescopeSessionId } from "../lib/sessionService";

describe("generateSessionId", () => {
  it("produces high-entropy, url-safe, non-sequential ids", () => {
    const ids = new Set<string>();
    let prev = "";
    for (let i = 0; i < 1000; i++) {
      const id = generateSessionId();
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
      expect(id.length).toBeGreaterThanOrEqual(42); // 32 bytes -> 43 chars
      expect(id).not.toBe(prev); // not obviously sequential
      ids.add(id);
      prev = id;
    }
    expect(ids.size).toBe(1000); // no collisions
  });
});

describe("extractDescopeSessionId", () => {
  it("returns the first present candidate claim", () => {
    expect(extractDescopeSessionId({ sid: "abc" })).toBe("abc");
    expect(extractDescopeSessionId({ sessionId: "def" })).toBe("def");
    expect(extractDescopeSessionId({ session_id: "ghi" })).toBe("ghi");
    expect(extractDescopeSessionId({ dsr: "jkl" })).toBe("jkl");
  });
  it("returns null when no candidate claim is present or usable", () => {
    expect(extractDescopeSessionId(null)).toBeNull();
    expect(extractDescopeSessionId(undefined)).toBeNull();
    expect(extractDescopeSessionId({})).toBeNull();
    expect(extractDescopeSessionId({ sid: "" })).toBeNull();
    expect(extractDescopeSessionId({ sid: 123 as unknown as string })).toBeNull();
  });
});
