// Runs a locked analysis plan on cleaned patient-level rows: Table 1 with
// standardised differences, crude and adjusted effects (logistic, linear,
// log-linear or Cox regression, or inverse-probability weighting), and an
// optional cost-effectiveness analysis with a seeded bootstrap.
// Deterministic: the same rows and plan give the same result.
import { z } from "zod";
import { compareProportions, round } from "../analytics/stats.ts";
import { cox, iptw, kmMedian, linear, logistic, logRank, predictLogistic, prng, smd, SingularError, welch, wstats } from "./models.ts";
import type { Fit, Matrix } from "./models.ts";

export type Value = number | string | null;
export type Row = Record<string, Value>;
export type VarInfo = { name: string; label: string; type: "number" | "category" | "binary" | "date" | "text" };

const name = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
export const planSchema = z.object({
  title: z.string().trim().min(1).max(300),
  population: z.object({
    description: z.string().max(2000).default(""),
    filters: z.array(z.object({ variable: name, op: z.enum(["eq", "in", "gte", "lte", "not_missing"]), value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]).optional() }).strict()).max(20).default([]),
  }).strict(),
  exposure: z.object({ variable: name, treated: z.union([z.string(), z.number()]), reference: z.union([z.string(), z.number()]) }).strict(),
  outcome: z.object({ variable: name, type: z.enum(["binary", "continuous", "time_to_event"]), event_variable: name.optional(), log_transform: z.boolean().default(false) }).strict()
    .refine((o) => o.type !== "time_to_event" || o.event_variable, { message: "time_to_event needs event_variable" }),
  covariates: z.array(name).max(30).default([]),
  method: z.enum(["regression", "iptw"]).default("regression"),
  economics: z.object({
    cost_variable: name, effect_variable: name, effect_label: z.string().max(200).default("event avoided"),
    wtp_thresholds: z.array(z.number().positive()).max(10).default([]), bootstrap: z.number().int().min(200).max(5000).default(1000),
  }).strict().optional(),
  split: z.enum(["validation", "all"]).default("validation"),
  alpha: z.number().min(0.001).max(0.2).default(0.05),
}).strict();
export type Plan = z.infer<typeof planSchema>;

export class PlanError extends Error {}

const isNum = (v: Value): v is number => typeof v === "number" && Number.isFinite(v);
const r4 = (v: number) => round(v, 4), r2 = (v: number) => round(v, 2);

function applyFilters(rows: Row[], plan: Plan): { kept: Row[]; excluded: Record<string, number> } {
  const excluded: Record<string, number> = {};
  const kept = rows.filter((r) => {
    for (const f of plan.population.filters) {
      const v = r[f.variable];
      const ok = f.op === "not_missing" ? v !== null && v !== undefined
        : f.op === "eq" ? v === f.value
        : f.op === "in" ? Array.isArray(f.value) && (f.value as Value[]).includes(v)
        : f.op === "gte" ? isNum(v) && v >= Number(f.value) : isNum(v) && v <= Number(f.value);
      if (!ok) { const k = `filter: ${f.variable} ${f.op} ${Array.isArray(f.value) ? f.value.join("|") : f.value ?? ""}`.trim(); excluded[k] = (excluded[k] ?? 0) + 1; return false; }
    }
    return true;
  });
  return { kept, excluded };
}

/** Design matrix: numeric covariates as-is, categories as indicators (reference = most frequent level). */
function design(rows: Row[], covariates: string[], vars: Map<string, VarInfo>) {
  const cols: { term: string; get: (r: Row) => number }[] = [];
  for (const c of covariates) {
    const info = vars.get(c)!;
    if (info.type === "number" || info.type === "binary") { cols.push({ term: c, get: (r) => Number(r[c]) }); continue; }
    const counts = new Map<string, number>();
    rows.forEach((r) => counts.set(String(r[c]), (counts.get(String(r[c])) ?? 0) + 1));
    const levels = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map((e) => e[0]);
    for (const lv of levels.slice(1)) cols.push({ term: `${c}[${lv}]`, get: (r) => (String(r[c]) === lv ? 1 : 0) });
  }
  return cols;
}

export function runPlan(allRows: Row[], vars: VarInfo[], plan: Plan, opts: { seed: number; currency: string }) {
  const V = new Map(vars.map((v) => [v.name, v]));
  const used = [plan.exposure.variable, plan.outcome.variable, ...(plan.outcome.event_variable ? [plan.outcome.event_variable] : []), ...plan.covariates,
    ...(plan.economics ? [plan.economics.cost_variable, plan.economics.effect_variable] : []), ...plan.population.filters.map((f) => f.variable)];
  const unknown = [...new Set(used)].filter((u) => !V.has(u));
  if (unknown.length) throw new PlanError(`Unknown variables: ${unknown.join(", ")}`);
  if (plan.covariates.includes(plan.exposure.variable)) throw new PlanError("The exposure cannot also be a covariate");
  const outInfo = V.get(plan.outcome.variable)!;
  if (plan.outcome.type === "binary" && outInfo.type !== "binary") throw new PlanError(`${plan.outcome.variable} is not a binary variable`);
  if (plan.outcome.type !== "binary" && outInfo.type !== "number") throw new PlanError(`${plan.outcome.variable} is not numeric`);
  const warnings: string[] = [];

  // Population: split, filters, exposure levels, complete cases.
  const pool = plan.split === "validation" ? allRows.filter((r) => r.__split === "validation") : allRows;
  const { kept, excluded } = applyFilters(pool, plan);
  const exp = plan.exposure.variable, T = String(plan.exposure.treated), R = String(plan.exposure.reference);
  let rows = kept.filter((r) => { const ok = String(r[exp]) === T || String(r[exp]) === R; if (!ok) excluded[`exposure not ${T} or ${R}`] = (excluded[`exposure not ${T} or ${R}`] ?? 0) + 1; return ok; });
  const needed = [plan.outcome.variable, ...(plan.outcome.event_variable ? [plan.outcome.event_variable] : []), ...plan.covariates, ...(plan.economics ? [plan.economics.cost_variable, plan.economics.effect_variable] : [])];
  rows = rows.filter((r) => { const miss = needed.find((v) => r[v] === null || r[v] === undefined || (V.get(v)!.type !== "category" && !isNum(r[v]))); if (miss) excluded[`missing ${miss}`] = (excluded[`missing ${miss}`] ?? 0) + 1; return !miss; });
  if (plan.outcome.log_transform) rows = rows.filter((r) => { const ok = (r[plan.outcome.variable] as number) > 0; if (!ok) excluded["outcome ≤ 0 (log scale)"] = (excluded["outcome ≤ 0 (log scale)"] ?? 0) + 1; return ok; });
  const t = rows.map((r) => (String(r[exp]) === T ? 1 : 0));
  const nT = t.filter(Boolean).length, nR = t.length - nT;
  if (nT < 10 || nR < 10) throw new PlanError(`Too few patients after exclusions (${T}: ${nT}, ${R}: ${nR}); at least 10 per group are needed`);
  const y = rows.map((r) => Number(r[plan.outcome.variable]));

  // Covariate design; drop indicator columns with no variation.
  const cols = design(rows, plan.covariates, V).filter((c) => { const vals = new Set(rows.map(c.get)); if (vals.size < 2) { warnings.push(`${c.term} has no variation and was dropped`); return false; } return true; });
  const Xcov: Matrix = rows.map((r) => cols.map((c) => c.get(r)));

  // ---- Table 1 ----------------------------------------------------------------
  const tg = rows.filter((_, i) => t[i]), rg = rows.filter((_, i) => !t[i]);
  const table1: Record<string, unknown>[] = [];
  for (const c of plan.covariates) {
    const info = V.get(c)!;
    if (info.type === "category") {
      const levels = [...new Set(rows.map((r) => String(r[c])))].sort();
      for (const lv of levels) {
        const a: number[] = tg.map((r) => (String(r[c]) === lv ? 1 : 0)), b: number[] = rg.map((r) => (String(r[c]) === lv ? 1 : 0));
        table1.push({ variable: info.label, level: lv, treated: `${a.reduce((s, x) => s + x, 0)} (${(100 * wstats(a).mean).toFixed(1)}%)`, reference: `${b.reduce((s, x) => s + x, 0)} (${(100 * wstats(b).mean).toFixed(1)}%)`, smd: r2(smd(a, b)) });
      }
    } else {
      const a = tg.map((r) => Number(r[c])), b = rg.map((r) => Number(r[c]));
      const fa = wstats(a), fb = wstats(b);
      table1.push({ variable: info.label, level: info.type === "binary" ? "yes" : null, treated: info.type === "binary" ? `${a.filter(Boolean).length} (${(100 * fa.mean).toFixed(1)}%)` : `${fa.mean.toFixed(1)} (SD ${fa.sd.toFixed(1)})`,
        reference: info.type === "binary" ? `${b.filter(Boolean).length} (${(100 * fb.mean).toFixed(1)}%)` : `${fb.mean.toFixed(1)} (SD ${fb.sd.toFixed(1)})`, smd: r2(smd(a, b)) });
    }
  }

  // ---- Weights (IPTW) ------------------------------------------------------------
  let weights: number[] | undefined;
  let balance: { term: string; smd_before: number; smd_after: number }[] | undefined;
  let propensity: Record<string, number> | undefined;
  if (plan.method === "iptw") {
    if (!cols.length) throw new PlanError("Inverse-probability weighting needs at least one covariate");
    const Xps = Xcov.map((x) => [1, ...x]);
    const ps = predictLogistic(Xps, logistic(Xps, t, ["const", ...cols.map((c) => c.term)]));
    weights = iptw(ps, t);
    const ess = weights.reduce((s, w) => s + w, 0) ** 2 / weights.reduce((s, w) => s + w * w, 0);
    propensity = { min: r4(Math.min(...ps)), max: r4(Math.max(...ps)), effective_sample_size: r2(ess), max_weight: r2(Math.max(...weights)) };
    balance = cols.map((c, j) => {
      const a = Xcov.filter((_, i) => t[i]).map((x) => x[j]), b = Xcov.filter((_, i) => !t[i]).map((x) => x[j]);
      return { term: c.term, smd_before: r2(smd(a, b)), smd_after: r2(smd(a, b, weights!.filter((_, i) => t[i]), weights!.filter((_, i) => !t[i]))) };
    });
    if (balance.some((b) => Math.abs(b.smd_after) > 0.1)) warnings.push("Some covariates remain imbalanced after weighting (|SMD| > 0.1)");
  }

  // ---- Crude and adjusted effects -------------------------------------------------
  const X = rows.map((_, i) => [1, t[i], ...(plan.method === "iptw" ? [] : Xcov[i])]);
  const names = ["const", "exposure", ...(plan.method === "iptw" ? [] : cols.map((c) => c.term))];
  const ci = (c: { estimate: number; low: number; high: number; p_value: number }, f: (v: number) => number) => ({ estimate: r4(f(c.estimate)), low: r4(f(c.low)), high: r4(f(c.high)), p_value: round(c.p_value, 6) });
  let crude: Record<string, unknown>, primary: { measure: string; estimate: number; low: number; high: number; p_value: number }, model: Fit;
  try {
    if (plan.outcome.type === "binary") {
      const kT = y.filter((v, i) => t[i] && v).length, kR = y.filter((v, i) => !t[i] && v).length;
      const cp = compareProportions(kT, nT, kR, nR);
      // Totals too, so a report or the agent can quote them without adding up the groups.
      crude = { events_treated: kT, n_treated: nT, risk_treated: r4(cp.p1), events_reference: kR, n_reference: nR, risk_reference: r4(cp.p2), events_total: kT + kR, n_total: nT + nR, risk_total: r4((kT + kR) / (nT + nR)),
        risk_difference: r4(cp.rd), rd_low: r4(cp.rd_low), rd_high: r4(cp.rd_high), risk_ratio: r4(cp.rr), rr_low: r4(cp.rr_low), rr_high: r4(cp.rr_high), p_value: round(cp.p_value, 6) };
      model = logistic(X, y, names, { weights, robust: plan.method === "iptw" });
      primary = { measure: plan.method === "iptw" ? "odds_ratio_iptw" : "adjusted_odds_ratio", ...ci(model.coefficients[1], Math.exp) };
      if (!model.converged) warnings.push("The logistic model did not converge; check for separation");
    } else if (plan.outcome.type === "continuous") {
      const yy = plan.outcome.log_transform ? y.map(Math.log) : y;
      const w = welch(y.filter((_, i) => t[i]), y.filter((_, i) => !t[i]));
      crude = { mean_treated: r2(wstats(y.filter((_, i) => t[i])).mean), mean_reference: r2(wstats(y.filter((_, i) => !t[i])).mean), n_treated: nT, n_reference: nR, n_total: nT + nR,
        mean_difference: r2(w.difference), low: r2(w.low), high: r2(w.high), p_value: round(w.p_value, 6) };
      model = linear(X, yy, names, { weights, robust: plan.method === "iptw" });
      primary = plan.outcome.log_transform ? { measure: "ratio_of_geometric_means", ...ci(model.coefficients[1], Math.exp) } : { measure: "adjusted_mean_difference", ...ci(model.coefficients[1], (v) => v) };
    } else {
      const ev = rows.map((r) => Number(r[plan.outcome.event_variable!]));
      const lr = logRank(y, ev, t);
      crude = { events_treated: ev.filter((e, i) => e && t[i]).length, n_treated: nT, events_reference: ev.filter((e, i) => e && !t[i]).length, n_reference: nR,
        events_total: ev.filter((e) => e).length, n_total: nT + nR,
        median_treated: kmMedian(y.filter((_, i) => t[i]), ev.filter((_, i) => t[i])), median_reference: kmMedian(y.filter((_, i) => !t[i]), ev.filter((_, i) => !t[i])),
        logrank_chi2: r4(lr.chi2), p_value: round(lr.p_value, 6) };
      if (plan.method === "iptw") throw new PlanError("Inverse-probability weighting is not available for time-to-event outcomes yet; use regression adjustment");
      model = cox(X.map((x) => x.slice(1)), y, ev, names.slice(1));
      primary = { measure: "adjusted_hazard_ratio", ...ci(model.coefficients[0], Math.exp) };
    }
  } catch (e) {
    if (e instanceof SingularError) throw new PlanError(e.message);
    throw e;
  }
  const coefficients = model.coefficients.map((c) => ({ term: c.term, estimate: r4(c.estimate), se: r4(c.se), low: r4(c.low), high: r4(c.high), p_value: round(c.p_value, 6) }));

  // ---- Cost-effectiveness -----------------------------------------------------------
  let economics: Record<string, unknown> | undefined;
  if (plan.economics) {
    const e = plan.economics, cost = rows.map((r) => Number(r[e.cost_variable])), bad = rows.map((r) => Number(r[e.effect_variable]));
    const w = weights ?? rows.map(() => 1);
    const arm = (flag: number, idx?: number[]) => {
      const ii = (idx ?? rows.map((_, i) => i)).filter((i) => t[i] === flag);
      const sw = ii.reduce((s, i) => s + w[i], 0);
      return { cost: ii.reduce((s, i) => s + w[i] * cost[i], 0) / sw, effect: 1 - ii.reduce((s, i) => s + w[i] * bad[i], 0) / sw };
    };
    const a1 = arm(1), a0 = arm(0), dc = a1.cost - a0.cost, de = a1.effect - a0.effect;
    const rnd = prng(opts.seed);
    const iT = rows.map((_, i) => i).filter((i) => t[i]), iR = rows.map((_, i) => i).filter((i) => !t[i]);
    const boots: { dc: number; de: number }[] = [];
    for (let b = 0; b < e.bootstrap; b++) {
      const idx = [...iT.map(() => iT[Math.floor(rnd() * iT.length)]), ...iR.map(() => iR[Math.floor(rnd() * iR.length)])];
      const b1 = arm(1, idx), b0 = arm(0, idx);
      boots.push({ dc: b1.cost - b0.cost, de: b1.effect - b0.effect });
    }
    const pct = (v: number[], p: number) => { const s = [...v].sort((x, y2) => x - y2); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };
    const quad = { more_costly_more_effective: 0, less_costly_more_effective: 0, more_costly_less_effective: 0, less_costly_less_effective: 0 };
    for (const b of boots) quad[`${b.dc >= 0 ? "more" : "less"}_costly_${b.de >= 0 ? "more" : "less"}_effective` as keyof typeof quad]++;
    // Without hospital thresholds, show the curve over multiples of the reference arm's mean cost.
    const thresholds = e.wtp_thresholds.length ? e.wtp_thresholds : [0.5, 1, 2, 5, 10, 20, 50].map((k) => Math.round(k * a0.cost));
    const dominance = dc <= 0 && de >= 0 ? "dominant" : dc >= 0 && de <= 0 ? "dominated" : dc > 0 ? "more_costly_more_effective" : "less_costly_less_effective";
    economics = {
      perspective: "hospital", currency: opts.currency, effect_label: e.effect_label, weighted: Boolean(weights),
      mean_cost_treated: r2(a1.cost), mean_cost_reference: r2(a0.cost), effect_treated: r4(a1.effect), effect_reference: r4(a0.effect),
      incremental_cost: r2(dc), incremental_cost_low: r2(pct(boots.map((b) => b.dc), 0.025)), incremental_cost_high: r2(pct(boots.map((b) => b.dc), 0.975)),
      incremental_effect: r4(de), incremental_effect_low: r4(pct(boots.map((b) => b.de), 0.025)), incremental_effect_high: r4(pct(boots.map((b) => b.de), 0.975)),
      icer: dominance === "more_costly_more_effective" || dominance === "less_costly_less_effective" ? r2(dc / de) : null,
      dominance, bootstrap_replicates: e.bootstrap,
      bootstrap_quadrants: Object.fromEntries(Object.entries(quad).map(([k, v]) => [k, r4(v / boots.length)])),
      ceac: thresholds.map((lambda) => ({ wtp: r2(lambda), probability_cost_effective: r4(boots.filter((b) => lambda * b.de - b.dc > 0).length / boots.length), net_monetary_benefit: r2(lambda * de - dc) })),
      note: weights ? "Arms are weighted by the propensity weights, held fixed across bootstrap replicates." : "Unadjusted arm means; confounding is not removed in this economic comparison.",
    };
  }

  const significant = primary.p_value < plan.alpha;
  return {
    plan_title: plan.title, split: plan.split, method: plan.method, alpha: plan.alpha,
    population: { included: rows.length, treated: nT, reference: nR, treated_label: T, reference_label: R, excluded },
    table1, crude, coefficients, primary, significant, balance, propensity, economics, warnings,
    model: { n: model.n, converged: model.converged, iterations: model.iterations, ...Object.fromEntries(Object.entries(model.extra).map(([k, v]) => [k, r4(v)])) },
  };
}
export type StudyResult = ReturnType<typeof runPlan>;
