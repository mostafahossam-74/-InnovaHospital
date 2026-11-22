// Outcomes analytics over verified aggregate hospital data.
//
// Input: aggregate cells (condition x management x department x month) and
// hospital parameters (department x month). Output: a deterministic, JSON
// result covering
//   - disease burden: share of all cases per condition, by department, trend;
//   - management and outcomes: mortality, 30-day readmission, complications,
//     mean length of stay and mean cost per case for each way a condition is managed;
//   - comparative outcomes between managements (risk differences, risk ratios,
//     Benjamini-Hochberg q values across every test in the run);
//   - health economics: incremental cost, incremental effect and ICER per
//     death averted, with the dominance class;
//   - between-department variation in outcomes for the same condition;
//   - associations between hospital parameters and outcomes (Spearman);
//   - coverage of high-burden conditions by the research portfolio;
//   - data completeness.
// The same input always gives the same output (sorted keys, rounded values),
// so the stored digest identifies the analysis.
import { benjaminiHochberg, compareProportions, heterogeneity, rateRatio, round, spearman, wilson } from "./stats.ts";

export const ENGINE_VERSION = "ih-analytics-1";

export type CaseRow = {
  period: string; department_id: string; department: string;
  condition_code: string; condition_label: string; management: string;
  cases: number; deaths: number | null; readmissions_30d: number | null; complications: number | null;
  los_days_sum: number | null; cost_sum: number | null;
};
export type ParamRow = { period: string; department_id: string; department: string; parameter_code: string; parameter_label: string; value: number; unit: string | null };
export type PortfolioItem = { kind: "project" | "idea"; title: string; condition_codes: string[]; status: string };
export type EngineConfig = {
  /** Minimum patients in each arm before a comparison is tested. */
  min_cases: number;
  /** False discovery rate for flagging signals. */
  alpha: number;
  /** Minimum department-months for a parameter association. */
  min_points: number;
  /** A condition is "high burden" from this share of all cases. */
  high_burden_share: number;
  currency: string;
};
export const DEFAULT_CONFIG: EngineConfig = { min_cases: 30, alpha: 0.05, min_points: 8, high_burden_share: 0.05, currency: "EGP" };

export const OUTCOMES = ["deaths", "readmissions_30d", "complications"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const OUTCOME_LABEL: Record<Outcome, string> = { deaths: "in-hospital mortality", readmissions_30d: "30-day readmission", complications: "complications" };

type Totals = { cases: number; deaths: number; deaths_n: number; readmissions_30d: number; readmissions_30d_n: number;
  complications: number; complications_n: number; los: number; los_n: number; cost: number; cost_n: number };
const empty = (): Totals => ({ cases: 0, deaths: 0, deaths_n: 0, readmissions_30d: 0, readmissions_30d_n: 0, complications: 0, complications_n: 0, los: 0, los_n: 0, cost: 0, cost_n: 0 });
function add(t: Totals, r: CaseRow) {
  t.cases += r.cases;
  for (const o of OUTCOMES) if (r[o] !== null) { t[o] += r[o]!; t[`${o}_n`] += r.cases; }
  if (r.los_days_sum !== null) { t.los += Number(r.los_days_sum); t.los_n += r.cases; }
  if (r.cost_sum !== null) { t.cost += Number(r.cost_sum); t.cost_n += r.cases; }
}
const group = <T>(rows: T[], key: (r: T) => string) => {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k)!.push(r); }
  return m;
};

export type Rate = { events: number; n: number; rate: number; low: number; high: number } | null;
function rate(t: Totals, o: Outcome): Rate {
  const n = t[`${o}_n`];
  if (n === 0) return null;
  const [low, high] = wilson(t[o], n);
  return { events: t[o], n, rate: round(t[o] / n), low: round(low), high: round(high) };
}
function profile(t: Totals) {
  return {
    cases: t.cases,
    mortality: rate(t, "deaths"), readmission: rate(t, "readmissions_30d"), complication: rate(t, "complications"),
    mean_los_days: t.los_n ? round(t.los / t.los_n, 2) : null,
    mean_cost: t.cost_n ? round(t.cost / t.cost_n, 2) : null,
  };
}
const OUTCOME_KEY: Record<Outcome, "mortality" | "readmission" | "complication"> = { deaths: "mortality", readmissions_30d: "readmission", complications: "complication" };

export function analyze(caseRows: CaseRow[], paramRows: ParamRow[], portfolio: PortfolioItem[], cfg: EngineConfig = DEFAULT_CONFIG) {
  const periods = [...new Set([...caseRows.map((r) => r.period), ...paramRows.map((r) => r.period)])].sort();
  const departments = new Map<string, string>();
  for (const r of [...caseRows, ...paramRows]) departments.set(r.department_id, r.department);
  const total = empty();
  for (const r of caseRows) add(total, r);

  // ---- Burden ----------------------------------------------------------------
  const byCondition = group(caseRows, (r) => r.condition_code);
  const half = Math.floor(periods.length / 2);
  const early = new Set(periods.slice(0, half)), late = new Set(periods.slice(periods.length - half));
  const earlyTotal = caseRows.filter((r) => early.has(r.period)).reduce((s, r) => s + r.cases, 0);
  const lateTotal = caseRows.filter((r) => late.has(r.period)).reduce((s, r) => s + r.cases, 0);

  const conditions = [...byCondition.entries()].map(([code, rows]) => {
    const t = empty(); rows.forEach((r) => add(t, r));
    const [low, high] = wilson(t.cases, total.cases);
    const byDept = [...group(rows, (r) => r.department_id).entries()].map(([id, rs]) => {
      const d = empty(); rs.forEach((r) => add(d, r));
      return { department_id: id, department: departments.get(id)!, ...profile(d) };
    }).sort((a, b) => b.cases - a.cases || a.department.localeCompare(b.department));
    const monthly = periods.map((p) => ({ period: p, cases: rows.filter((r) => r.period === p).reduce((s, r) => s + r.cases, 0) }));
    const e = rows.filter((r) => early.has(r.period)).reduce((s, r) => s + r.cases, 0);
    const l = rows.filter((r) => late.has(r.period)).reduce((s, r) => s + r.cases, 0);
    // Trend: change in this condition's share of all cases, later half vs earlier half.
    const trend = half >= 2 && e + l > 0 && earlyTotal > 0 && lateTotal > 0
      ? { early_periods: [...early].sort(), late_periods: [...late].sort(), early_cases: e, late_cases: l,
          early_share: round(e / earlyTotal), late_share: round(l / lateTotal),
          ...(() => { const rr = rateRatio(l, lateTotal, e, earlyTotal); return { share_ratio: round(rr.rr, 3), low: round(rr.low, 3), high: round(rr.high, 3), p_value: round(rr.p_value, 6) }; })() }
      : null;
    return {
      condition_code: code, condition_label: rows[0].condition_label,
      share: round(t.cases / total.cases), share_low: round(low), share_high: round(high),
      ...profile(t), departments: byDept, monthly, trend,
      managements: [...new Set(rows.map((r) => r.management))].sort(),
    };
  }).sort((a, b) => b.cases - a.cases || a.condition_code.localeCompare(b.condition_code));

  // ---- Management and outcomes ------------------------------------------------------
  const managementProfiles = [...group(caseRows, (r) => `${r.condition_code}\u0000${r.management}`).entries()].map(([, rows]) => {
    const t = empty(); rows.forEach((r) => add(t, r));
    return { condition_code: rows[0].condition_code, condition_label: rows[0].condition_label, management: rows[0].management,
      share_of_condition: 0, ...profile(t), _t: t };
  });
  for (const m of managementProfiles) {
    const c = conditions.find((x) => x.condition_code === m.condition_code)!;
    m.share_of_condition = round(m.cases / c.cases);
  }

  // ---- Comparisons between managements (vs. the most common management) ---------------
  type Test = { kind: "management" | "department" | "parameter" | "trend"; p: number; set: (q: number) => void };
  const tests: Test[] = [];
  const comparisons: Record<string, unknown>[] = [];
  const economics: Record<string, unknown>[] = [];
  for (const c of conditions) {
    const arms = managementProfiles.filter((m) => m.condition_code === c.condition_code && m.cases >= cfg.min_cases)
      .sort((a, b) => b.cases - a.cases || a.management.localeCompare(b.management));
    if (arms.length < 2) continue;
    const ref = arms[0];
    for (const alt of arms.slice(1)) {
      for (const o of OUTCOMES) {
        const a = alt._t, r = ref._t;
        if (!a[`${o}_n`] || !r[`${o}_n`]) continue;
        const cmp = compareProportions(a[o], a[`${o}_n`], r[o], r[`${o}_n`]);
        const row: Record<string, unknown> = {
          condition_code: c.condition_code, condition_label: c.condition_label, outcome: o, outcome_label: OUTCOME_LABEL[o],
          management: alt.management, reference: ref.management,
          n: a[`${o}_n`], events: a[o], n_ref: r[`${o}_n`], events_ref: r[o],
          rate: round(cmp.p1), rate_ref: round(cmp.p2),
          risk_difference: round(cmp.rd), rd_low: round(cmp.rd_low), rd_high: round(cmp.rd_high),
          risk_ratio: round(cmp.rr, 3), rr_low: round(cmp.rr_low, 3), rr_high: round(cmp.rr_high, 3),
          p_value: round(cmp.p_value, 6), q_value: null,
        };
        comparisons.push(row);
        tests.push({ kind: "management", p: cmp.p_value, set: (q) => { row.q_value = round(q, 6); } });
      }
      // Health economics: hospital-perspective incremental cost per death averted.
      const ca = alt._t, cr = ref._t;
      if (ca.cost_n && cr.cost_n) {
        const costAlt = ca.cost / ca.cost_n, costRef = cr.cost / cr.cost_n;
        const dCost = costAlt - costRef;
        const mortAlt = ca.deaths_n ? ca.deaths / ca.deaths_n : null, mortRef = cr.deaths_n ? cr.deaths / cr.deaths_n : null;
        const dEffect = mortAlt !== null && mortRef !== null ? mortRef - mortAlt : null; // deaths averted per patient
        let dominance: string;
        if (dEffect === null) dominance = "effect_unknown";
        else if (dCost <= 0 && dEffect >= 0) dominance = "dominant";
        else if (dCost >= 0 && dEffect <= 0) dominance = "dominated";
        else if (dCost > 0) dominance = "more_costly_more_effective";
        else dominance = "less_costly_less_effective";
        const icer = dEffect && dEffect !== 0 && (dominance === "more_costly_more_effective" || dominance === "less_costly_less_effective") ? dCost / dEffect : null;
        const losAlt = ca.los_n ? ca.los / ca.los_n : null, losRef = cr.los_n ? cr.los / cr.los_n : null;
        economics.push({
          condition_code: c.condition_code, condition_label: c.condition_label, management: alt.management, reference: ref.management,
          n: alt.cases, n_ref: ref.cases, currency: cfg.currency,
          mean_cost: round(costAlt, 2), mean_cost_ref: round(costRef, 2), incremental_cost: round(dCost, 2),
          relative_cost_difference: round(dCost / costRef, 4),
          mortality: mortAlt === null ? null : round(mortAlt), mortality_ref: mortRef === null ? null : round(mortRef),
          deaths_averted_per_100: dEffect === null ? null : round(dEffect * 100, 2),
          icer_per_death_averted: icer === null ? null : round(icer, 0),
          dominance,
          mean_los_days: losAlt === null ? null : round(losAlt, 2), mean_los_days_ref: losRef === null ? null : round(losRef, 2),
          bed_days_difference_per_patient: losAlt !== null && losRef !== null ? round(losAlt - losRef, 2) : null,
          // Annualised hospital budget impact if the reference arm's patients were managed like this arm.
          annual_budget_impact: periods.length ? round((dCost * ref.cases * 12) / periods.length, 0) : null,
          uncertainty_note: "Mean costs come from aggregate sums; their variance and case-mix are not estimable without patient-level data.",
        });
      }
    }
  }

  // ---- Between-department variation for the same condition ---------------------------
  const variation: Record<string, unknown>[] = [];
  for (const c of conditions) {
    const depts = c.departments.filter((d) => d.cases >= cfg.min_cases);
    if (depts.length < 2) continue;
    for (const o of OUTCOMES) {
      const key = OUTCOME_KEY[o];
      const g = depts.map((d) => d[key]).filter((x): x is NonNullable<Rate> => x !== null);
      if (g.length < 2) continue;
      const h = heterogeneity(g.map((x) => ({ k: x.events, n: x.n })));
      const rates = depts.filter((d) => d[key]).map((d) => ({ department: d.department, department_id: d.department_id, rate: d[key]!.rate, n: d[key]!.n }));
      const lo = rates.reduce((m, x) => (x.rate < m.rate ? x : m)), hi = rates.reduce((m, x) => (x.rate > m.rate ? x : m));
      const row: Record<string, unknown> = { condition_code: c.condition_code, condition_label: c.condition_label, outcome: o, outcome_label: OUTCOME_LABEL[o],
        departments: rates, lowest: lo, highest: hi, range: round(hi.rate - lo.rate), chi2: round(h.chi2, 3), df: h.df, p_value: round(h.p_value, 6), q_value: null };
      variation.push(row);
      tests.push({ kind: "department", p: h.p_value, set: (q) => { row.q_value = round(q, 6); } });
    }
  }

  // ---- Hospital parameters vs outcomes (department-month level) -----------------------
  const dm = new Map<string, Totals>();
  for (const r of caseRows) { const k = `${r.department_id}|${r.period}`; if (!dm.has(k)) dm.set(k, empty()); add(dm.get(k)!, r); }
  const parameters: Record<string, unknown>[] = [];
  const associations: Record<string, unknown>[] = [];
  for (const [code, rows] of group(paramRows, (r) => r.parameter_code)) {
    const values = rows.map((r) => Number(r.value));
    parameters.push({ parameter_code: code, parameter_label: rows[0].parameter_label, unit: rows[0].unit, points: rows.length,
      mean: round(values.reduce((s, v) => s + v, 0) / values.length, 3), min: round(Math.min(...values), 3), max: round(Math.max(...values), 3),
      departments: [...new Set(rows.map((r) => r.department))].sort() });
    const outcomeFns: [string, string, (t: Totals) => number | null][] = [
      ...OUTCOMES.map((o) => [o, OUTCOME_LABEL[o], (t: Totals) => (t[`${o}_n`] ? t[o] / t[`${o}_n`] : null)] as [string, string, (t: Totals) => number | null]),
      ["los", "mean length of stay", (t) => (t.los_n ? t.los / t.los_n : null)],
      ["cost", "mean cost per case", (t) => (t.cost_n ? t.cost / t.cost_n : null)],
    ];
    for (const [okey, olabel, fn] of outcomeFns) {
      // Within-department association: each department's values are centred
      // on its own mean, so differences in case-mix between departments
      // (e.g. ICU has more nurses and sicker patients) do not drive the result.
      const pts: { d: string; x: number; y: number }[] = [];
      for (const r of rows) {
        const t = dm.get(`${r.department_id}|${r.period}`);
        const v = t ? fn(t) : null;
        if (v !== null && t!.cases >= 5) pts.push({ d: r.department_id, x: Number(r.value), y: v });
      }
      const means = new Map<string, { x: number; y: number; n: number }>();
      for (const p of pts) { const m = means.get(p.d) ?? { x: 0, y: 0, n: 0 }; m.x += p.x; m.y += p.y; m.n++; means.set(p.d, m); }
      const usable = pts.filter((p) => means.get(p.d)!.n >= 3);
      const x = usable.map((p) => p.x - means.get(p.d)!.x / means.get(p.d)!.n);
      const y = usable.map((p) => p.y - means.get(p.d)!.y / means.get(p.d)!.n);
      if (x.length < cfg.min_points) continue;
      const s = spearman(x, y);
      const row: Record<string, unknown> = { parameter_code: code, parameter_label: rows[0].parameter_label, unit: rows[0].unit,
        outcome: okey, outcome_label: olabel, points: s.n, method: "Spearman, within-department (centred on department means)", rho: round(s.rho, 3), low: round(s.low, 3), high: round(s.high, 3),
        p_value: round(s.p_value, 6), q_value: null };
      associations.push(row);
      tests.push({ kind: "parameter", p: s.p_value, set: (q) => { row.q_value = round(q, 6); } });
    }
  }
  for (const c of conditions) if (c.trend) {
    const tr = c.trend as Record<string, unknown> & { p_value: number };
    tr.q_value = null;
    tests.push({ kind: "trend", p: tr.p_value, set: (q) => { tr.q_value = round(q, 6); } });
  }
  // One false-discovery correction across every test in the run.
  benjaminiHochberg(tests.map((t) => t.p)).forEach((q, i) => tests[i].set(q));

  // ---- Portfolio coverage of high-burden conditions ------------------------------------
  const covered = (code: string) => portfolio.filter((p) => p.condition_codes.some((pc) => pc.slice(0, 3) === code.slice(0, 3)));
  const coverage = conditions.map((c) => ({
    condition_code: c.condition_code, condition_label: c.condition_label, cases: c.cases, share: c.share,
    high_burden: c.share >= cfg.high_burden_share,
    portfolio: covered(c.condition_code).map((p) => ({ kind: p.kind, title: p.title, status: p.status })),
  }));

  // ---- Completeness --------------------------------------------------------------
  const expectedCells = departments.size * periods.length;
  const observed = new Set(caseRows.map((r) => `${r.department_id}|${r.period}`));
  const missingMonths = [...departments.entries()].flatMap(([id, name]) => periods.filter((p) => !observed.has(`${id}|${p}`)).map((p) => ({ department: name, period: p })));
  const cells = caseRows.length || 1;
  const fieldCompleteness = Object.fromEntries((["deaths", "readmissions_30d", "complications", "los_days_sum", "cost_sum"] as const)
    .map((f) => [f, round(caseRows.filter((r) => r[f] !== null).length / cells, 4)]));

  const strip = <T extends { _t?: unknown }>(x: T) => { const { _t, ...rest } = x; return rest; };
  return {
    engine_version: ENGINE_VERSION,
    config: cfg,
    summary: {
      periods, departments: [...departments.values()].sort(), total_cases: total.cases, conditions: conditions.length,
      managements: managementProfiles.length, parameter_points: paramRows.length, tests: tests.length, ...profile(total),
    },
    conditions,
    management_outcomes: managementProfiles.map(strip).sort((a, b) => a.condition_code.localeCompare(b.condition_code) || b.cases - a.cases),
    comparisons, economics, variation, parameters, associations, coverage,
    completeness: { expected_department_months: expectedCells, observed_department_months: observed.size, missing_months: missingMonths, field_completeness: fieldCompleteness },
  };
}
export type AnalysisResult = ReturnType<typeof analyze>;
