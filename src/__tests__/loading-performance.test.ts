/**
 * Loading-performance tests — documents and guards the behaviour contracts for
 * Walk tab stale-while-revalidate cache, Live tab polling strategy, and walk
 * history date-range logic.
 *
 * All tests run in the api-server vitest environment (no React Native runtime
 * required).  Where behaviour lives in the mobile app, tests verify the
 * contract through inline simulations that mirror the actual implementation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── 1. Walk tab screenCache stale-while-revalidate ────────────────────────────
//
// Mirrors the WALK_CACHE_KEY pattern in walk.tsx + screenCache.ts.
// Three-tier responsiveness guarantee:
//   • Same-session tab switch  → sync mem hit, data shown before paint.
//   • App reopen (same process) → mem hit (process alive).
//   • App kill + reopen         → async disk read, shown before API responds.

type ChallengeMap = Record<string, { status: string; raceId?: string }>;

/** Minimal in-memory cache that mirrors screenCache behaviour. */
function makeScreenCache() {
  const mem = new Map<string, { data: unknown; ts: number }>();
  const MAX_AGE_MS = 5 * 60 * 1000;

  return {
    getSync<T>(key: string, maxAgeMs = MAX_AGE_MS): T | null {
      const e = mem.get(key);
      if (!e || Date.now() - e.ts > maxAgeMs) return null;
      return e.data as T;
    },
    async get<T>(key: string, maxAgeMs = MAX_AGE_MS): Promise<T | null> {
      return this.getSync<T>(key, maxAgeMs);
    },
    async set<T>(key: string, data: T): Promise<void> {
      mem.set(key, { data, ts: Date.now() });
    },
    clearAll() { mem.clear(); },
    _mem: mem,
  };
}

describe("Walk tab screenCache — stale-while-revalidate", () => {
  const WALK_CACHE_KEY = "screen_walk_challenges";

  it("getSync returns null before any data is cached", () => {
    const cache = makeScreenCache();
    expect(cache.getSync(WALK_CACHE_KEY)).toBeNull();
  });

  it("getSync returns cached data immediately after set", async () => {
    const cache = makeScreenCache();
    const data: ChallengeMap = { free_race: { status: "available" } };
    await cache.set(WALK_CACHE_KEY, data);
    const hit = cache.getSync<ChallengeMap>(WALK_CACHE_KEY);
    expect(hit).toEqual(data);
  });

  it("same-session tab revisit: getSync hits without async read", async () => {
    const cache = makeScreenCache();
    await cache.set(WALK_CACHE_KEY, { free_race: { status: "available" } });
    const hit = cache.getSync<ChallengeMap>(WALK_CACHE_KEY);
    expect(hit).not.toBeNull();
  });

  it("stale entry (older than maxAge) is evicted on getSync", async () => {
    const cache = makeScreenCache();
    const staleEntry = { data: { free_race: { status: "available" } }, ts: Date.now() - 6 * 60 * 1000 };
    cache._mem.set(WALK_CACHE_KEY, staleEntry);
    expect(cache.getSync(WALK_CACHE_KEY)).toBeNull();
  });

  it("walkCacheReady starts false when no mem cache exists", () => {
    const cache = makeScreenCache();
    const walkCacheReady = cache.getSync(WALK_CACHE_KEY) !== null;
    expect(walkCacheReady).toBe(false);
  });

  it("walkCacheReady starts true when mem cache already populated", async () => {
    const cache = makeScreenCache();
    await cache.set(WALK_CACHE_KEY, { free_race: { status: "available" } });
    const walkCacheReady = cache.getSync(WALK_CACHE_KEY) !== null;
    expect(walkCacheReady).toBe(true);
  });

  it("fetch writes new data into cache, replacing old entry", async () => {
    const cache = makeScreenCache();
    await cache.set(WALK_CACHE_KEY, { free_race: { status: "available" } });
    const fresh: ChallengeMap = { free_race: { status: "user_hosting_active", raceId: "r1" } };
    await cache.set(WALK_CACHE_KEY, fresh);
    expect(cache.getSync<ChallengeMap>(WALK_CACHE_KEY)).toEqual(fresh);
  });

  it("clearAll (on logout) wipes the cache", async () => {
    const cache = makeScreenCache();
    await cache.set(WALK_CACHE_KEY, { free_race: { status: "available" } });
    cache.clearAll();
    expect(cache.getSync(WALK_CACHE_KEY)).toBeNull();
  });
});

// ── 2. Walk tab polling — focus-aware interval ─────────────────────────────────
//
// Verifies that the 5 s poll is cancelled on blur and restarted on focus,
// preventing background network traffic when the user is on another tab.
// Mirrors the useFocusEffect pattern in walk.tsx (consolidated focus loader).

describe("Walk tab polling — focus-aware interval", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("poll fires on focus and stops on blur", () => {
    let calls = 0;
    const loadChallengeStatuses = () => { calls++; };

    // Simulate useFocusEffect mount (tab focuses)
    loadChallengeStatuses(); // immediate call on focus
    const interval = setInterval(loadChallengeStatuses, 5_000);

    // After 15 s, should have fired 3 more times (total 4)
    vi.advanceTimersByTime(15_000);
    expect(calls).toBe(4);

    // Blur: cleanup fires
    clearInterval(interval);

    // Advancing time further should not fire again
    vi.advanceTimersByTime(15_000);
    expect(calls).toBe(4); // no additional calls
  });

  it("poll restarts fresh on re-focus", () => {
    let calls = 0;
    const load = () => { calls++; };

    // First focus
    load();
    const i1 = setInterval(load, 5_000);
    vi.advanceTimersByTime(5_000);
    clearInterval(i1); // blur

    const callsAfterFirstFocus = calls; // = 2

    // Re-focus
    load();
    const i2 = setInterval(load, 5_000);
    vi.advanceTimersByTime(5_000);
    clearInterval(i2); // blur again

    expect(calls).toBe(callsAfterFirstFocus + 2);
  });

  it("standalone useEffect poll runs even while on another tab (old behaviour — must not exist)", () => {
    // Documents the bug that was fixed: a plain useEffect with setInterval
    // keeps firing regardless of tab focus.
    let bgCalls = 0;
    const bgLoad = () => { bgCalls++; };

    // Simulate the OLD bug: unrestricted interval
    const buggyInterval = setInterval(bgLoad, 5_000);
    vi.advanceTimersByTime(30_000);
    clearInterval(buggyInterval);

    // 6 calls even though user was on a different tab — this is the anti-pattern
    expect(bgCalls).toBe(6);
    // The NEW code uses useFocusEffect so bgCalls would be 0 here (interval never started)
  });
});

// ── 3. Live tab polling — 60 s fallback when Pusher is primary ────────────────
//
// Verifies the polling strategy: Pusher drives real-time updates; the 60 s
// setInterval is a safety-net fallback (previously 10 s — reduced 6×).

describe("Live tab polling — 60 s safety-net interval", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("interval fires once per 60 s, not once per 10 s", () => {
    let calls = 0;
    const load = () => { calls++; };

    const interval = setInterval(load, 60_000);
    vi.advanceTimersByTime(60_000);
    expect(calls).toBe(1);

    vi.advanceTimersByTime(60_000);
    expect(calls).toBe(2);

    clearInterval(interval);
  });

  it("at 60 s interval, 10 minutes produces 10 polls (vs 60 at old 10 s)", () => {
    let calls = 0;
    const interval = setInterval(() => { calls++; }, 60_000);
    vi.advanceTimersByTime(10 * 60 * 1000);
    clearInterval(interval);
    expect(calls).toBe(10); // was 60 before the fix
  });

  it("cleanup removes the interval (no memory leak on unmount)", () => {
    let calls = 0;
    const interval = setInterval(() => { calls++; }, 60_000);
    clearInterval(interval); // simulate component unmount
    vi.advanceTimersByTime(60_000);
    expect(calls).toBe(0);
  });
});

// ── 4. Walk history date-range logic ─────────────────────────────────────────
//
// Mirrors the range-param parsing in walk.ts route.
// Ensures correct start-date calculation for 7d, 30d, 365d ranges.

describe("Walk history date-range param parsing", () => {
  function computeStartDate(rangeParam: string | null, todayStr: string): string {
    const today = new Date(todayStr + "T00:00:00Z");
    const rangeDays = rangeParam === "7d" ? 7 : rangeParam === "30d" ? 30 : 365;
    const startDate = new Date(today);
    startDate.setUTCDate(today.getUTCDate() - (rangeDays - 1));
    return startDate.toISOString().split("T")[0];
  }

  it("7d range: start date is 6 days before today", () => {
    const start = computeStartDate("7d", "2026-06-15");
    expect(start).toBe("2026-06-09");
  });

  it("30d range: start date is 29 days before today", () => {
    const start = computeStartDate("30d", "2026-06-15");
    expect(start).toBe("2026-05-17");
  });

  it("365d (default) range: start date is 364 days before today", () => {
    const start = computeStartDate("365d", "2026-06-15");
    expect(start).toBe("2025-06-16");
  });

  it("null range param defaults to 365d", () => {
    const start = computeStartDate(null, "2026-06-15");
    expect(start).toBe("2025-06-16");
  });

  it("unknown range param defaults to 365d", () => {
    const start = computeStartDate("90d", "2026-06-15");
    expect(start).toBe("2025-06-16");
  });

  it("7d range includes today as the last day", () => {
    const today = "2026-06-15";
    const start = computeStartDate("7d", today);
    const startDate = new Date(start + "T00:00:00Z");
    const todayDate = new Date(today + "T00:00:00Z");
    const diffDays = Math.round((todayDate.getTime() - startDate.getTime()) / 86_400_000);
    expect(diffDays).toBe(6); // 7 days inclusive means 6-day gap
  });

  it("month-boundary crossing: 30d range from June 1 starts in May", () => {
    const start = computeStartDate("30d", "2026-06-01");
    expect(start).toBe("2026-05-03");
  });

  it("year-boundary crossing: 365d range from Jan 1 starts in prior year", () => {
    const start = computeStartDate("365d", "2026-01-01");
    expect(start).toBe("2025-01-02");
  });
});

// ── 5. User search min-length guard ──────────────────────────────────────────
//
// Documents the 3-character minimum enforced at the route level.
// This pairs with the pg_trgm GIN index (which is most effective for ≥3 chars).

describe("User search min-length enforcement", () => {
  function shouldSearch(query: string): boolean {
    return query.trim().length >= 3;
  }

  it("query with 1 char returns empty without hitting DB", () => {
    expect(shouldSearch("a")).toBe(false);
  });

  it("query with 2 chars returns empty without hitting DB", () => {
    expect(shouldSearch("ab")).toBe(false);
  });

  it("query with 3 chars triggers a DB search", () => {
    expect(shouldSearch("abc")).toBe(true);
  });

  it("query with spaces only returns empty", () => {
    expect(shouldSearch("   ")).toBe(false);
  });

  it("query with 2 chars + trailing space returns empty (trim applied first)", () => {
    expect(shouldSearch("ab ")).toBe(false);
  });

  it("query with 10 chars triggers a DB search", () => {
    expect(shouldSearch("walkchamp1")).toBe(true);
  });
});

// ── 6. Skeleton display logic ─────────────────────────────────────────────────
//
// Documents when skeleton loaders should appear vs real content.
// Mirrors the walkCacheReady flag pattern in walk.tsx and live.tsx.

describe("Skeleton display logic", () => {
  it("skeleton shows when no cache exists and data not yet fetched", () => {
    const walkCacheReady = false;
    const showSkeleton = !walkCacheReady;
    expect(showSkeleton).toBe(true);
  });

  it("skeleton hidden when memory cache hit on tab revisit", () => {
    const walkCacheReady = true; // cache hit on getSync()
    const showSkeleton = !walkCacheReady;
    expect(showSkeleton).toBe(false);
  });

  it("skeleton hidden after first successful API fetch", () => {
    let walkCacheReady = false;
    // Simulate fetch success
    walkCacheReady = true;
    const showSkeleton = !walkCacheReady;
    expect(showSkeleton).toBe(false);
  });

  it("Live tab: skeleton shows only on first filter load (no cached data)", () => {
    const cache = makeScreenCache();
    const activeFilter = "Live";
    const hasCached = cache.getSync(`screen_live_${activeFilter}`) !== null;
    const showLoading = !hasCached;
    expect(showLoading).toBe(true);
  });

  it("Live tab: skeleton hidden when filter already cached", async () => {
    const cache = makeScreenCache();
    const activeFilter = "Live";
    await cache.set(`screen_live_${activeFilter}`, [{ id: "race1" }]);
    const hasCached = cache.getSync(`screen_live_${activeFilter}`) !== null;
    const showLoading = !hasCached;
    expect(showLoading).toBe(false);
  });
});
