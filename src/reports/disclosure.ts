// Disclosure control for the monthly report (Developer_Handoff §5 steps 3-4).
//
// A department's indicator is suppressed when its numerator or complement (denominator -
// numerator) is below the hospital's threshold. A hospital-wide total then creates a
// differencing risk: total minus the departments that are shown equals what the hidden
// departments add up to. pooledIndicator() hides the total whenever that leftover, or the
// total itself, is small. disclosureProblems() re-checks a finished snapshot independently
// and is run again before approval and release.
import type { IndicatorStatus } from "./snapshot.ts";

export type PooledStatus = "verified" | "suppressed" | "not_applicable" | "incomplete";
export type DepartmentCell = { status: IndicatorStatus; numerator: number | null; denominator: number | null };
export type Pooled = {
  status: PooledStatus; departments: number;
  numerator?: number; denominator?: number; percent?: number; target_percent?: number; meets_target?: boolean;
  /** Why a total is hidden: its own count is small, or subtracting the shown departments would reveal a small count. */
  suppression_reason?: "small_total" | "differencing";
  departments_pending?: number;
};

const r2 = (v: number) => Math.round(v * 100) / 100;
const small = (num: number, den: number, threshold: number) => num < threshold || den - num < threshold;

/**
 * Pools one indicator (one definition version) over the reporting departments. `cells` carry
 * the real counts of every department, suppressed ones included; only safe figures are returned.
 */
export function pooledIndicator(cells: DepartmentCell[], threshold: number, target?: { target_bp: number | null; direction: string }): Pooled {
  const pending = cells.filter((x) => ["missing", "unverified", "returned"].includes(x.status)).length;
  if (pending) return { status: "incomplete", departments: cells.length, departments_pending: pending };
  // Verified, suppressed and not applicable (zero eligible cases, adding 0/0) all hold verified counts.
  const num = cells.reduce((s, x) => s + (x.numerator ?? 0), 0);
  const den = cells.reduce((s, x) => s + (x.denominator ?? 0), 0);
  if (den === 0) return { status: "not_applicable", departments: cells.length };
  if (small(num, den, threshold)) return { status: "suppressed", departments: cells.length, suppression_reason: "small_total" };
  const hidden = cells.filter((x) => x.status === "suppressed");
  if (hidden.length) {
    const hNum = hidden.reduce((s, x) => s + x.numerator!, 0), hDen = hidden.reduce((s, x) => s + x.denominator!, 0);
    if (small(hNum, hDen, threshold)) return { status: "suppressed", departments: cells.length, suppression_reason: "differencing" };
  }
  const out: Pooled = { status: "verified", departments: cells.length, numerator: num, denominator: den, percent: r2((100 * num) / den) };
  if (target && target.target_bp !== null) {
    out.target_percent = target.target_bp / 100;
    // Exact integer comparison, as for departments (Handoff §5 step 3).
    out.meets_target = target.direction === "higher_better" ? num * 10000 >= den * target.target_bp : num * 10000 <= den * target.target_bp;
  }
  return out;
}

type ShownRow = { code: string; department?: string; status: string; numerator?: number; denominator?: number; definition_version?: number };

/**
 * Re-checks a built snapshot from what it would show: no shown cell is small, and no shown
 * total minus the shown departments leaves a small remainder. Returns readable problems.
 */
export function disclosureProblems(s: { disclosure_threshold: number; indicators: ShownRow[]; indicator_totals?: ShownRow[] }): string[] {
  const t = s.disclosure_threshold;
  const problems: string[] = [];
  const shown = (r: ShownRow) => typeof r.numerator === "number" && typeof r.denominator === "number";
  for (const r of [...s.indicators, ...(s.indicator_totals ?? [])]) {
    if (shown(r) && r.denominator! > 0 && small(r.numerator!, r.denominator!, t)) {
      problems.push(`${r.code} (${r.department ?? "all departments"}): a count below ${t} is shown`);
    }
  }
  for (const total of s.indicator_totals ?? []) {
    if (!shown(total)) continue;
    const rows = s.indicators.filter((r) => r.code === total.code && r.definition_version === total.definition_version);
    if (rows.some((r) => !["verified", "suppressed", "not_applicable"].includes(r.status))) {
      problems.push(`${total.code}: a total is shown while a department is not verified`);
      continue;
    }
    if (!rows.some((r) => r.status === "suppressed")) continue;
    const restNum = total.numerator! - rows.filter(shown).reduce((sum, r) => sum + r.numerator!, 0);
    const restDen = total.denominator! - rows.filter(shown).reduce((sum, r) => sum + r.denominator!, 0);
    if (small(restNum, restDen, t)) problems.push(`${total.code}: the total minus the shown departments reveals a count below ${t}`);
  }
  return problems;
}
