// Reporting-period arithmetic: months, local dates in a workspace's timezone, and the
// ranges of months a report covers.

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

/** The local calendar date (YYYY-MM-DD) of `now` in an IANA zone, and the UTC instant of its midnight. */
export function localDate(now: Date, timeZone: string): { date: string; midnight: Date } {
  const p = localParts(now, timeZone);
  const date = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  return { date, midnight: zonedTimeToUtc(p.year, p.month, p.day, 0, timeZone) };
}

// ---- Report ranges -------------------------------------------------------------------------
// A report covers one month or a range of months; data is entered per month. The report key is
// 'YYYY-MM' for one month and 'YYYY-MM_YYYY-MM' for a range.
export const MAX_REPORT_MONTHS = 36;
export type ReportRange = { key: string; start: string; end: string; months: string[]; label: string };
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function reportRange(start: string, end: string = start): ReportRange {
  if (!PERIOD_RE.test(start) || !PERIOD_RE.test(end)) throw new RangeError("Months must be YYYY-MM");
  if (end < start) throw new RangeError("The end month is before the start month");
  const months: string[] = [];
  for (let [y, m] = start.split("-").map(Number); `${y}-${String(m).padStart(2, "0")}` <= end; m === 12 ? (y++, m = 1) : m++) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    if (months.length > MAX_REPORT_MONTHS) throw new RangeError(`A report covers at most ${MAX_REPORT_MONTHS} months`);
  }
  return { key: start === end ? start : `${start}_${end}`, start, end, months, label: periodLabel(start === end ? start : `${start}_${end}`) };
}

export function parseReportKey(key: string): ReportRange {
  const [start, end = start] = key.split("_");
  return reportRange(start, end);
}

/** "October 2026", "January–April 2026" or "November 2025–February 2026". */
export function periodLabel(key: string): string {
  const [start, end = start] = key.split("_");
  const name = (p: string) => `${MONTH_NAMES[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;
  if (!PERIOD_RE.test(start) || !PERIOD_RE.test(end)) return key;
  if (start === end) return name(start);
  return start.slice(0, 4) === end.slice(0, 4) ? `${MONTH_NAMES[Number(start.slice(5, 7)) - 1]}–${name(end)}` : `${name(start)}–${name(end)}`;
}
