// Reports InnovaStat sends to the hospital: the Gaps & Research Ideas report
// and the study Results report. Snapshots are frozen and hashed; the PDF is
// rendered from the snapshot. Also the deterministic manuscript template.
import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import type { Client } from "../db.ts";
import { ApiError } from "../http.ts";

const FONT = fileURLToPath(new URL("../../assets/fonts/DejaVuSans.ttf", import.meta.url));
const BOLD = fileURLToPath(new URL("../../assets/fonts/DejaVuSans-Bold.ttf", import.meta.url));
const TEAL = "#17434B", MUTED = "#5b6b70";

const METHODS_GAPS = [
  "The hospital supplied patient-level Excel data. Direct identifiers (names, national ID and phone numbers, addresses) were removed on upload and patient record numbers were replaced with keyed pseudonyms.",
  "An InnovaStat statistician confirmed each step: the data dictionary, data cleaning, the hypotheses, each pre-specified analysis plan and each result.",
  "Patients were split at random into a discovery half, used only to generate hypotheses, and a validation half, used only to test the locked analysis plans. This protects against false discoveries from searching the data.",
  "Comparative analyses used multivariable regression or propensity-score weighting with robust standard errors. Economic evaluations took the hospital perspective with bootstrapped uncertainty (1,000 replicates).",
];

export async function gapsIdeasSnapshot(c: Client, wsId: string, proposalIds: string[]) {
  const ws = (await c.query("SELECT name, country, currency FROM workspace WHERE id = $1", [wsId])).rows[0];
  const props = (await c.query(`SELECT p.*, d.name AS department FROM proposal p LEFT JOIN department d ON d.id = p.department_id
    WHERE p.id = ANY($1) ORDER BY p.priority DESC, p.title`, [proposalIds])).rows;
  if (props.length !== proposalIds.length) throw new ApiError(404, "not_found", "Some proposals were not found");
  const notReady = props.filter((p) => p.status !== "confirmed");
  if (notReady.length) throw new ApiError(409, "not_confirmed", `Only statistician-confirmed proposals can be reported: ${notReady.map((p) => p.title).join("; ")}`);
  const datasets = (await c.query(`SELECT id, title, row_count, cleaning_report->'split' AS split FROM study_dataset WHERE id = ANY($1) ORDER BY title`,
    [[...new Set(props.map((p) => p.dataset_id).filter(Boolean))]])).rows;
  return {
    kind: "gaps_ideas", hospital: ws.name, country: ws.country, currency: ws.currency,
    datasets: datasets.map((d) => ({ title: d.title, patients: d.row_count, discovery: d.split?.discovery ?? null, validation: d.split?.validation ?? null })),
    methods: METHODS_GAPS,
    ideas: props.map((p, i) => ({ number: i + 1, proposal_id: p.id, title: p.title, department: p.department, study_category: p.study_category,
      priority: Number(p.priority), concept: p.concept, evidence: p.evidence })),
    next_step: "For each idea, the research director approves it (it becomes a study in InnovaHospital, with protocol, ethics and data approvals) or declines it with a reason.",
  };
}

export async function resultsSnapshot(c: Client, wsId: string, projectId: string, resultIds: string[]) {
  const ws = (await c.query("SELECT name, country, currency FROM workspace WHERE id = $1", [wsId])).rows[0];
  const p = (await c.query("SELECT p.*, d.name AS department FROM project p JOIN department d ON d.id = p.department_id WHERE p.id = $1", [projectId])).rows[0];
  if (!p) throw new ApiError(404, "not_found", "Project not found");
  const res = (await c.query(`SELECT r.*, a.plan, a.sha256 AS plan_hash, h.title AS hypothesis, h.statement FROM study_result r
    JOIN analysis_plan a ON a.id = r.plan_id JOIN study_hypothesis h ON h.id = r.hypothesis_id WHERE r.id = ANY($1) ORDER BY r.created_at`, [resultIds])).rows;
  if (res.length !== resultIds.length) throw new ApiError(404, "not_found", "Some results were not found");
  if (res.some((r) => r.status !== "accepted")) throw new ApiError(409, "not_accepted", "Only statistician-accepted results can be reported");
  return {
    kind: "results", hospital: ws.name, currency: ws.currency,
    project: { id: p.id, title: p.title, department: p.department, pi: p.pi, study_type: p.study_type, protocol_version: p.protocol_version },
    analyses: res.map((r) => ({ result_id: r.id, hypothesis: r.hypothesis, plan_title: r.plan.title, plan_sha256: r.plan_hash, population: r.results.population,
      primary: r.results.primary, significant: r.results.significant, crude: r.results.crude, coefficients: r.results.coefficients, table1: r.results.table1,
      balance: r.results.balance ?? null, economics: r.results.economics ?? null, warnings: r.results.warnings, interpretation: r.interpretation,
      method: r.results.method, outcome: r.plan.outcome, exposure: r.plan.exposure, covariates: r.plan.covariates })),
    limitations: ["Observational, single-hospital data: associations may reflect unmeasured confounding.", "Analyses followed plans locked before results were seen, on held-out validation data."],
    next_step: "The research director approves these results or returns them with comments. After approval InnovaStat drafts the manuscript.",
  };
}

// ---- PDF ---------------------------------------------------------------------------------
export function renderClientPdf(s: any, meta: { title: string; revision: number; status: string; digest: string; synthetic?: boolean }): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true, info: { Title: meta.title, Author: "InnovaStat CRO" } });
  doc.registerFont("body", FONT); doc.registerFont("bold", BOLD);
  const chunks: Buffer[] = []; doc.on("data", (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((r) => doc.on("end", () => r(Buffer.concat(chunks))));
  const W = doc.page.width - 100;
  const h1 = (t: string) => doc.font("bold").fontSize(19).fillColor(TEAL).text(t);
  const h2 = (t: string) => { if (doc.y > doc.page.height - 150) doc.addPage(); doc.moveDown(0.7).font("bold").fontSize(13).fillColor(TEAL).text(t).moveDown(0.2); };
  const h3 = (t: string) => doc.moveDown(0.3).font("bold").fontSize(10.5).fillColor("#111").text(t);
  const p = (t: string) => doc.font("body").fontSize(9.5).fillColor("#111").text(t, { lineGap: 1.5 });
  const kv = (k: string, v: unknown) => { if (v === null || v === undefined || v === "") return; doc.font("bold").fontSize(9.5).text(`${k}: `, { continued: true }).font("body").text(String(v)); };

  h1(meta.title);
  p(`${s.hospital} | Revision ${meta.revision} | ${meta.status.replaceAll("_", " ").toUpperCase()} | Prepared by InnovaStat CRO`);
  if (meta.synthetic) p("SYNTHETIC DEMONSTRATION DATA");
  doc.fontSize(7).fillColor(MUTED).text(`Snapshot digest ${meta.digest}`);
  if (s.kind === "gaps_ideas") {
    h2("Data and methods");
    for (const d of s.datasets) p(`•  ${d.title}: ${d.patients} patients (${d.discovery ?? "—"} discovery, ${d.validation ?? "—"} validation).`);
    for (const m of s.methods) p(`•  ${m}`);
    h2(`Research gaps and suggested studies (${s.ideas.length})`);
    for (const i of s.ideas) {
      h3(`${i.number}. ${i.title}`);
      kv("Category", String(i.study_category).replaceAll("_", " ")); kv("Department", i.department); kv("Priority", i.priority);
      kv("Gap and evidence", i.evidence.statement);
      if (i.evidence.result) kv("Tested on held-out data", i.evidence.result);
      kv("Research question", i.concept.research_question); kv("Design", i.concept.design); kv("Population", i.concept.population);
      kv("Primary outcome", i.concept.primary_outcome); kv("Comparator", i.concept.comparator); kv("Health-economic method", i.concept.economic_method);
      kv("Expected output", i.concept.expected_output);
    }
    h2("Next step"); p(s.next_step);
  } else {
    h2("Study"); kv("Title", s.project.title); kv("Department", s.project.department); kv("Design", s.project.study_type); kv("Protocol version", s.project.protocol_version);
    for (const a of s.analyses) {
      h2(a.plan_title);
      p(a.interpretation);
      kv("Population", `${a.population.included} patients (${a.population.treated} ${a.population.treated_label}, ${a.population.reference} ${a.population.reference_label})`);
      kv("Primary estimate", `${String(a.primary.measure).replaceAll("_", " ")} ${a.primary.estimate} (95% CI ${a.primary.low} to ${a.primary.high}), p ${a.primary.p_value < 0.001 ? "< 0.001" : "= " + a.primary.p_value}`);
      kv("Adjusted for", a.covariates.join(", ") || "none");
      if (a.economics) kv("Economic evaluation", `incremental cost ${a.economics.incremental_cost} ${a.economics.currency} (95% CI ${a.economics.incremental_cost_low} to ${a.economics.incremental_cost_high}); incremental effect ${a.economics.incremental_effect}; ${String(a.economics.dominance).replaceAll("_", " ")}${a.economics.icer !== null ? `; ICER ${a.economics.icer}` : ""}`);
      h3("Baseline characteristics");
      for (const t of a.table1) p(`${t.variable}${t.level ? ` (${t.level})` : ""}: ${t.treated} vs ${t.reference}; SMD ${t.smd}`);
      h3("Model coefficients");
      for (const k of a.coefficients) p(`${k.term}: ${k.estimate} (SE ${k.se}; 95% CI ${k.low} to ${k.high}; p ${k.p_value})`);
    }
    h2("Limitations"); for (const l of s.limitations) p(`•  ${l}`);
    h2("Next step"); p(s.next_step);
  }
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    if (!["released", "hospital_approved", "hospital_returned"].includes(meta.status)) doc.save().rotate(-35, { origin: [300, 420] }).font("bold").fontSize(64).fillColor("#c0392b").opacity(0.12).text("DRAFT", 120, 400).restore();
    const bottom = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    doc.font("body").fontSize(7.5).fillColor(MUTED).opacity(1).text(`InnovaHospital | ${s.hospital} | r${meta.revision} | page ${i + 1} of ${range.count}`, 50, doc.page.height - 40, { width: W, align: "center", lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}

// ---- Manuscript template -------------------------------------------------------------------
export function templateManuscript(report: any) {
  const a = report.analyses[0];
  const econ = report.analyses.find((x: any) => x.economics);
  const cohort = `${a.population.included} patients (${a.population.treated} ${a.population.treated_label}; ${a.population.reference} ${a.population.reference_label})`;
  const est = (x: any) => `${String(x.primary.measure).replaceAll("_", " ")} ${x.primary.estimate} (95% CI ${x.primary.low} to ${x.primary.high}; p ${x.primary.p_value < 0.001 ? "< 0.001" : "= " + x.primary.p_value})`;
  return {
    title: report.project.title,
    abstract: `Background: [AUTHOR INPUT]. Methods: retrospective cohort at ${report.hospital}; analyses followed plans locked before results were seen, on held-out validation data. Results: among ${cohort}, ${report.analyses.map(est).join("; ")}.${econ ? ` Incremental cost ${econ.economics.incremental_cost} ${econ.economics.currency} per patient (${String(econ.economics.dominance).replaceAll("_", " ")}).` : ""} Conclusion: [AUTHOR INPUT].`,
    introduction: "[AUTHOR INPUT: clinical background, evidence gap and objective] [REF]",
    methods: `Design and setting: retrospective cohort study at ${report.hospital} (${report.project.department}). Data: de-identified patient-level hospital records; identifiers were removed before analysis. Exposure: ${a.exposure.treated} versus ${a.exposure.reference}. Outcome: ${a.outcome.variable.replaceAll("_", " ")}. Statistical analysis: ${a.method === "iptw" ? "inverse-probability-of-treatment weighting with stabilised, truncated weights and robust standard errors" : "multivariable regression"} adjusting for ${a.covariates.join(", ").replaceAll("_", " ") || "no covariates"}. Hypotheses were generated on a random discovery half and tested on the validation half under pre-specified plans (plan hash ${String(a.plan_sha256).slice(0, 12)}). ${econ ? "Economic evaluation: hospital perspective, bootstrapped incremental costs and effects (1,000 replicates), cost-effectiveness acceptability curve (CHEERS 2022). " : ""}Reporting follows STROBE.`,
    results: report.analyses.map((x: any) => x.interpretation).join("\n\n"),
    discussion: "[AUTHOR INPUT: principal findings in context, comparison with previous studies [REF], strengths, limitations (observational design, residual confounding, single centre), implications]",
    conclusion: "[AUTHOR INPUT]",
  };
}
