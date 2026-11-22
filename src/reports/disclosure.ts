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

// ---- Across reports ----------------------------------------------------------------------------
// Reports cover ranges of months, and ranges can overlap (January–March released, then
// January–April). Every figure a reader has seen is a sum over some departments and some months;
// any linear combination of them can be worked out (April alone = January–April minus
// January–March). findLeak() asks whether a new report's figures make some block of
// departments × months computable that was not before, and works out the value a reader would get
// from the figures as published; it is a leak when that has fewer than the threshold of events or
// non-events. Months are grouped into "atoms" that no figure tells apart, so a block is a set of
// departments × a set of atoms; membership in the span of the figures is tested exactly.

/** A figure a reader sees: a sum over departments and months, with the numbers as shown. */
export type Figure = { depts: string[]; months: string[]; numerator: number; denominator: number };

const EPS = 1e-9;
type Row = { row: number[]; val: [number, number]; pivot: number };
/** Reduced row echelon basis (Gaussian elimination); each row carries its numbers along. */
function basis(rows: { row: number[]; val: [number, number] }[]): Row[] {
  const out: Row[] = [];
  for (const r0 of rows) {
    const { rest, val } = reduce(r0.row, out, r0.val);
    const pivot = rest.findIndex((v) => Math.abs(v) > EPS);
    if (pivot < 0) continue;
    const k = rest[pivot];
    const scaled = rest.map((v) => v / k), sval: [number, number] = [val[0] / k, val[1] / k];
    for (const b of out) {
      const f = b.row[pivot];
      if (Math.abs(f) > EPS) { for (let j = 0; j < scaled.length; j++) b.row[j] -= f * scaled[j]; b.val[0] -= f * sval[0]; b.val[1] -= f * sval[1]; }
    }
    out.push({ row: scaled, val: sval, pivot });
  }
  return out;
}
/** What remains of v after taking out the basis, and the numbers of the part taken out (start: val0 − ...). */
function reduce(v: number[], b: Row[], val0: [number, number] = [0, 0]): { rest: number[]; val: [number, number] } {
  const rest = [...v];
  const val: [number, number] = [...val0];
  for (const { row, val: bv, pivot } of b) {
    const f = rest[pivot];
    if (Math.abs(f) > EPS) { for (let j = 0; j < rest.length; j++) rest[j] -= f * row[j]; val[0] -= f * bv[0]; val[1] -= f * bv[1]; }
  }
  return { rest, val };
}
const inSpan = (v: number[], b: Row[]) => reduce(v, b).rest.every((x) => Math.abs(x) <= EPS);
/** The numbers a reader computes for v from the figures (v must be in their span). */
const revealed = (v: number[], b: Row[]): [number, number] => { const { val } = reduce(v, b); return [-val[0], -val[1]]; };

/** Subsets of 0..n-1 (as index lists), all of them when there are at most 2^maxBits, else singletons, pairs and the whole set. */
function subsets(n: number, maxBits: number): number[][] {
  const out: number[][] = [];
  if (n <= maxBits) { for (let m = 1; m < 1 << n; m++) out.push([...Array(n).keys()].filter((i) => m & (1 << i))); return out; }
  for (let i = 0; i < n; i++) { out.push([i]); for (let j = i + 1; j < n; j++) out.push([i, j]); }
  out.push([...Array(n).keys()]);
  return out;
}

export type Leak = { figure: number; depts: string[]; months: string[]; numerator: number; denominator: number };

/**
 * Returns a block of departments × months that the new figures make computable, together with
 * the released ones, whose computed value has fewer than `threshold` events or non-events; and
 * the index of the new figure to hide for it (the first, in the given order, whose removal makes
 * the block uncomputable again). Null when the new figures disclose nothing new.
 */
export function findLeak(threshold: number, newFigs: Figure[], oldFigs: Figure[]): Leak | null {
  if (!newFigs.length) return null;
  const all = [...oldFigs, ...newFigs];
  const depts = [...new Set(all.flatMap((f) => f.depts))].sort();
  const months = [...new Set(all.flatMap((f) => f.months))].sort();
  // Atoms: months that every figure either covers together or leaves out together.
  const sig = (m: string) => all.map((f) => (f.months.includes(m) ? "1" : "0")).join("");
  const atoms = [...new Set(months.map(sig))].map((s) => months.filter((m) => sig(m) === s));
  const cols = depts.length * atoms.length;
  const col = (d: number, a: number) => d * atoms.length + a;
  const vec = (f: Figure) => {
    const v = new Array(cols).fill(0);
    for (const d of f.depts) for (let a = 0; a < atoms.length; a++) if (f.months.includes(atoms[a][0])) v[col(depts.indexOf(d), a)] = 1;
    return { row: v, val: [f.numerator, f.denominator] as [number, number] };
  };
  const oldBasis = basis(oldFigs.map(vec));
  const allBasis = basis(all.map(vec));
  // Budget: every group of departments × every set of atoms when small, else a reduced family.
  const dBits = depts.length <= 7 ? 7 : 0, aBits = atoms.length <= 8 ? 8 : 0;
  for (const g of subsets(depts.length, dBits)) {
    for (const s of subsets(atoms.length, aBits)) {
      const v = new Array(cols).fill(0);
      for (const d of g) for (const a of s) v[col(d, a)] = 1;
      if (!inSpan(v, allBasis) || inSpan(v, oldBasis)) continue;
      const [num, den] = revealed(v, allBasis).map((x) => Math.round(x * 1e6) / 1e6);
      // A real count with too few events or non-events (inconsistent figures, e.g. a correction, give no count).
      if (!(den > 0 && num >= 0 && num <= den && (num < threshold || den - num < threshold))) continue;
      // Which new figure to hide: the first whose removal makes the block uncomputable.
      let figure = newFigs.findIndex((_, i) => !inSpan(v, basis([...oldFigs, ...newFigs.filter((__, j) => j !== i)].map(vec))));
      if (figure < 0) figure = newFigs.findIndex((f) => f.depts.some((d) => g.includes(depts.indexOf(d))) && s.some((a) => f.months.includes(atoms[a][0])));
      return { figure: Math.max(figure, 0), depts: g.map((d) => depts[d]), months: s.flatMap((a) => atoms[a]), numerator: num, denominator: den };
    }
  }
  return null;
}
