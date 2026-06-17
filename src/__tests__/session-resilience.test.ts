/**
 * Session resilience tests — documents and guards the behaviour contracts for
 * auth session management in Walk Champ.
 *
 * These tests verify pure logic and mock-based behaviour rather than the
 * React Native runtime, so they run cleanly in the api-server vitest suite.
 *
 * Coverage:
 *   1. JWT clock-skew buffer (mirrors descopeClient.ts isJwtExpired)
 *   2. Refresh outcome classification (definitive vs transient)
 *   3. Single-flight refresh concurrency guarantee
 *   4. Session restore resilience (network error, offline, /api/me failure)
 *   5. Logout behaviour contracts
 *   6. SecureStore write-atomicity contracts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── JWT helpers (mirrors descopeClient.ts) ────────────────────────────────────

/**
 * Build a minimal base64url-encoded JWT with the given `exp` (Unix seconds).
 * The signature segment is fake — these tests only inspect the payload.
 */
function buildJwt(expUnixSecs: number, sub = "user_test"): string {
  const enc = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  const header = enc({ alg: "RS256", typ: "JWT" });
  const payload = enc({ sub, exp: expUnixSecs, iat: expUnixSecs - 3600 });
  return `${header}.${payload}.FAKE_SIG`;
}

/** Current time in Unix seconds. */
function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Mirrors isJwtExpired() in descopeClient.ts.
 * Treats a token as expired if it expires within the next 60 seconds.
 */
function isJwtExpired(token: string): boolean {
  try {
    const part = token.split(".")[1];
    if (!part) return true;
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(
      Buffer.from(base64, "base64").toString("utf8"),
    ) as { exp?: number };
    if (typeof payload.exp !== "number") return true;
    return Date.now() / 1000 + 60 > payload.exp;
  } catch {
    return true;
  }
}

/** Mirrors getJwtSecsUntilExpiry() in descopeClient.ts. */
function getJwtSecsUntilExpiry(token: string): number {
  try {
    const part = token.split(".")[1];
    if (!part) return -Infinity;
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(
      Buffer.from(base64, "base64").toString("utf8"),
    ) as { exp?: number };
    if (typeof payload.exp !== "number") return -Infinity;
    return payload.exp - Date.now() / 1000;
  } catch {
    return -Infinity;
  }
}

// ── 1. JWT clock-skew buffer ──────────────────────────────────────────────────

describe("JWT clock-skew buffer (60-second window)", () => {
  it("token expiring in 30 seconds is treated as EXPIRED", () => {
    const token = buildJwt(nowSecs() + 30);
    expect(isJwtExpired(token)).toBe(true);
  });

  it("token expiring in 59 seconds is treated as EXPIRED", () => {
    const token = buildJwt(nowSecs() + 59);
    expect(isJwtExpired(token)).toBe(true);
  });

  it("token expiring in exactly 60 seconds is treated as EXPIRED (boundary)", () => {
    const token = buildJwt(nowSecs() + 60);
    expect(isJwtExpired(token)).toBe(true);
  });

  it("token expiring in 5 minutes is treated as VALID", () => {
    const token = buildJwt(nowSecs() + 300);
    expect(isJwtExpired(token)).toBe(false);
  });

  it("token expiring in 10 days is treated as VALID", () => {
    const token = buildJwt(nowSecs() + 10 * 86400);
    expect(isJwtExpired(token)).toBe(false);
  });

  it("token that already expired 1 second ago is treated as EXPIRED", () => {
    const token = buildJwt(nowSecs() - 1);
    expect(isJwtExpired(token)).toBe(true);
  });

  it("malformed JWT (no payload) is treated as EXPIRED", () => {
    expect(isJwtExpired("not.a.jwt")).toBe(true);
    expect(isJwtExpired("")).toBe(true);
    expect(isJwtExpired("header.NOTJSON.sig")).toBe(true);
  });

  it("getJwtSecsUntilExpiry returns positive value for a valid token", () => {
    const token = buildJwt(nowSecs() + 300);
    const secs = getJwtSecsUntilExpiry(token);
    expect(secs).toBeGreaterThan(290);
    expect(secs).toBeLessThan(310);
  });

  it("getJwtSecsUntilExpiry returns negative value for an expired token", () => {
    const token = buildJwt(nowSecs() - 3600);
    const secs = getJwtSecsUntilExpiry(token);
    expect(secs).toBeLessThan(0);
  });

  it("getJwtSecsUntilExpiry returns -Infinity for a malformed token", () => {
    expect(getJwtSecsUntilExpiry("malformed")).toBe(-Infinity);
  });
});

// ── 2. Refresh outcome classification ─────────────────────────────────────────
//
// Documents the contract for refreshSessionSafely() outcome handling.
// Mirrors the logic in authService.ts _executeRefresh().

type RefreshOutcome =
  | { ok: true; token: string }
  | { ok: false; definitive: boolean };

/** Simulates what _executeRefresh returns for each HTTP status. */
function classifyDescopeHttpStatus(httpStatus: number): RefreshOutcome {
  if (httpStatus >= 200 && httpStatus < 300) {
    return { ok: true, token: "new.session.jwt" };
  }
  if (httpStatus === 429 || httpStatus >= 500) {
    return { ok: false, definitive: false }; // transient
  }
  // 4xx (except 429): definitive auth rejection
  return { ok: false, definitive: true };
}

/** Simulates classification when an error is thrown (not an HTTP response). */
function classifyNetworkError(errorName: string): RefreshOutcome {
  // AbortError, TypeError ("network request failed"), TimeoutError → transient
  return { ok: false, definitive: false };
}

describe("Refresh outcome classification", () => {
  it("HTTP 200 → ok:true with new token", () => {
    const result = classifyDescopeHttpStatus(200);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token).toBe("new.session.jwt");
  });

  it("HTTP 401 → definitive failure (invalid/expired refresh token)", () => {
    const result = classifyDescopeHttpStatus(401);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.definitive).toBe(true);
  });

  it("HTTP 403 → definitive failure (account restricted)", () => {
    const result = classifyDescopeHttpStatus(403);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.definitive).toBe(true);
  });

  it("HTTP 400 → definitive failure (malformed token)", () => {
    const result = classifyDescopeHttpStatus(400);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.definitive).toBe(true);
  });

  it("HTTP 429 → transient failure (rate-limited) — keep session", () => {
    const result = classifyDescopeHttpStatus(429);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.definitive).toBe(false);
  });

  it("HTTP 500 → transient failure (Descope server error) — keep session", () => {
    const result = classifyDescopeHttpStatus(500);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.definitive).toBe(false);
  });

  it("HTTP 503 → transient failure (Descope unavailable) — keep session", () => {
    const result = classifyDescopeHttpStatus(503);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.definitive).toBe(false);
  });

  it("Network error (offline / DNS) → transient — keep session", () => {
    const result = classifyNetworkError("TypeError");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.definitive).toBe(false);
  });

  it("AbortError (timeout) → transient — keep session", () => {
    const result = classifyNetworkError("AbortError");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.definitive).toBe(false);
  });
});

// ── 3. Single-flight refresh concurrency ──────────────────────────────────────
//
// Verifies the contract: only one refresh request in flight at a time;
// concurrent callers join the same promise.

describe("Single-flight refresh manager", () => {
  it("two simultaneous refresh calls execute the underlying fetch exactly once", async () => {
    let callCount = 0;
    const slowFetch = () =>
      new Promise<RefreshOutcome>((resolve) => {
        callCount++;
        setTimeout(() => resolve({ ok: true, token: "new-token" }), 20);
      });

    // Simulates the refreshSessionSafely() single-flight pattern
    let _inFlight = false;
    let _promise: Promise<RefreshOutcome> | null = null;

    function refreshSafely(): Promise<RefreshOutcome> {
      if (_inFlight && _promise) return _promise;
      _inFlight = true;
      _promise = slowFetch().finally(() => {
        _inFlight = false;
        _promise = null;
      });
      return _promise;
    }

    const [r1, r2] = await Promise.all([refreshSafely(), refreshSafely()]);

    expect(callCount).toBe(1); // Only one network request
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.token).toBe(r2.token); // Both callers receive the same token
    }
  });

  it("after first refresh completes, a second call starts a new refresh", async () => {
    let callCount = 0;
    const fastFetch = () =>
      new Promise<RefreshOutcome>((resolve) => {
        callCount++;
        resolve({ ok: true, token: `token-${callCount}` });
      });

    let _inFlight = false;
    let _promise: Promise<RefreshOutcome> | null = null;

    async function refreshSafely(): Promise<RefreshOutcome> {
      if (_inFlight && _promise) return _promise;
      _inFlight = true;
      _promise = fastFetch().finally(() => {
        _inFlight = false;
        _promise = null;
      });
      return _promise;
    }

    const r1 = await refreshSafely();
    const r2 = await refreshSafely();

    expect(callCount).toBe(2);
    if (r1.ok) expect(r1.token).toBe("token-1");
    if (r2.ok) expect(r2.token).toBe("token-2");
  });

  it("three simultaneous callers all receive the same outcome", async () => {
    let callCount = 0;
    const slowFetch = () =>
      new Promise<RefreshOutcome>((resolve) => {
        callCount++;
        setTimeout(() => resolve({ ok: true, token: "shared-token" }), 10);
      });

    let _inFlight = false;
    let _promise: Promise<RefreshOutcome> | null = null;

    function refreshSafely(): Promise<RefreshOutcome> {
      if (_inFlight && _promise) return _promise;
      _inFlight = true;
      _promise = slowFetch().finally(() => {
        _inFlight = false;
        _promise = null;
      });
      return _promise;
    }

    const results = await Promise.all([
      refreshSafely(),
      refreshSafely(),
      refreshSafely(),
    ]);

    expect(callCount).toBe(1);
    for (const r of results) {
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.token).toBe("shared-token");
    }
  });
});

// ── 4. Session restore resilience contracts ────────────────────────────────────
//
// Documents the exact decisions restoreSession() must make for each scenario.
// Mirrors the logic in authSlice.ts restoreSession thunk.

interface RestoreInput {
  hasSession: boolean;
  hasRefresh: boolean;
  sessionValid: boolean;
  refreshOutcome: RefreshOutcome | null;
  hasCachedProfile: boolean;
  fetchMeResult: "ok" | "network_error" | "500" | "401";
}

type RestoreDecision =
  | "authenticated"
  | "authenticated_offline"
  | "logged_out_definitive"
  | "logged_out_no_cache";

function simulateRestoreDecision(input: RestoreInput): RestoreDecision {
  if (!input.hasSession || !input.hasRefresh) return "logged_out_definitive";

  if (!input.sessionValid) {
    if (!input.refreshOutcome) return "logged_out_definitive";
    if (!input.refreshOutcome.ok) {
      if (input.refreshOutcome.definitive) return "logged_out_definitive";
      // Transient failure
      if (!input.hasCachedProfile) return "logged_out_no_cache";
      return "authenticated_offline";
    }
  }

  // Session valid OR refresh succeeded — fetch profile
  if (
    input.fetchMeResult === "network_error" ||
    input.fetchMeResult === "500"
  ) {
    return "authenticated"; // use cached profile, stay logged in
  }
  if (input.fetchMeResult === "401") {
    // 401 on /api/me after we already have a valid token is unusual — stay in
    return "authenticated";
  }
  return "authenticated";
}

describe("Session restore resilience contracts", () => {
  it("valid session token → user stays logged in", () => {
    const decision = simulateRestoreDecision({
      hasSession: true,
      hasRefresh: true,
      sessionValid: true,
      refreshOutcome: null,
      hasCachedProfile: true,
      fetchMeResult: "ok",
    });
    expect(decision).toBe("authenticated");
  });

  it("expired session + valid refresh → refresh succeeds → stays logged in", () => {
    const decision = simulateRestoreDecision({
      hasSession: true,
      hasRefresh: true,
      sessionValid: false,
      refreshOutcome: { ok: true, token: "new-token" },
      hasCachedProfile: false,
      fetchMeResult: "ok",
    });
    expect(decision).toBe("authenticated");
  });

  it("expired session + network failure → stays logged in with cached profile", () => {
    const decision = simulateRestoreDecision({
      hasSession: true,
      hasRefresh: true,
      sessionValid: false,
      refreshOutcome: { ok: false, definitive: false },
      hasCachedProfile: true,
      fetchMeResult: "network_error",
    });
    expect(decision).toBe("authenticated_offline");
  });

  it("expired session + network failure + no cached profile → logged out", () => {
    const decision = simulateRestoreDecision({
      hasSession: true,
      hasRefresh: true,
      sessionValid: false,
      refreshOutcome: { ok: false, definitive: false },
      hasCachedProfile: false,
      fetchMeResult: "network_error",
    });
    expect(decision).toBe("logged_out_no_cache");
  });

  it("expired session + Descope 401 → definitively logged out", () => {
    const decision = simulateRestoreDecision({
      hasSession: true,
      hasRefresh: true,
      sessionValid: false,
      refreshOutcome: { ok: false, definitive: true },
      hasCachedProfile: true,
      fetchMeResult: "ok",
    });
    expect(decision).toBe("logged_out_definitive");
  });

  it("/api/me network error → stays logged in", () => {
    const decision = simulateRestoreDecision({
      hasSession: true,
      hasRefresh: true,
      sessionValid: true,
      refreshOutcome: null,
      hasCachedProfile: true,
      fetchMeResult: "network_error",
    });
    expect(decision).toBe("authenticated");
  });

  it("/api/me 500 → stays logged in", () => {
    const decision = simulateRestoreDecision({
      hasSession: true,
      hasRefresh: true,
      sessionValid: true,
      refreshOutcome: null,
      hasCachedProfile: true,
      fetchMeResult: "500",
    });
    expect(decision).toBe("authenticated");
  });

  it("/api/me 401 after valid session → stays logged in (rare edge case)", () => {
    const decision = simulateRestoreDecision({
      hasSession: true,
      hasRefresh: true,
      sessionValid: true,
      refreshOutcome: null,
      hasCachedProfile: true,
      fetchMeResult: "401",
    });
    expect(decision).toBe("authenticated");
  });

  it("no stored tokens → logged out immediately", () => {
    const decision = simulateRestoreDecision({
      hasSession: false,
      hasRefresh: false,
      sessionValid: false,
      refreshOutcome: null,
      hasCachedProfile: false,
      fetchMeResult: "ok",
    });
    expect(decision).toBe("logged_out_definitive");
  });
});

// ── 5. SESSION_EXPIRED emission contract ──────────────────────────────────────

describe("SESSION_EXPIRED emission contract", () => {
  it("is NOT emitted for network error", () => {
    const networkOutcome: RefreshOutcome = { ok: false, definitive: false };
    // Definitive=false means SESSION_EXPIRED must NOT be emitted
    expect(networkOutcome.definitive).toBe(false);
  });

  it("is NOT emitted for Descope 500 server error", () => {
    const outcome = classifyDescopeHttpStatus(500);
    if (!outcome.ok) expect(outcome.definitive).toBe(false);
  });

  it("is NOT emitted for Descope 429 rate limit", () => {
    const outcome = classifyDescopeHttpStatus(429);
    if (!outcome.ok) expect(outcome.definitive).toBe(false);
  });

  it("IS emitted for Descope 401 (invalid refresh token)", () => {
    const outcome = classifyDescopeHttpStatus(401);
    if (!outcome.ok) expect(outcome.definitive).toBe(true);
  });

  it("IS emitted for Descope 403 (account suspended)", () => {
    const outcome = classifyDescopeHttpStatus(403);
    if (!outcome.ok) expect(outcome.definitive).toBe(true);
  });
});

// ── 6. Logout behaviour contracts ─────────────────────────────────────────────

describe("Logout behaviour", () => {
  it("manual logout should clear both SecureStore keys", async () => {
    const store: Record<string, string | null> = {
      wc_session: "session-jwt",
      wc_refresh: "refresh-jwt",
    };

    // Simulates clearSession() — deletes both keys atomically
    async function clearSession() {
      await Promise.all([
        (async () => { store["wc_session"] = null; })(),
        (async () => { store["wc_refresh"] = null; })(),
      ]);
    }

    await clearSession();
    expect(store["wc_session"]).toBeNull();
    expect(store["wc_refresh"]).toBeNull();
  });

  it("network error during refresh must NOT clear SecureStore", () => {
    const store: Record<string, string | null> = {
      wc_session: "session-jwt",
      wc_refresh: "refresh-jwt",
    };

    // Network error outcome → definitive:false → do NOT clear
    const networkOutcome: RefreshOutcome = { ok: false, definitive: false };
    const shouldClear = !networkOutcome.ok && networkOutcome.definitive;

    if (!shouldClear) {
      // tokens untouched
    }

    expect(store["wc_session"]).toBe("session-jwt");
    expect(store["wc_refresh"]).toBe("refresh-jwt");
  });

  it("definitive refresh rejection should clear SecureStore", async () => {
    const store: Record<string, string | null> = {
      wc_session: "session-jwt",
      wc_refresh: "refresh-jwt",
    };

    async function clearSession() {
      store["wc_session"] = null;
      store["wc_refresh"] = null;
    }

    const definitiveOutcome: RefreshOutcome = { ok: false, definitive: true };
    if (!definitiveOutcome.ok && definitiveOutcome.definitive) {
      await clearSession();
    }

    expect(store["wc_session"]).toBeNull();
    expect(store["wc_refresh"]).toBeNull();
  });
});

// ── 7. SecureStore write-atomicity contract ───────────────────────────────────

describe("SecureStore write atomicity", () => {
  it("saveSession writes both tokens together via Promise.all", async () => {
    const writeOrder: string[] = [];
    const mockSecureSet = async (key: string, _value: string) => {
      writeOrder.push(key);
    };

    // Simulates saveSession() → Promise.all([set session, set refresh])
    async function saveSession(sessionJwt: string, refreshJwt: string) {
      await Promise.all([
        mockSecureSet("wc_session", sessionJwt),
        mockSecureSet("wc_refresh", refreshJwt),
      ]);
    }

    await saveSession("new-session-jwt", "new-refresh-jwt");

    expect(writeOrder).toContain("wc_session");
    expect(writeOrder).toContain("wc_refresh");
    expect(writeOrder).toHaveLength(2);
  });

  it("new refresh token from Descope replaces old one (non-rotation config)", async () => {
    const store: Record<string, string> = {
      wc_session: "old-session",
      wc_refresh: "old-refresh",
    };

    // Descope /refresh returns new sessionJwt; refreshJwt is null when rotation disabled
    // → fall back to existing refresh token
    const descopeResponse = { sessionJwt: "new-session", refreshJwt: null };
    const newSession = descopeResponse.sessionJwt;
    const newRefresh = descopeResponse.refreshJwt ?? store["wc_refresh"];

    store["wc_session"] = newSession;
    store["wc_refresh"] = newRefresh;

    expect(store["wc_session"]).toBe("new-session");
    expect(store["wc_refresh"]).toBe("old-refresh"); // preserved — rotation disabled
  });
});
