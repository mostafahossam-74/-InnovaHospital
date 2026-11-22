// Reporting-period arithmetic. A report is labelled with the month it covers.
// At the workspace's schedule (e.g. day 1, 09:00 Africa/Cairo) the scheduler
// queues the previous, now-closed, local month (Developer_Handoff §3).

export type Period = { period: string; start: string; end: string };

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function parsePeriod(period: string): Period {
  const m = PERIOD_RE.exec(period);
  if (!m) throw new RangeError("Period must be YYYY-MM");
  const year = Number(m[1]);
  const month = Number(m[2]);
  return monthWindow(year, month);
}

export function monthWindow(year: number, month: number): Period {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, "0");
  return {
    period: `${year}-${mm}`,
    start: `${year}-${mm}-01`,
    end: `${year}-${mm}-${String(lastDay).padStart(2, "0")}`,
  };
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function localParts(instant: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return parts as unknown as LocalParts;
}

/** Converts a wall-clock time in an IANA zone to the UTC instant. */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, timeZone: string): Date {
  const target = Date.UTC(year, month - 1, day, hour);
  let guess = target;
  // Two iterations converge for every real zone; the third handles DST edges.
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += target - asUtc;
  }
  return new Date(guess);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type ScheduleSettings = { timezone: string; schedule_day: number; schedule_hour: number };

/**
 * Returns the most recent period whose scheduled collection time is at or
 * before `now`, with that scheduled UTC instant. Inserting the run is
 * idempotent on (workspace, period_start), so calling this every 15 minutes
 * yields exactly one run per closed month.
 */
export function duePeriod(now: Date, s: ScheduleSettings): Period & { scheduledAt: Date } {
  const local = localParts(now, s.timezone);
  let year = local.year;
  let month = local.month;
  let scheduledAt = zonedTimeToUtc(year, month, s.schedule_day, s.schedule_hour, s.timezone);
  if (now.getTime() < scheduledAt.getTime()) {
    // This month's slot has not arrived yet; the latest due slot was last month's.
    month -= 1;
    if (month === 0) { month = 12; year -= 1; }
    scheduledAt = zonedTimeToUtc(year, month, s.schedule_day, s.schedule_hour, s.timezone);
  }
  // The slot in local month M covers month M-1.
  let pYear = year;
  let pMonth = month - 1;
  if (pMonth === 0) { pMonth = 12; pYear -= 1; }
  return { ...monthWindow(pYear, pMonth), scheduledAt };
}
