// Server-side PDF of an executive report snapshot (pdfkit, DejaVu fonts for
// Arabic glyph coverage). Drafts carry a watermark.
import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "./snapshot.ts";

const FONT = fileURLToPath(new URL("../../assets/fonts/DejaVuSans.ttf", import.meta.url));
const BOLD = fileURLToPath(new URL("../../assets/fonts/DejaVuSans-Bold.ttf", import.meta.url));
const TEAL = "#17434B", LIGHT = "#EAF3F3", MUTED = "#5b6b70";

export function renderPdf(s: Snapshot, meta: { revision: number; status: string; digest: string; synthetic?: boolean }): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true, info: { Title: `InnovaHospital Executive Report ${s.period_label ?? s.period}`, Author: "InnovaHospital" } });
  doc.registerFont("body", FONT); doc.registerFont("bold", BOLD);
  const chunks: Buffer[] = [];
  doc.on("data", (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  const W = doc.page.width - 100;

  const h1 = (t: string) => doc.font("bold").fontSize(20).fillColor(TEAL).text(t);
  const h2 = (t: string) => { if (doc.y > doc.page.height - 140) doc.addPage(); doc.moveDown(0.8).font("bold").fontSize(13).fillColor(TEAL).text(t).moveDown(0.3); };
  const p = (t: string, o: PDFKit.Mixins.TextOptions = {}) => doc.font("body").fontSize(9.5).fillColor("#111").text(t, o);
  const table = (head: string[], rows: (string | number | null | undefined)[][], widths: number[]) => {
    const scale = W / widths.reduce((a, b) => a + b, 0);
    const ws = widths.map((w) => w * scale);
    const row = (cells: (string | number | null | undefined)[], header: boolean, shade: boolean) => {
      doc.font(header ? "bold" : "body").fontSize(8.5);
      const hgt = Math.max(...cells.map((c, i) => doc.heightOfString(String(c ?? "—"), { width: ws[i] - 8 }))) + 8;
      if (doc.y + hgt > doc.page.height - 60) doc.addPage();
      const y = doc.y;
      if (header || shade) doc.rect(50, y, W, hgt).fill(header ? TEAL : LIGHT);
      let x = 50;
      cells.forEach((c, i) => { doc.fillColor(header ? "#fff" : "#111").text(String(c ?? "—"), x + 4, y + 4, { width: ws[i] - 8 }); x += ws[i]; });
      doc.x = 50; doc.y = y + hgt;
    };
    row(head, true, false);
    rows.forEach((r, i) => row(r, false, i % 2 === 0));
    doc.moveDown(0.4);
  };

  h1("InnovaHospital Executive Report");
  p(`${s.hospital} | ${s.period_label ?? s.period} | Revision ${meta.revision} | ${meta.status.toUpperCase()}`, { continued: false });
  if (meta.synthetic) p("SYNTHETIC DEMONSTRATION DATA");
  doc.fontSize(7).fillColor(MUTED).text(`Snapshot digest ${meta.digest}`);

  h2("Executive summary");
  for (const line of s.executive_summary) p(`•  ${line}`);

  h2("Research funnel and portfolio");
  table(["Idea status", "Ideas"], s.funnel.ideas_by_status.map((x: any) => [x.status, x.n]), [3, 1]);
  p(`Ideas triaged in ${s.period_label ?? s.period}: ${s.funnel.triaged_in_period}; median triage turnaround: ${s.funnel.median_triage_days ?? "—"} days.`);
  table(["Project stage", "Projects"], s.portfolio.by_stage.map((x: any) => [x.stage, x.projects]), [3, 1]);
  p(`Activated during the period: ${s.portfolio.activated_in_period}. Milestones due: ${s.milestones.due_in_period}, on time: ${s.milestones.completed_on_time}` +
    `${s.milestones.on_time_rate_percent !== null ? ` (${s.milestones.on_time_rate_percent}%)` : ""}; overdue unresolved: ${s.milestones.overdue_unresolved}.`);

  h2("Quality indicators");
  table(["Department", "Indicator", "Status", "Value", "Target", "Met"],
    s.indicators.map((i: any) => [i.department, `${i.name} (v${i.definition_version})`, i.status.replace("_", " "),
      i.percent !== undefined ? `${i.percent}%` : "—", i.target_percent !== undefined ? `${i.target_percent}%` : "—",
      i.meets_target === undefined ? "—" : i.meets_target ? "Yes" : "No"]), [2.2, 3.2, 1.4, 1, 1, 0.8]);
  if ((s.indicator_totals ?? []).length) {
    table(["Hospital-wide", "Status", "Value", "Target", "Met"],
      (s.indicator_totals as any[]).map((i) => [`${i.name} (v${i.definition_version})`, i.status.replace("_", " "),
        i.percent !== undefined ? `${i.percent}%` : "—", i.target_percent !== undefined ? `${i.target_percent}%` : "—",
        i.meets_target === undefined ? "—" : i.meets_target ? "Yes" : "No"]), [5.4, 1.4, 1, 1, 0.8]);
  }
  p(`Indicator completeness: ${s.indicator_completeness_percent ?? "—"}%.`);

  const ri = s.research_intelligence as any;
  h2("Research from InnovaStat");
  if (!ri) p("No InnovaStat research report has been released yet.");
  else {
    p(`Ideas suggested: ${ri.ideas.length}; approved: ${ri.ideas_approved}; awaiting a decision: ${ri.ideas_awaiting_decision}. Results reports awaiting approval: ${ri.results_awaiting_approval}.`);
    if (ri.ideas.length) table(["Suggested study", "Category", "Decision"], ri.ideas.map((g: any) => [g.title, String(g.study_category).replaceAll("_", " "), g.status === "released" ? "awaiting decision" : g.status]), [5, 2, 1.4]);
  }

  h2("Outputs, training and partnerships");
  table(["Output type", "Approved", "Submitted in period", "Published in period"], s.outputs.map((o: any) => [o.output_type, o.approved, o.submitted_in_period, o.published_in_period]), [2, 1, 1.4, 1.4]);
  if (s.training.cohorts_ended === undefined) p(`Training: ${s.training.completed} of ${s.training.enrolled} enrolled completed${s.training.completion_percent !== null ? ` (${s.training.completion_percent}%)` : ""}.`);
  else if (!s.training.cohorts_ended) p(`Training: no cohort ended in ${s.period_label ?? s.period}.`);
  else p(`Training: in ${s.training.cohorts_ended} cohort${s.training.cohorts_ended === 1 ? "" : "s"} that ended in ${s.period_label ?? s.period}, ${s.training.completed} of ${s.training.eligible} people met the completion rule` +
    `${s.training.completion_percent !== null ? ` (${s.training.completion_percent}%)` : ""}${s.training.awaiting_decision ? `; ${s.training.awaiting_decision} awaiting a completion decision` : ""}.`);
  if (s.partnerships.length) table(["Partnership stage", "Currency", "Count", "Pipeline value"], s.partnerships.map((x: any) => [x.stage, x.currency ?? "—", x.n, x.value ? x.value.toLocaleString("en-US") : "—"]), [2, 1, 1, 1.6]);

  h2("Risks and decisions");
  if (!s.risks.on_hold.length && !s.risks.approvals_expiring.length && !s.risks.approval_problems.length) p("No open governance risks.");
  for (const x of s.risks.on_hold) p(`•  On hold: ${x.project} — ${x.reason ?? ""}`);
  for (const x of s.risks.approvals_expiring as any[]) p(`•  ${x.kind} approval for ${x.title} expires ${x.expiry_date}`);
  for (const x of s.risks.approval_problems) p(`•  ${x.project}: ${x.problems.join("; ")}`);

  h2("Next 30-day actions");
  if (!s.actions.length) p("No open actions.");
  else table(["Action", "Owner", "Due", "Status"], s.actions.map((a) => [a.action, a.owner, a.due_date, a.status]), [5, 2, 1.2, 0.8]);

  h2("Scope and limitations");
  for (const l of s.limitations) p(`•  ${l}`);

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    if (meta.status !== "published") {
      doc.save().rotate(-35, { origin: [300, 420] }).font("bold").fontSize(64).fillColor("#c0392b").opacity(0.12).text("DRAFT", 120, 400).restore();
    }
    // Writing below the bottom margin would make pdfkit add a page.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("body").fontSize(7.5).fillColor(MUTED).opacity(1)
      .text(`InnovaHospital | ${s.hospital} | ${s.period_label ?? s.period} r${meta.revision} | page ${i + 1} of ${range.count}`, 50, doc.page.height - 40, { width: W, align: "center", lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}
