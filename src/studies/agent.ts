// The InnovaStat study agent (Claude). It works inside the workspace on
// summaries only: column profiles (value lists only for low-cardinality
// columns, each value seen at least `small_cell` times), cleaning summaries,
// discovery-split screening statistics, locked plans and result tables.
// It never receives patient rows. Every output is validated before use; on
// any failure the deterministic rule or template is used instead and the
// reasons are recorded. A statistician confirms every step.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { dictEntry } from "./data.ts";
import { planSchema } from "../stats/study.ts";

export const STUDY_AGENT_MODEL = process.env.STUDY_AGENT_MODEL ?? "claude-opus-5-5";
export const agentKey = () => process.env.INNOVA_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || undefined;

export type AgentTask = "dictionary" | "hypotheses" | "plan" | "interpret" | "manuscript";
export type AgentAttempt = { output: unknown | null; problems: string[]; model: string; input_tokens?: number; output_tokens?: number };
export interface StudyAgent { run(task: AgentTask, input: unknown): Promise<AgentAttempt> }

// ---- Output schemas -------------------------------------------------------------------
const hypothesisOut = z.object({
  kind: z.enum(["comparative", "economic", "burden"]),
  study_category: z.enum(["clinical_effectiveness", "health_economics", "epidemiology"]),
  title: z.string().min(1).max(300), statement: z.string().min(1).max(3000),
  exposure: z.string().nullable(), treated: z.string().nullable(), reference: z.string().nullable(),
  outcome: z.string().nullable(), outcome_type: z.enum(["binary", "continuous"]).nullable(), cost: z.string().nullable(),
  diagnosis: z.string().nullable(), diagnosis_value: z.string().nullable(),
  rationale: z.string().max(2000),
}).strict();
export const OUTPUT = {
  dictionary: z.object({ entries: z.array(dictEntry) }).strict(),
  hypotheses: z.object({ hypotheses: z.array(hypothesisOut).max(15) }).strict(),
  plan: z.object({ plan: planSchema, justification: z.string().max(3000) }).strict(),
  interpret: z.object({ interpretation: z.string().min(1).max(6000) }).strict(),
  manuscript: z.object({ title: z.string().max(300), abstract: z.string().max(4000), introduction: z.string().max(8000), methods: z.string().max(12000),
    results: z.string().max(12000), discussion: z.string().max(12000), conclusion: z.string().max(3000) }).strict(),
} satisfies Record<AgentTask, z.ZodType>;

const SYSTEM: Record<AgentTask, string> = {
  dictionary: "You are a biostatistician preparing a data dictionary for a hospital study dataset. From column profiles only, assign each column a role and type. Mark any column that could identify a person (names, phone, ID numbers, addresses) as identifier. For binary columns list the exact values meaning yes and no. Keep source and name exactly as given.",
  hypotheses: "You are a clinical epidemiologist and health economist. From the variable list, data summaries and discovery-split screening statistics, propose research hypotheses worth testing on held-out data: comparative effectiveness of managements, cost-effectiveness, and disease burden. Use only the variable names given. State only numbers that appear in the input. Do not claim causation.",
  plan: "You are a biostatistician writing a pre-specified statistical analysis plan for one hypothesis. Choose the population filters, exposure levels, outcome type, confounders to adjust for (baseline variables only, never post-exposure variables), and the method (regression or propensity weighting). Add an economic evaluation block for cost-effectiveness hypotheses. Use only the variable names given. The plan runs on the held-out validation split.",
  interpret: "You are a biostatistician writing the results interpretation for a hospital report. Report the primary estimate with its confidence interval and p value, state whether it is significant at the pre-specified level, summarise the economic evaluation if present, and list limitations. Use only numbers that appear in the result. Do not overstate causation.",
  manuscript: "You are a medical writer drafting a manuscript for a peer-reviewed journal from an approved study result (STROBE for observational studies, CHEERS 2022 for economic evaluations). Use only numbers that appear in the input. Mark places needing author input with [AUTHOR INPUT]. Do not invent references; write [REF] where a citation is needed.",
};

/** JSON schema for structured output, from the zod schema. */
const jsonSchema = (task: AgentTask) => z.toJSONSchema(OUTPUT[task], { target: "draft-2020-12" }) as Record<string, unknown>;

export class ClaudeStudyAgent implements StudyAgent {
  client: Anthropic;
  constructor(client = new Anthropic({ apiKey: agentKey(), baseURL: process.env.STUDY_AGENT_BASE_URL || "https://api.anthropic.com", maxRetries: 3 })) { this.client = client; }
  async run(task: AgentTask, input: unknown): Promise<AgentAttempt> {
    let response;
    try {
      response = await this.client.beta.messages.create({
        model: STUDY_AGENT_MODEL, max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
        system: SYSTEM[task],
        output_config: { effort: "medium", format: { type: "json_schema", schema: jsonSchema(task) } },
        messages: [{ role: "user", content: JSON.stringify(input) }],
      } as any);
    } catch (err) {
      const status = err instanceof Anthropic.APIError ? err.status : null;
      return { output: null, problems: [`api_error${status ? `_${status}` : ""}`], model: STUDY_AGENT_MODEL };
    }
    const usage = { input_tokens: response.usage?.input_tokens, output_tokens: response.usage?.output_tokens };
    if (response.stop_reason === "refusal") return { output: null, problems: ["refused"], model: STUDY_AGENT_MODEL, ...usage };
    if (response.stop_reason === "max_tokens") return { output: null, problems: ["output_truncated"], model: STUDY_AGENT_MODEL, ...usage };
    const text = response.content.filter((b: { type: string }) => b.type === "text").map((b: any) => b.text).join("");
    try { return { output: JSON.parse(text), problems: [], model: STUDY_AGENT_MODEL, ...usage }; }
    catch { return { output: null, problems: ["invalid_json"], model: STUDY_AGENT_MODEL, ...usage }; }
  }
}

// ---- Number validation -------------------------------------------------------------------
const NUM_RE = /-?\d[\d,]*(?:\.\d+)?/g;
const numbers = (s: string) => (s.match(NUM_RE) ?? []).map((x) => Number(x.replaceAll(",", ""))).filter(Number.isFinite);
/** Numbers stated in `text` that do not occur in `source` (in any common rounding or as a percentage). */
export function unsupported(text: string, source: unknown, allowed: number[] = [0, 1, 2, 3, 4, 5, 10, 12, 30, 90, 95, 100, 2022]): number[] {
  const ok = new Set<number>(allowed);
  const add = (v: number) => { for (const x of [v, v * 100]) for (const d of [0, 1, 2, 3, 4]) { const f = 10 ** d; ok.add(Math.round(x * f) / f); ok.add(Math.abs(Math.round(x * f) / f)); } };
  const walk = (v: unknown) => { if (typeof v === "number") add(v); else if (typeof v === "string") numbers(v).forEach(add); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
  walk(source);
  return [...new Set(numbers(text))].filter((n) => !ok.has(n) && !ok.has(Math.abs(n)));
}
