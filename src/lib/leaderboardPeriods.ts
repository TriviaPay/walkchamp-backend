function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function dayNumber(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function isValidDateStr(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function utcToday(now = new Date()): string {
  return now.toISOString().split("T")[0] ?? "";
}

function clampRecentDate(raw: unknown, maxDaysBeforeToday: number, now = new Date()): string | null {
  if (!isValidDateStr(raw)) return null;
  const today = utcToday(now);
  const diff = dayNumber(today) - dayNumber(raw);
  return diff >= 0 && diff <= maxDaysBeforeToday ? raw : null;
}

function mondayOfUtcWeek(now = new Date()): string {
  const day = now.getUTCDay();
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7));
  return monday.toISOString().split("T")[0] ?? utcToday(now);
}

function firstOfUtcMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export function getLeaderboardPeriodDates(
  period: string,
  localDate?: unknown,
  weekStart?: unknown,
  monthStart?: unknown,
  now = new Date(),
): { startDate: string; endDate: string } {
  const todayStr = clampRecentDate(localDate, 1, now) ?? utcToday(now);

  if (period === "today") return { startDate: todayStr, endDate: todayStr };

  if (period === "week") {
    return {
      startDate: clampRecentDate(weekStart, 7, now) ?? mondayOfUtcWeek(now),
      endDate: todayStr,
    };
  }

  if (period === "month") {
    return {
      startDate: clampRecentDate(monthStart, 31, now) ?? firstOfUtcMonth(now),
      endDate: todayStr,
    };
  }

  return { startDate: "", endDate: "" };
}
