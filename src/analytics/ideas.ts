// Research ideas from confirmed gaps. The deterministic template is the
// default and the fallback (Handoff §5 step 7); an optional Claude drafter
// writes a richer concept, which is accepted only if every number it states
// occurs in the gap it was given.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export type GapForIdea = {
  id: string; gap_type: string; study_category: string; title: string; statement: string;
  condition_code: string | null; condition_label: string | null; metrics: Record<string, any>;
  suggested_designs: string[]; hospital: string; currency: string;
};

const t = (max: number) => z.string().trim().min(1).max(max);
export const ideaDraftSchema = z.object({
  title: t(300),
  research_question: t(2000),
  rationale: t(4000),
  design: t(500),
  study_category: z.enum(["clinical_effectiveness", "health_economics", "epidemiology", "quality_improvement", "operational", "other"]),
  population: t(2000),
  data_sources: t(2000),
  primary_outcome: t(1000),
  comparator: t(1000).nullable(),
  analysis_plan: t(4000),
  economic_method: t(2000).nullable(),
  expected_output: t(1000),
}).strict();
export type IdeaDraft = z.infer<typeof ideaDraftSchema>;

const DATA = "Hospital information system and medical records for the cohort, extracted under the approved data-access route; aggregate data from InnovaHospital for feasibility.";

export function templateIdea(g: GapForIdea): IdeaDraft {
  const m = g.metrics;
  const cond = g.condition_label ? (g.condition_code && g.condition_code !== g.condition_label ? `${g.condition_label} (${g.condition_code})` : g.condition_label) : "";
  switch (g.gap_type) {
    case "management_outcome_variation":
      return {
        title: `Comparative effectiveness of ${m.management} versus ${m.reference} in ${g.condition_label} at ${g.hospital}`,
        research_question: `Among adults admitted to ${g.hospital} with ${cond}, is ${m.management}, compared with ${m.reference}, associated with a different risk of ${m.outcome_label} after adjustment for severity and case-mix?`,
        rationale: g.statement, design: "Retrospective cohort study with propensity-score (inverse probability) weighting; target-trial emulation framework",
        study_category: "clinical_effectiveness",
        population: `Consecutive adult patients with ${cond} managed with ${m.management} or ${m.reference}`,
        data_sources: DATA, primary_outcome: m.outcome_label, comparator: m.reference,
        analysis_plan: "Define eligibility and time zero; collect severity, comorbidity and demographic confounders; estimate weighted risk differences and odds ratios with robust 95% CIs; E-value and sensitivity analyses for unmeasured confounding; secondary outcomes: length of stay, complications, readmission.",
        economic_method: null, expected_output: "Original research article (comparative effectiveness) and STROBE-compliant conference abstract",
      };
    case "cost_effectiveness":
      return {
        title: `Cost-effectiveness and budget impact of ${m.management} versus ${m.reference} for ${g.condition_label} at ${g.hospital}`,
        research_question: `From the hospital and payer perspectives, what is the incremental cost per death averted and per QALY gained of ${m.management} compared with ${m.reference} for ${cond}, and what is its budget impact?`,
        rationale: g.statement, design: "Model-based economic evaluation (decision tree / Markov) populated with hospital cohort data; budget-impact analysis",
        study_category: "health_economics",
        population: `Patients with ${cond} treated with ${m.management} or ${m.reference}`,
        data_sources: `${DATA} Hospital costing and tariff data (${g.currency}); published utilities for QALY estimation.`,
        primary_outcome: "Incremental cost-effectiveness ratio (cost per death averted; cost per QALY)", comparator: m.reference,
        analysis_plan: "Patient-level micro-costing of the pathway; risk-adjusted effect estimates from the cohort; deterministic and probabilistic sensitivity analyses; cost-effectiveness acceptability curve against national willingness-to-pay thresholds; 3-5 year budget impact.",
        economic_method: `Cost-effectiveness analysis with ICER per death averted and per QALY (CHEERS 2022); budget-impact analysis (ISPOR). Crude incremental cost ${g.currency} ${m.incremental_cost} per patient.`,
        expected_output: "Health economics article and policy brief for hospital leadership and payers",
      };
    case "department_outcome_variation":
      return {
        title: `Drivers of variation in ${m.outcome_label} for ${g.condition_label} across ${g.hospital} departments`,
        research_question: `How much of the between-department difference in ${m.outcome_label} for ${cond} remains after risk adjustment, and which pathway or staffing factors explain it?`,
        rationale: g.statement, design: "Risk-adjusted multilevel cohort analysis with funnel plots, followed by a quality-improvement intervention",
        study_category: "quality_improvement",
        population: `Patients with ${cond} across participating departments`,
        data_sources: `${DATA} Department pathway documents and staffing rosters.`,
        primary_outcome: m.outcome_label, comparator: "Best-performing department",
        analysis_plan: "Hierarchical logistic regression with department random effects; funnel plots against control limits; process-mapping of outlying pathways; PDSA cycle with statistical process control charts.",
        economic_method: null, expected_output: "Quality-improvement report (SQUIRE 2.0) and benchmarking article",
      };
    case "parameter_outcome_association":
      return {
        title: `Effect of ${m.parameter_label} on ${m.outcome_label} at ${g.hospital}`,
        research_question: `Does a change in ${m.parameter_label} lead to a change in ${m.outcome_label}, after accounting for case-mix and secular trends?`,
        rationale: g.statement, design: "Interrupted time-series or stepped-wedge evaluation of a planned change in the parameter",
        study_category: "operational",
        population: "All admissions in participating departments during the study period",
        data_sources: `${DATA} Operational records of ${m.parameter_label}.`,
        primary_outcome: m.outcome_label, comparator: "Pre-change period / not-yet-exposed departments",
        analysis_plan: "Segmented regression with autocorrelation correction; case-mix adjustment; dose-response analysis; cost of the parameter change versus outcome gains.",
        economic_method: "Cost-consequence analysis of the parameter change", expected_output: "Health services research article and operational recommendation",
      };
    case "rising_burden":
      return {
        title: `Trends and drivers of ${g.condition_label} admissions at ${g.hospital}`,
        research_question: `How has the burden of ${cond} changed over time, which patient groups and referral sources drive the change, and what capacity will be needed?`,
        rationale: g.statement, design: "Time-series epidemiological study with joinpoint regression and demand forecasting",
        study_category: "epidemiology", population: `All admissions with ${cond}`, data_sources: DATA,
        primary_outcome: "Monthly admissions and share of all admissions", comparator: null,
        analysis_plan: "Joinpoint regression of monthly counts and shares; stratification by age, sex and referral source; ARIMA forecasting of bed-days.",
        economic_method: "Projected bed-day and cost demand", expected_output: "Epidemiology article and capacity-planning brief",
      };
    case "high_burden_unstudied":
      return {
        title: `Burden, management patterns and outcomes of ${g.condition_label} at ${g.hospital}`,
        research_question: `What proportion of admissions at ${g.hospital} are due to ${cond}, how are these patients managed, and what are their mortality, readmission, length of stay and costs?`,
        rationale: g.statement, design: "Retrospective cohort (hospital-based) with descriptive and multivariable analysis; cost-of-illness component",
        study_category: "epidemiology", population: `All patients admitted with ${cond}`, data_sources: DATA,
        primary_outcome: "Proportion of admissions; in-hospital mortality", comparator: null,
        analysis_plan: "Prevalence among admissions with 95% CIs; distribution of management strategies; outcomes by strategy with multivariable adjustment; predictors of mortality and readmission.",
        economic_method: "Cost-of-illness from the hospital perspective", expected_output: "Original article on disease burden and outcomes; hospital disease profile",
      };
    default:
      return {
        title: `Improving completeness of outcome and cost data at ${g.hospital}`,
        research_question: "Which data elements needed for outcomes and health-economic research are missing, why, and does a redesigned capture process improve completeness?",
        rationale: g.statement, design: "Data-quality audit followed by a before-after improvement study",
        study_category: "operational", population: "All departments reporting case data", data_sources: "InnovaHospital upload records and department data processes",
        primary_outcome: "Field completeness (%)", comparator: "Pre-intervention completeness",
        analysis_plan: "Audit of capture pathways; root-cause analysis; redesign; run charts of completeness.",
        economic_method: null, expected_output: "Internal data-quality report",
      };
  }
}

// ---- Optional Claude drafter -------------------------------------------------
export const IDEA_MODEL = process.env.IDEA_AGENT_MODEL ?? "claude-opus-5-5";
export const anthropicKey = () => process.env.INNOVA_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || undefined;

const NUM_RE = /-?\d[\d,]*(?:\.\d+)?/g;
export const numbersIn = (s: string): number[] => (s.match(NUM_RE) ?? []).map((x) => Number(x.replaceAll(",", ""))).filter(Number.isFinite);

/** Every number the draft states must appear in the gap (statement, metrics) or be a small count/percentage-point form of one. */
export function unsupportedNumbers(draft: IdeaDraft, g: GapForIdea): number[] {
  const source = new Set<number>();
  const collect = (v: unknown) => {
    if (typeof v === "number") { source.add(v); source.add(Math.round(v * 1000) / 10); source.add(Math.round(v * 100) / 100); source.add(Math.round(v)); }
    else if (typeof v === "string") numbersIn(v).forEach((n) => source.add(n));
    else if (v && typeof v === "object") Object.values(v).forEach(collect);
  };
  collect(g.statement); collect(g.metrics); collect(g.condition_code ?? "");
  const text = Object.values(draft).filter((x): x is string => typeof x === "string").join(" ");
  // Design vocabulary numbers (CHEERS 2022, 95% CI, 30-day, 3-5 years...) are allowed.
  const allowed = new Set([0, 1, 2, 3, 4, 5, 10, 12, 30, 90, 95, 100, 2022, 2.0]);
  return [...new Set(numbersIn(text))].filter((n) => !allowed.has(Math.abs(n)) && !source.has(n) && !source.has(Math.abs(n)));
}

const SYSTEM = `You are a senior clinical epidemiologist and health economist at a hospital research office. You turn a statistically detected research gap, computed from verified aggregate hospital data, into one publishable study concept. Be specific about design, population, outcomes, confounding, and for economic questions the costing perspective and methods. State numbers only if they appear in the gap you are given. Do not claim the gap's crude associations are causal.`;

const JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["title", "research_question", "rationale", "design", "study_category", "population", "data_sources", "primary_outcome", "comparator", "analysis_plan", "economic_method", "expected_output"],
  properties: {
    title: { type: "string" }, research_question: { type: "string" }, rationale: { type: "string" }, design: { type: "string" },
    study_category: { type: "string", enum: ["clinical_effectiveness", "health_economics", "epidemiology", "quality_improvement", "operational", "other"] },
    population: { type: "string" }, data_sources: { type: "string" }, primary_outcome: { type: "string" },
    comparator: { type: ["string", "null"] }, analysis_plan: { type: "string" }, economic_method: { type: ["string", "null"] }, expected_output: { type: "string" },
  },
};

export interface IdeaDrafter { draft(g: GapForIdea): Promise<{ draft: IdeaDraft | null; problems: string[]; model: string }> }

export class ClaudeIdeaDrafter implements IdeaDrafter {
  client: Anthropic;
  constructor(client = new Anthropic({ apiKey: anthropicKey(), baseURL: process.env.IDEA_API_BASE_URL || "https://api.anthropic.com", maxRetries: 3 })) { this.client = client; }

  async draft(g: GapForIdea) {
    const user = `Hospital: ${g.hospital} (currency ${g.currency}).\nGap type: ${g.gap_type} (${g.study_category}).\nTitle: ${g.title}\nStatement: ${g.statement}\n` +
      `Metrics (JSON): ${JSON.stringify(g.metrics)}\nSuggested designs: ${g.suggested_designs.join("; ")}\n\nDraft one study concept.`;
    let response;
    try {
      response = await this.client.beta.messages.create({
        model: IDEA_MODEL, max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
        system: SYSTEM,
        output_config: { effort: "medium", format: { type: "json_schema", schema: JSON_SCHEMA } },
        messages: [{ role: "user", content: user }],
      } as any);
    } catch (err) {
      const status = err instanceof Anthropic.APIError ? err.status : null;
      return { draft: null, problems: [`api_error${status ? `_${status}` : ""}`], model: IDEA_MODEL };
    }
    if (response.stop_reason === "refusal") return { draft: null, problems: ["refused"], model: IDEA_MODEL };
    const text = response.content.filter((b: { type: string }) => b.type === "text").map((b: any) => b.text).join("");
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return { draft: null, problems: ["invalid_json"], model: IDEA_MODEL }; }
    const res = ideaDraftSchema.safeParse(parsed);
    if (!res.success) return { draft: null, problems: res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`), model: IDEA_MODEL };
    const bad = unsupportedNumbers(res.data, g);
    if (bad.length) return { draft: null, problems: [`numbers not in the gap: ${bad.join(", ")}`], model: IDEA_MODEL };
    return { draft: res.data, problems: [], model: IDEA_MODEL };
  }
}
