// Hypothesis generation on the discovery split, analysis-plan templates and
// the deterministic interpretation template. Hypotheses found on the
// discovery rows are tested on the held-out validation rows only.
import { benjaminiHochberg, compareProportions, round } from "../analytics/stats.ts";
import { welch } from "../stats/models.ts";
import type { CleanRow } from "./data.ts";
import type { Plan, StudyResult } from "../stats/study.ts";

export type Variable = { name: string; label: string; role: string; type: "number" | "category" | "binary" | "date" };
export type Hypothesis = {
  key: string; kind: "comparative" | "economic" | "burden";
  study_category: "clinical_effectiveness" | "health_economics" | "epidemiology";
  title: string; statement: string;
  variables: { exposure?: string; treated?: string; reference?: string; outcome?: string; outcome_type?: "binary" | "continuous"; cost?: string; diagnosis?: string; diagnosis_value?: string };
  screening: Record<string, unknown>;
  priority: number;
};

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const MIN_GROUP = 20;

export function screen(rows: CleanRow[], vars: Variable[], opts: { currency: string; alpha?: number } = { currency: "EGP" }): Hypothesis[] {
  const alpha = opts.alpha ?? 0.1;
  const disc = rows.filter((r) => r.__split === "discovery");
  const exposures = vars.filter((v) => v.role === "exposure" && (v.type === "category" || v.type === "binary"));
  const binOut = vars.filter((v) => v.role === "outcome" && v.type === "binary");
  const contOut = vars.filter((v) => (v.role === "los" || v.role === "cost" || (v.role === "outcome" && v.type === "number")));
  const cost = vars.find((v) => v.role === "cost");
  const diag = vars.find((v) => v.role === "diagnosis" && v.type === "category");
  const out: Hypothesis[] = [];
  type Test = { p: number; h: Hypothesis; effect: number; share: number };
  const tests: Test[] = [];

  // Strata: each common diagnosis (treatments are condition-specific), or everyone.
  const strata: { value: string | null; rows: CleanRow[] }[] = [];
  if (diag) {
    const counts = new Map<string, number>(); disc.forEach((r) => { const d = r[diag.name]; if (typeof d === "string") counts.set(d, (counts.get(d) ?? 0) + 1); });
    for (const [value, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) if (n >= 3 * MIN_GROUP) strata.push({ value, rows: disc.filter((r) => r[diag.name] === value) });
    // Burden: how common each diagnosis is, how it is managed and its outcomes (descriptive epidemiology).
    const total = rows.length;
    for (const [value, n] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      const all = rows.filter((r) => r[diag.name] === value);
      const share = all.length / total;
      const outcomes = binOut.map((o) => { const v = all.map((r) => r[o.name]).filter((x) => x !== null) as number[]; return v.length ? `${o.label} ${pct(v.filter(Boolean).length / v.length)}` : null; }).filter(Boolean);
      const mgmt = exposures[0] ? [...new Set(all.map((r) => r[exposures[0].name]).filter((x) => x !== null))].length : 0;
      out.push({ key: `burden:${value}`, kind: "burden", study_category: "epidemiology", title: `Burden, management and outcomes of ${value}`,
        statement: `${value} accounts for ${pct(share)} of the ${total} patients in this dataset (${all.length} patients)${outcomes.length ? `, with ${outcomes.join(", ")}` : ""}${mgmt ? `, managed in ${mgmt} different ways` : ""}. A descriptive study of its prevalence, management patterns and outcomes would establish the local baseline.`,
        variables: { diagnosis: diag.name, diagnosis_value: value }, screening: { patients: all.length, share: round(share, 4) }, priority: Math.round(100 * Math.min(1, share / 0.25) * 0.6 * 10) / 10 });
    }
  }
  if (!strata.length) strata.push({ value: null, rows: disc });

  for (const s of strata) for (const ex of exposures) {
    const counts = new Map<string, number>(); s.rows.forEach((r) => { const v = r[ex.name]; if (v !== null) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1); });
    const levels = [...counts.entries()].filter(([, n]) => n >= MIN_GROUP).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (levels.length < 2) continue;
    const ref = levels[0][0];
    const where = s.value ? ` among patients with ${s.value}` : "";
    const share = s.rows.length / disc.length;
    for (const [lv] of levels.slice(1)) {
      const A = s.rows.filter((r) => String(r[ex.name]) === lv), B = s.rows.filter((r) => String(r[ex.name]) === ref);
      for (const o of binOut) {
        const a = A.map((r) => r[o.name]).filter((x) => x !== null) as number[], b = B.map((r) => r[o.name]).filter((x) => x !== null) as number[];
        if (a.length < MIN_GROUP || b.length < MIN_GROUP) continue;
        const ka = a.filter(Boolean).length, kb = b.filter(Boolean).length;
        if (ka + kb < 5) continue;
        const c = compareProportions(ka, a.length, kb, b.length);
        tests.push({ p: c.p_value, effect: Math.abs(c.rd) / 0.1, share, h: { key: `cmp:${s.value ?? "all"}:${ex.name}:${lv}:${ref}:${o.name}`, kind: "comparative", study_category: "clinical_effectiveness",
          title: `${o.label} with ${lv} vs ${ref}${where}`,
          statement: `In the discovery half of the data${where}, ${o.label.toLowerCase()} was ${pct(c.p1)} (${ka}/${a.length}) with ${lv} versus ${pct(c.p2)} (${kb}/${b.length}) with ${ref} (crude risk difference ${(c.rd * 100).toFixed(1)} points). Hypothesis: after adjustment for baseline differences, ${lv} is associated with a different risk of ${o.label.toLowerCase()} than ${ref}. To be tested on the held-out validation half.`,
          variables: { exposure: ex.name, treated: lv, reference: ref, outcome: o.name, outcome_type: "binary", ...(s.value && diag ? { diagnosis: diag.name, diagnosis_value: s.value } : {}) },
          screening: { split: "discovery", n_treated: a.length, n_reference: b.length, events_treated: ka, events_reference: kb, risk_treated: round(c.p1, 4), risk_reference: round(c.p2, 4), risk_difference: round(c.rd, 4), p_value: round(c.p_value, 6) }, priority: 0 } });
      }
      for (const o of contOut) {
        const a = A.map((r) => r[o.name]).filter((x) => typeof x === "number") as number[], b = B.map((r) => r[o.name]).filter((x) => typeof x === "number") as number[];
        if (a.length < MIN_GROUP || b.length < MIN_GROUP) continue;
        const w = welch(a, b), mb = b.reduce((x, y) => x + y, 0) / b.length;
        const isCost = o.role === "cost";
        const unit = isCost ? ` ${opts.currency}` : o.role === "los" ? " days" : "";
        tests.push({ p: w.p_value, effect: Math.abs(w.difference / (mb || 1)) / 0.2, share, h: { key: `cmp:${s.value ?? "all"}:${ex.name}:${lv}:${ref}:${o.name}`, kind: "comparative", study_category: isCost ? "health_economics" : "clinical_effectiveness",
          title: `${o.label} with ${lv} vs ${ref}${where}`,
          statement: `In the discovery half of the data${where}, mean ${o.label.toLowerCase()} was ${round(w.difference + mb, 2)}${unit} with ${lv} versus ${round(mb, 2)}${unit} with ${ref} (difference ${round(w.difference, 2)}${unit}). Hypothesis: the difference persists after adjustment for baseline differences. To be tested on the held-out validation half.`,
          variables: { exposure: ex.name, treated: lv, reference: ref, outcome: o.name, outcome_type: "continuous", ...(s.value && diag ? { diagnosis: diag.name, diagnosis_value: s.value } : {}) },
          screening: { split: "discovery", n_treated: a.length, n_reference: b.length, mean_treated: round(w.difference + mb, 2), mean_reference: round(mb, 2), difference: round(w.difference, 2), p_value: round(w.p_value, 6) }, priority: 0 } });
      }
      // Cost-effectiveness: material cost difference and a binary outcome to value it against.
      if (cost && binOut.length) {
        const o = binOut[0];
        const ok = (r: CleanRow) => typeof r[cost.name] === "number" && r[o.name] !== null;
        const a = A.filter(ok), b = B.filter(ok);
        if (a.length >= MIN_GROUP && b.length >= MIN_GROUP) {
          const mean = (g: CleanRow[]) => g.reduce((x, r) => x + (r[cost.name] as number), 0) / g.length;
          const ca = mean(a), cb = mean(b);
          // Frame the more costly option as the intervention, so the ICER is its cost per event avoided.
          if (Math.abs(ca - cb) / Math.min(ca, cb) >= 0.1) {
            out.push(ca >= cb ? economic(ex.name, lv, ref, a, b, cost.name, o, s.value, diag?.name, where, share, opts.currency)
              : economic(ex.name, ref, lv, b, a, cost.name, o, s.value, diag?.name, where, share, opts.currency));
          }
        }
      }
    }
  }
  return finish(tests, out, alpha);
}

function economic(exposure: string, treated: string, reference: string, a: CleanRow[], b: CleanRow[], costVar: string, o: Variable, diagValue: string | null,
  diagName: string | undefined, where: string, share: number, currency: string): Hypothesis {
  const ca = a.reduce((x, r) => x + (r[costVar] as number), 0) / a.length, cb = b.reduce((x, r) => x + (r[costVar] as number), 0) / b.length;
  const ea = a.filter((r) => r[o.name]).length / a.length, eb = b.filter((r) => r[o.name]).length / b.length;
  const dc = ca - cb;
  return { key: `econ:${diagValue ?? "all"}:${exposure}:${treated}:${reference}:${o.name}`, kind: "economic", study_category: "health_economics",
    title: `Cost-effectiveness of ${treated} vs ${reference}${where}`,
    statement: `In the discovery half${where}, ${treated} cost ${round(ca, 0)} ${currency} per patient versus ${round(cb, 0)} ${currency} with ${reference} (difference ${round(dc, 0)} ${currency}), with ${o.label.toLowerCase()} ${pct(ea)} versus ${pct(eb)}. Hypothesis: the incremental cost of ${treated} per ${o.label.toLowerCase()} event avoided can be estimated with acceptable uncertainty, to inform which option offers value. To be tested on the validation half with bootstrapped uncertainty.`,
    variables: { exposure, treated, reference, outcome: o.name, outcome_type: "binary", cost: costVar, ...(diagValue && diagName ? { diagnosis: diagName, diagnosis_value: diagValue } : {}) },
    screening: { split: "discovery", n_treated: a.length, n_reference: b.length, mean_cost_treated: round(ca, 2), mean_cost_reference: round(cb, 2), event_rate_treated: round(ea, 4), event_rate_reference: round(eb, 4) },
    priority: Math.round(1000 * (0.4 * Math.min(1, share / 0.25) + 0.6 * Math.min(1, Math.abs(dc / cb) / 0.3))) / 10 };
}

function finish(tests: { p: number; h: Hypothesis; effect: number; share: number }[], out: Hypothesis[], alpha: number): Hypothesis[] {
  const q = benjaminiHochberg(tests.map((t) => t.p));
  tests.forEach((t, i) => {
    if (q[i] >= alpha) return;
    t.h.screening.q_value = round(q[i], 6);
    const evidence = q[i] < 0.001 ? 1 : q[i] < 0.01 ? 0.85 : 0.7;
    t.h.priority = Math.round(1000 * (0.4 * Math.min(1, t.share / 0.25) + 0.35 * Math.min(1, t.effect) + 0.25 * evidence)) / 10;
    out.push(t.h);
  });
  return out.sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key));
}

/** Analysis plan template for a hypothesis. People edit it before locking. */
export function templatePlan(h: Hypothesis, vars: Variable[]): Plan | null {
  const v = h.variables;
  if (h.kind === "burden" || !v.exposure || !v.outcome || v.treated === undefined || v.reference === undefined) return null;
  const outcome = vars.find((x) => x.name === v.outcome)!;
  const covariates = vars.filter((x) => (x.role === "age" || x.role === "sex" || x.role === "covariate") && x.type !== "date" && x.name !== v.exposure).slice(0, 10).map((x) => x.name);
  const isCost = outcome.role === "cost";
  return {
    title: h.title,
    population: { description: v.diagnosis_value ? `Patients with ${v.diagnosis_value} managed with ${v.treated} or ${v.reference}` : `Patients managed with ${v.treated} or ${v.reference}`,
      filters: v.diagnosis && v.diagnosis_value ? [{ variable: v.diagnosis, op: "eq", value: v.diagnosis_value }] : [] },
    exposure: { variable: v.exposure, treated: v.treated, reference: v.reference },
    outcome: { variable: v.outcome, type: v.outcome_type === "binary" ? "binary" : "continuous", log_transform: isCost },
    covariates,
    method: h.kind === "economic" ? "iptw" : "regression",
    ...(h.kind === "economic" && v.cost ? { economics: { cost_variable: v.cost, effect_variable: v.outcome, effect_label: `event avoided (${outcome.label})`, wtp_thresholds: [], bootstrap: 1000 } } : {}),
    split: "validation", alpha: 0.05,
  };
}

const MEASURE: Record<string, string> = { adjusted_odds_ratio: "adjusted odds ratio", odds_ratio_iptw: "propensity-weighted odds ratio", adjusted_mean_difference: "adjusted mean difference", ratio_of_geometric_means: "adjusted ratio of geometric means", adjusted_hazard_ratio: "adjusted hazard ratio" };
const fmt = (x: number) => (Math.abs(x) >= 100 ? Math.round(x).toLocaleString("en-US") : String(x));
/** Deterministic interpretation of a result; the default and the fallback for the agent. */
export function templateInterpretation(plan: Plan, r: StudyResult, vars: Variable[] = []): string {
  const p = r.primary, pop = r.population;
  const outcomeLabel = (vars.find((v) => v.name === plan.outcome.variable)?.label ?? plan.outcome.variable.replaceAll("_", " ")).toLowerCase();
  const measure = MEASURE[p.measure] ?? p.measure.replaceAll("_", " ");
  const lines = [
    `In the held-out ${r.split === "validation" ? "validation" : "full"} data (${pop.included} patients: ${pop.treated} ${pop.treated_label}, ${pop.reference} ${pop.reference_label}), the ${measure} for ${outcomeLabel} with ${pop.treated_label} versus ${pop.reference_label} was ${p.estimate} (95% CI ${p.low} to ${p.high}; p ${p.p_value < 0.001 ? "< 0.001" : `= ${p.p_value.toFixed(3)}`}).`,
    r.significant ? `This is statistically significant at the pre-specified ${plan.alpha} level, so the hypothesis from the discovery data is supported in independent data.` : `This is not statistically significant at the pre-specified ${plan.alpha} level; the discovery signal was not confirmed.`,
  ];
  if (r.economics) {
    const e = r.economics as Record<string, any>;
    lines.push(`Economic evaluation (${e.perspective} perspective, ${e.currency}): incremental cost ${fmt(e.incremental_cost)} (95% CI ${fmt(e.incremental_cost_low)} to ${fmt(e.incremental_cost_high)}) and incremental effect ${e.incremental_effect} ${e.effect_label.replace("event avoided", "events avoided")} per patient, classed as ${String(e.dominance).replaceAll("_", " ")}${e.icer !== null ? `, ICER ${fmt(e.icer)} ${e.currency} per ${e.effect_label}` : ""}.`);
  }
  lines.push(`Limitations: observational data from one hospital; residual confounding by unmeasured severity is possible${r.warnings.length ? `; ${r.warnings.join("; ")}` : ""}.`);
  return lines.join(" ");
}
