/**
 * Walk history range/date calculation tests.
 *
 * The GET /api/walk/history endpoint accepts optional query params:
 *   range=7d | 30d  (defaults to 365 days)
 *   startDate=YYYY-MM-DD  (overrides range)
 *   endDate=YYYY-MM-DD    (overrides today)
 *
 * These tests verify that the range logic (duplicated from walk.ts) produces
 * the correct startStr/endStr bounds for all combinations.
 */
import { describe, it, expect } from "vitest";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Mirrors the range resolution logic from GET /api/walk/history in walk.ts.
 */
function resolveHistoryRange(
  todayStr: string,
  rangeParam?: string | null,
  startDParam?: string | null,
  endDParam?: string | null,
): { startStr: string; endStr: string } {
  const today = new Date(todayStr + "T00:00:00Z");
  const endStr =
    endDParam && ISO_DATE_RE.test(endDParam) ? endDParam : todayStr;

  let startStr: string;
  if (startDParam && ISO_DATE_RE.test(startDParam)) {
    startStr = startDParam;
  } else {
    const rangeDays =
      rangeParam === "7d" ? 7 : rangeParam === "30d" ? 30 : 365;
    const startDate = new Date(today);
    startDate.setUTCDate(today.getUTCDate() - (rangeDays - 1));
    startStr = startDate.toISOString().split("T")[0];
  }

  return { startStr, endStr };
}

/** Count calendar days in the closed interval [startStr, endStr]. */
function dayCount(startStr: string, endStr: string): number {
  const cursor = new Date(startStr + "T00:00:00Z");
  const end = new Date(endStr + "T00:00:00Z");
  let count = 0;
  while (cursor <= end) {
    count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

const TODAY = "2026-06-15";

describe("default (no params) — 365-day range", () => {
  it("endStr is today", () => {
    const { endStr } = resolveHistoryRange(TODAY);
    expect(endStr).toBe("2026-06-15");
  });

  it("startStr is 364 days before today (inclusive 365-day window)", () => {
    const { startStr } = resolveHistoryRange(TODAY);
    expect(startStr).toBe("2025-06-16");
  });

  it("produces exactly 365 days when iterated", () => {
    const { startStr, endStr } = resolveHistoryRange(TODAY);
    expect(dayCount(startStr, endStr)).toBe(365);
  });
});

describe("range=7d", () => {
  it("endStr is today", () => {
    const { endStr } = resolveHistoryRange(TODAY, "7d");
    expect(endStr).toBe("2026-06-15");
  });

  it("startStr is 6 days before today", () => {
    const { startStr } = resolveHistoryRange(TODAY, "7d");
    expect(startStr).toBe("2026-06-09");
  });

  it("produces exactly 7 days", () => {
    const { startStr, endStr } = resolveHistoryRange(TODAY, "7d");
    expect(dayCount(startStr, endStr)).toBe(7);
  });
});

describe("range=30d", () => {
  it("startStr is 29 days before today", () => {
    const { startStr } = resolveHistoryRange(TODAY, "30d");
    expect(startStr).toBe("2026-05-17");
  });

  it("produces exactly 30 days", () => {
    const { startStr, endStr } = resolveHistoryRange(TODAY, "30d");
    expect(dayCount(startStr, endStr)).toBe(30);
  });
});

describe("unknown range param falls back to 365", () => {
  it("range=365d (explicit) falls back to 365", () => {
    const { startStr } = resolveHistoryRange(TODAY, "365d");
    expect(startStr).toBe("2025-06-16");
  });

  it("range=99d falls back to 365", () => {
    const { startStr } = resolveHistoryRange(TODAY, "99d");
    expect(startStr).toBe("2025-06-16");
  });

  it("range=week falls back to 365", () => {
    const { startStr } = resolveHistoryRange(TODAY, "week");
    expect(startStr).toBe("2025-06-16");
  });
});

describe("explicit startDate overrides range", () => {
  it("startDate overrides range=7d", () => {
    const { startStr } = resolveHistoryRange(TODAY, "7d", "2026-01-01");
    expect(startStr).toBe("2026-01-01");
  });

  it("startDate overrides default 365d range", () => {
    const { startStr } = resolveHistoryRange(TODAY, null, "2026-03-01");
    expect(startStr).toBe("2026-03-01");
  });

  it("startDate does not affect endStr", () => {
    const { endStr } = resolveHistoryRange(TODAY, null, "2026-01-01");
    expect(endStr).toBe(TODAY);
  });
});

describe("explicit endDate overrides today", () => {
  it("endDate shifts the upper bound", () => {
    const { endStr } = resolveHistoryRange(TODAY, null, null, "2026-06-10");
    expect(endStr).toBe("2026-06-10");
  });

  it("endDate does not affect startStr calculation", () => {
    const { startStr: withEnd } = resolveHistoryRange(
      TODAY,
      "7d",
      null,
      "2026-06-10",
    );
    const { startStr: withoutEnd } = resolveHistoryRange(TODAY, "7d");
    expect(withEnd).toBe(withoutEnd);
  });
});

describe("both startDate and endDate override everything", () => {
  it("explicit window ignores range param entirely", () => {
    const { startStr, endStr } = resolveHistoryRange(
      TODAY,
      "30d",
      "2026-01-01",
      "2026-03-31",
    );
    expect(startStr).toBe("2026-01-01");
    expect(endStr).toBe("2026-03-31");
  });
});

describe("invalid date param formats", () => {
  it("invalid startDate format falls back to range calc", () => {
    const { startStr } = resolveHistoryRange(TODAY, "7d", "not-a-date");
    expect(startStr).toBe("2026-06-09");
  });

  it("MM/DD/YYYY format is rejected — falls back", () => {
    const { startStr } = resolveHistoryRange(TODAY, "7d", "06/01/2026");
    expect(startStr).toBe("2026-06-09");
  });

  it("invalid endDate format falls back to today", () => {
    const { endStr } = resolveHistoryRange(TODAY, null, null, "june-15-2026");
    expect(endStr).toBe(TODAY);
  });
});

describe("startStr is always before or equal to endStr", () => {
  it("7d range: startStr < endStr", () => {
    const { startStr, endStr } = resolveHistoryRange(TODAY, "7d");
    expect(startStr < endStr).toBe(true);
  });

  it("30d range: startStr < endStr", () => {
    const { startStr, endStr } = resolveHistoryRange(TODAY, "30d");
    expect(startStr < endStr).toBe(true);
  });

  it("default: startStr < endStr", () => {
    const { startStr, endStr } = resolveHistoryRange(TODAY);
    expect(startStr < endStr).toBe(true);
  });

  it("explicit single-day window: startStr === endStr", () => {
    const { startStr, endStr } = resolveHistoryRange(
      TODAY,
      null,
      TODAY,
      TODAY,
    );
    expect(startStr).toBe(endStr);
    expect(dayCount(startStr, endStr)).toBe(1);
  });
});
