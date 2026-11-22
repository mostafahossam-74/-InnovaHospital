// Research-gap detection: turns statistical signals in an analysis into
// candidate research gaps with a deterministic statement, the numbers behind
// it, a priority score and suggested study designs. Every number in a
// statement comes from the analysis result, so a reviewer can trace it.
import type { AnalysisResult } from "./engine.ts";

export type GapType = "management_outcome_variation" | "department_outcome_variation" | "parameter_outcome_association"
  | "cost_effectiveness" | "rising_burden" | "high_burden_unstudied" | "data_completeness";
export type StudyCategory = "clinical_effectiveness" | "health_economics" | "epidemiology" | "quality_improvement" | "operational";

export type GapCandidate = {
  gap_key: string; gap_type: GapType; study_category: StudyCategory;
  title: string; statement: string;
  condition_code: string | null; condition_label: string | null; department_id: string | null;
  metrics: Record<string, unknown>;
  priority_score: number;
  suggested_designs: string[];
};

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const money = (v: number, cur: string) => `${cur} ${Math.round(v).toLocaleString("en-US")}`;
const clamp = (v: number) => Math.max(0, Math.min(1, v));

/** 0-100: burden (40%), size of effect (35%), strength of evidence (25%). */
export function priority(share: number, effect: number, q: number | null): number {
  const burden = clamp(share / 0.10);
  const evidence = q === null ? 0.4 : q < 0.001 ? 1 : q < 0.01 ? 0.85 : q < 0.05 ? 0.7 : 0.3;
  return Math.round(1000 * (0.4 * burden + 0.35 * clamp(effect) + 0.25 * evidence)) / 10;
}

export function detectGaps(a: AnalysisResult): GapCandidate[] {
  const out: GapCandidate[] = [];
  const alpha = a.config.alpha;
  const share = (code: string) => a.conditions.find((c) => c.condition_code === code)?.share ?? 0;
  const span = a.summary.periods.length ? `${a.summary.periods[0]} to ${a.summary.periods.at(-1)}` : "the study period";

  // 1. Outcomes differ between ways of managing the same condition.
  for (const c of a.comparisons as any[]) {
    if (c.q_value === null || c.q_value >= alpha) continue;
    const better = c.risk_difference < 0;
    out.push({
      gap_key: `mgmt:${c.condition_code}:${c.management}:${c.reference}:${c.outcome}`,
      gap_type: "management_outcome_variation", study_category: "clinical_effectiveness",
      title: `${c.outcome_label} after ${c.management} vs ${c.reference} in ${c.condition_label}`,
      statement: `From ${span}, ${c.condition_label} (${c.condition_code}) patients managed with ${c.management} had ${c.outcome_label} of ` +
        `${pct(c.rate)} (${c.events}/${c.n}) versus ${pct(c.rate_ref)} (${c.events_ref}/${c.n_ref}) with ${c.reference}: a risk difference of ` +
        `${(c.risk_difference * 100).toFixed(1)} percentage points (95% CI ${(c.rd_low * 100).toFixed(1)} to ${(c.rd_high * 100).toFixed(1)}; q = ${c.q_value.toFixed(4)}). ` +
        `The unadjusted difference ${better ? "favours" : "disfavours"} ${c.management}; whether it reflects the treatment or case-mix is unknown and needs a risk-adjusted comparative-effectiveness study.`,
      condition_code: c.condition_code, condition_label: c.condition_label, department_id: null,
      metrics: c, priority_score: priority(share(c.condition_code), Math.abs(c.risk_difference) / 0.10, c.q_value),
      suggested_designs: ["Retrospective cohort with propensity-score weighting", "Target-trial emulation", "Pragmatic randomised comparison if equipoise is confirmed"],
    });
  }

  // 2. Health economics: costs and effects of managements differ.
  for (const e of a.economics as any[]) {
    const material = Math.abs(e.relative_cost_difference) >= 0.10;
    if (!material || e.dominance === "effect_unknown") continue;
    const desc = e.dominance === "dominant" ? `was both cheaper (${money(e.incremental_cost, e.currency)} per patient) and associated with ${e.deaths_averted_per_100} fewer deaths per 100 patients`
      : e.dominance === "dominated" ? `cost ${money(e.incremental_cost, e.currency)} more per patient and was associated with ${Math.abs(e.deaths_averted_per_100)} more deaths per 100 patients`
      : e.dominance === "more_costly_more_effective" ? `cost ${money(e.incremental_cost, e.currency)} more per patient and was associated with ${e.deaths_averted_per_100} fewer deaths per 100 patients (crude ICER ${money(e.icer_per_death_averted, e.currency)} per death averted)`
      : `cost ${money(-e.incremental_cost, e.currency)} less per patient but was associated with ${Math.abs(e.deaths_averted_per_100)} more deaths per 100 patients`;
    out.push({
      gap_key: `econ:${e.condition_code}:${e.management}:${e.reference}`,
      gap_type: "cost_effectiveness", study_category: "health_economics",
      title: `Cost-effectiveness of ${e.management} vs ${e.reference} in ${e.condition_label}`,
      statement: `From ${span}, ${e.management} for ${e.condition_label} (${e.condition_code}; n = ${e.n} vs ${e.n_ref}) ${desc} compared with ${e.reference} ` +
        `(mean cost ${money(e.mean_cost, e.currency)} vs ${money(e.mean_cost_ref, e.currency)}). ` +
        `No hospital-level cost-effectiveness or budget-impact estimate exists; moving the ${e.reference} patients to ${e.management} would ${e.annual_budget_impact < 0 ? "lower" : "raise"} annual costs by a crude ${money(Math.abs(e.annual_budget_impact), e.currency)}.`,
      condition_code: e.condition_code, condition_label: e.condition_label, department_id: null, metrics: e,
      priority_score: priority(share(e.condition_code), Math.abs(e.relative_cost_difference) / 0.30, null),
      suggested_designs: ["Cost-effectiveness analysis (hospital and payer perspective)", "Budget-impact analysis", "Micro-costing study", "Decision-analytic model with probabilistic sensitivity analysis"],
    });
  }

  // 3. Departments differ in outcomes for the same condition.
  for (const v of a.variation as any[]) {
    if (v.q_value === null || v.q_value >= alpha) continue;
    out.push({
      gap_key: `dept:${v.condition_code}:${v.outcome}`,
      gap_type: "department_outcome_variation", study_category: "quality_improvement",
      title: `Variation in ${v.outcome_label} for ${v.condition_label} across departments`,
      statement: `${v.outcome_label[0].toUpperCase()}${v.outcome_label.slice(1)} for ${v.condition_label} (${v.condition_code}) ranged from ${pct(v.lowest.rate)} in ${v.lowest.department} ` +
        `to ${pct(v.highest.rate)} in ${v.highest.department} (chi-square ${v.chi2} on ${v.df} df; q = ${v.q_value.toFixed(4)}). ` +
        `The drivers of this unwarranted variation (case-mix, pathway, staffing) have not been studied.`,
      condition_code: v.condition_code, condition_label: v.condition_label, department_id: v.highest.department_id, metrics: v,
      priority_score: priority(share(v.condition_code), v.range / 0.10, v.q_value),
      suggested_designs: ["Risk-adjusted multilevel analysis with funnel plots", "Mixed-methods pathway audit", "Quality-improvement study (PDSA) with statistical process control"],
    });
  }

  // 4. A hospital parameter is associated with an outcome.
  for (const s of a.associations as any[]) {
    if (s.q_value === null || s.q_value >= alpha || Math.abs(s.rho) < 0.3) continue;
    const dir = s.rho > 0 ? "higher" : "lower";
    out.push({
      gap_key: `param:${s.parameter_code}:${s.outcome}`,
      gap_type: "parameter_outcome_association", study_category: "operational",
      title: `${s.parameter_label} and ${s.outcome_label}`,
      statement: `Across ${s.points} department-months (compared within each department), higher ${s.parameter_label}${s.unit ? ` (${s.unit})` : ""} went with ${dir} ${s.outcome_label} ` +
        `(Spearman rho ${s.rho}, 95% CI ${s.low} to ${s.high}; q = ${s.q_value.toFixed(4)}). ` +
        `Whether changing this parameter would change outcomes, and at what cost, is untested at this hospital.`,
      condition_code: null, condition_label: null, department_id: null, metrics: s,
      priority_score: priority(0.08, Math.abs(s.rho), s.q_value),
      suggested_designs: ["Interrupted time-series analysis", "Multilevel ecological study adjusted for case-mix", "Stepped-wedge evaluation of a parameter change"],
    });
  }

  // 5. Rising share of a condition.
  for (const c of a.conditions) {
    const t = c.trend as any;
    if (!t || t.q_value === null || t.q_value >= alpha || t.share_ratio < 1.2) continue;
    out.push({
      gap_key: `trend:${c.condition_code}`,
      gap_type: "rising_burden", study_category: "epidemiology",
      title: `Rising burden of ${c.condition_label}`,
      statement: `${c.condition_label} (${c.condition_code}) rose from ${pct(t.early_share)} of all cases (${t.early_periods[0]} to ${t.early_periods.at(-1)}) ` +
        `to ${pct(t.late_share)} (${t.late_periods[0]} to ${t.late_periods.at(-1)}), a share ratio of ${t.share_ratio} (95% CI ${t.low} to ${t.high}; q = ${t.q_value.toFixed(4)}). ` +
        `The reasons (referral patterns, population risk, coding) and the capacity implications are unstudied.`,
      condition_code: c.condition_code, condition_label: c.condition_label, department_id: null, metrics: { ...t, cases: c.cases, share: c.share },
      priority_score: priority(c.share, Math.log(t.share_ratio) / Math.log(2), t.q_value),
      suggested_designs: ["Time-series epidemiological study (joinpoint regression)", "Cross-sectional study of referral sources", "Capacity and demand forecasting model"],
    });
  }

  // 6. High-burden conditions nobody is studying.
  for (const c of a.coverage) {
    if (!c.high_burden || c.portfolio.length) continue;
    const cond = a.conditions.find((x) => x.condition_code === c.condition_code)!;
    const outcomes = [cond.mortality && `mortality ${pct(cond.mortality.rate)}`, cond.readmission && `30-day readmission ${pct(cond.readmission.rate)}`,
      cond.mean_los_days !== null && `mean stay ${cond.mean_los_days} days`].filter(Boolean).join(", ");
    out.push({
      gap_key: `unstudied:${c.condition_code}`,
      gap_type: "high_burden_unstudied", study_category: "epidemiology",
      title: `Burden, management and outcomes of ${c.condition_label}`,
      statement: `${c.condition_label} (${c.condition_code}) accounted for ${pct(c.share)} of all cases (${c.cases} of ${a.summary.total_cases}) from ${span}` +
        `${outcomes ? ` (${outcomes})` : ""}, managed in ${cond.managements.length} way${cond.managements.length === 1 ? "" : "s"} (${cond.managements.join(", ")}). ` +
        `No project or idea in the research portfolio addresses it.`,
      condition_code: c.condition_code, condition_label: c.condition_label, department_id: null,
      metrics: { cases: c.cases, share: c.share, mortality: cond.mortality, readmission: cond.readmission, mean_los_days: cond.mean_los_days, mean_cost: cond.mean_cost, managements: cond.managements },
      priority_score: priority(c.share, 0.5, null),
      suggested_designs: ["Retrospective cohort describing prevalence, management patterns and outcomes", "Hospital disease registry", "Cost-of-illness study"],
    });
  }

  // 7. Data completeness: research needs the inputs first.
  const fc = a.completeness.field_completeness as Record<string, number>;
  const weak = Object.entries(fc).filter(([, v]) => v < 0.8);
  if (weak.length || a.completeness.missing_months.length) {
    out.push({
      gap_key: "data:completeness", gap_type: "data_completeness", study_category: "operational",
      title: "Completeness of outcome and cost data",
      statement: `${a.completeness.observed_department_months} of ${a.completeness.expected_department_months} department-months reported case data` +
        `${weak.length ? `; fields below 80% complete: ${weak.map(([k, v]) => `${k} ${pct(v, 0)}`).join(", ")}` : ""}. ` +
        `Incomplete outcome and cost capture limits outcomes and health-economic research.`,
      condition_code: null, condition_label: null, department_id: null, metrics: a.completeness,
      priority_score: priority(0.1, weak.length ? 1 - Math.min(...weak.map(([, v]) => v)) : 0.3, null),
      suggested_designs: ["Data-quality audit", "Data dictionary and capture redesign"],
    });
  }
  for (const g of out) g.title = g.title[0].toUpperCase() + g.title.slice(1);
  return out.sort((x, y) => y.priority_score - x.priority_score || x.gap_key.localeCompare(y.gap_key));
}
