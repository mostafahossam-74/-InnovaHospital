// Monthly Executive Report snapshot (Handoff §5). Built deterministically from
// the database as of the end of the reporting month, so rebuilding it later
// gives the same digest unless an input changed; approval and release compare
// a fresh build against the stored one.
import type { Client } from "../db.ts";
import { gateProblems } from "../api-office.ts";

const monthEnd = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const addDays = (iso: string, d: number) => new Date(Date.parse(iso) + d * 86400000).toISOString().slice(0, 10);
const median = (v: number[]) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const r2 = (v: number) => Math.round(v * 100) / 100;
const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export type IndicatorStatus = "missing" | "unverified" | "returned" | "not_applicable" | "suppressed" | "verified";

export async function buildSnapshot(c: Client, wsId: string, period: string) {
  const end = monthEnd(period), start = `${period}-01`;
  const ws = (await c.query("SELECT name, country, currency, small_cell, timezone FROM workspace WHERE id = $1", [wsId])).rows[0];
  const small = ws.small_cell as number;
  const depts = (await c.query("SELECT id, code, name FROM department WHERE active AND reporting_inclusion ORDER BY name")).rows;

  // ---- Research funnel --------------------------------------------------------
  const ideaCounts = (await c.query("SELECT status, count(*)::int AS n FROM idea GROUP BY status ORDER BY status")).rows;
  const triage = (await c.query(`
    WITH firsts AS (
      SELECT idea_id, min(created_at) FILTER (WHERE to_status = 'submitted') AS submitted_at,
             min(created_at) FILTER (WHERE from_status = 'submitted' AND to_status IN ('returned','feasibility','rejected','deferred')) AS triaged_at
      FROM idea_history GROUP BY idea_id)
    SELECT extract(epoch FROM triaged_at - submitted_at) / 86400 AS days FROM firsts
    WHERE triaged_at::date BETWEEN $1 AND $2 AND submitted_at IS NOT NULL`, [start, end])).rows.map((x) => Number(x.days));
  const fromGaps = (await c.query("SELECT count(*)::int AS n FROM idea WHERE source_gap_id IS NOT NULL")).rows[0].n;

  // ---- Portfolio ------------------------------------------------------------------
  const stages = (await c.query("SELECT stage, count(*)::int AS projects FROM project GROUP BY stage ORDER BY stage")).rows;
  const activated = (await c.query("SELECT count(DISTINCT project_id)::int AS n FROM project_stage_history WHERE to_stage = 'active' AND created_at::date BETWEEN $1 AND $2", [start, end])).rows[0].n;
  const byCategory = (await c.query("SELECT study_category, count(*)::int AS n FROM project WHERE stage NOT IN ('archived') GROUP BY study_category ORDER BY study_category")).rows;

  // ---- Milestones -----------------------------------------------------------------
  const ms = (await c.query("SELECT state, due_date, completed_date FROM milestone WHERE due_date BETWEEN $1 AND $2", [start, end])).rows.filter((m) => m.state !== "cancelled");
  const onTime = ms.filter((m) => m.state === "done" && m.completed_date <= m.due_date).length;
  const overdue = (await c.query(`SELECT m.title, m.owner, m.due_date, p.title AS project FROM milestone m JOIN project p ON p.id = m.project_id
    WHERE m.state NOT IN ('done','cancelled') AND m.due_date <= $1 ORDER BY m.due_date, m.title`, [end])).rows;

  // ---- Outputs, training, partnerships --------------------------------------------
  const outputs = (await c.query(`SELECT output_type, count(*) FILTER (WHERE status IN ('approved','submitted','accepted','published','released'))::int AS approved,
      count(*) FILTER (WHERE submitted_date BETWEEN $1 AND $2)::int AS submitted_in_period,
      count(*) FILTER (WHERE published_date BETWEEN $1 AND $2)::int AS published_in_period
    FROM research_output GROUP BY output_type ORDER BY output_type`, [start, end])).rows;
  const training = (await c.query("SELECT coalesce(sum(enrolled),0)::int AS enrolled, coalesce(sum(completed),0)::int AS completed FROM training_cohort WHERE start_date <= $1", [end])).rows[0];
  const partnerships = (await c.query(`SELECT stage, currency, count(*)::int AS n, coalesce(sum(amount),0)::float8 AS value FROM partnership
    GROUP BY stage, currency ORDER BY stage, currency`)).rows;

  // ---- Quality indicators (with disclosure control) ------------------------------
  const defs = (await c.query("SELECT id, code, name, def_version, target_bp, direction FROM indicator_definition WHERE active ORDER BY code")).rows;
  const obs = (await c.query("SELECT definition_id, department_id, numerator, denominator, status, input_version FROM indicator_observation WHERE period = $1", [period])).rows;
  const indicators = [];
  for (const d of defs) for (const dep of depts) {
    const o = obs.find((x) => x.definition_id === d.id && x.department_id === dep.id);
    const item: Record<string, unknown> = { department: dep.name, code: d.code, name: d.name, definition_version: d.def_version };
    let status: IndicatorStatus;
    if (!o) status = "missing";
    else if (o.status === "returned") status = "returned";
    else if (o.status !== "verified") status = "unverified";
    else if (o.denominator === 0) status = "not_applicable"; // zero eligible cases differs from missing data
    else if (o.numerator < small || o.denominator - o.numerator < small) status = "suppressed"; // numerator and complement
    else status = "verified";
    item.status = status;
    if (o) item.input_version = o.input_version;
    if (status === "verified") {
      const pct = (100 * o.numerator) / o.denominator;
      item.numerator = o.numerator; item.denominator = o.denominator; item.percent = r2(pct);
      if (d.target_bp !== null) {
        item.target_percent = d.target_bp / 100;
        // Exact integer comparison, no rounding (Handoff §5 step 3).
        item.meets_target = d.direction === "higher_better" ? o.numerator * 10000 >= o.denominator * d.target_bp : o.numerator * 10000 <= o.denominator * d.target_bp;
      }
    }
    indicators.push(item);
  }
  const applicable = indicators.filter((i) => i.status !== "not_applicable");
  const completeness = applicable.length ? r2((100 * applicable.filter((i) => ["verified", "suppressed"].includes(i.status as string)).length) / applicable.length) : null;

  // ---- Research intelligence from hospital data -------------------------------------
  const analysis = (await c.query(`SELECT id, period_from, period_to, sha256, results->'summary' AS summary, results->'conditions' AS conditions
    FROM analysis_run WHERE period_to <= $1 ORDER BY period_to DESC, created_at DESC LIMIT 1`, [period])).rows[0];
  let intelligence: Record<string, unknown> | null = null;
  if (analysis) {
    const conditions = (analysis.conditions as any[]).slice(0, 8).map((x) => x.cases < small
      ? { condition_code: x.condition_code, condition_label: x.condition_label, status: "suppressed" }
      : { condition_code: x.condition_code, condition_label: x.condition_label, cases: x.cases, share_percent: r2(x.share * 100),
          mortality_percent: x.mortality && x.mortality.events >= small && x.mortality.n - x.mortality.events >= small ? r2(x.mortality.rate * 100) : null });
    const gaps = (await c.query(`SELECT title, gap_type, study_category, priority_score::float8 AS priority_score, status FROM research_gap
      WHERE analysis_id = $1 AND status = 'confirmed' ORDER BY priority_score DESC, title LIMIT 10`, [analysis.id])).rows;
    const pending = (await c.query("SELECT count(*)::int AS n FROM research_gap WHERE analysis_id = $1 AND status = 'proposed'", [analysis.id])).rows[0].n;
    const byType = (await c.query("SELECT gap_type, count(*)::int AS n FROM research_gap WHERE analysis_id = $1 GROUP BY gap_type ORDER BY gap_type", [analysis.id])).rows;
    intelligence = { analysis_id: analysis.id, analysis_sha256: analysis.sha256, covers: `${analysis.period_from} to ${analysis.period_to}`,
      total_cases: analysis.summary.total_cases, top_conditions: conditions, confirmed_gaps: gaps, gaps_awaiting_review: pending, gaps_by_type: byType,
      ideas_from_gaps: fromGaps };
  }

  // ---- Risks ---------------------------------------------------------------------
  const onHold = (await c.query("SELECT id, title, pi, hold_reason FROM project WHERE stage = 'on_hold' ORDER BY title")).rows;
  const expiring = (await c.query(`SELECT p.title, g.kind, g.expiry_date FROM governance_decision g JOIN project p ON p.id = g.project_id
    WHERE NOT g.superseded AND p.stage IN ('active','governance') AND g.expiry_date BETWEEN $1 AND $2 ORDER BY g.expiry_date, p.title`, [end, addDays(end, 60)])).rows;
  const activeProjects = (await c.query("SELECT id, title, protocol_version, stage FROM project WHERE stage = 'active' ORDER BY title")).rows;
  const gateRisks = [];
  for (const p of activeProjects) {
    const problems = await gateProblems(c, p.id, p.protocol_version, end);
    if (problems.length) gateRisks.push({ project: p.title, problems });
  }

  // ---- 30-day actions (owner, due date, status) -----------------------------------
  const due = addDays(end, 30);
  const actions: { action: string; owner: string; due_date: string; status: string; source: string }[] = [];
  for (const i of indicators) if (["missing", "unverified", "returned"].includes(i.status as string))
    actions.push({ action: `${i.status === "missing" ? "Submit" : i.status === "returned" ? "Correct and resubmit" : "Verify"} ${i.name} for ${i.department}`,
      owner: i.status === "unverified" ? "Indicator verifier" : `${i.department} data steward`, due_date: addDays(end, 10), status: "open", source: `indicator:${i.code}` });
  if (intelligence && (intelligence.gaps_awaiting_review as number) > 0)
    actions.push({ action: `Review ${intelligence.gaps_awaiting_review} proposed research gaps`, owner: "InnovaStat reviewer", due_date: addDays(end, 14), status: "open", source: "gaps" });
  for (const p of onHold) actions.push({ action: `Resolve hold on "${p.title}"`, owner: "Principal investigator", due_date: due, status: "open", source: `project:${p.id}` });
  for (const m of overdue) actions.push({ action: `Complete overdue milestone "${m.title}" (${m.project})`, owner: "Milestone owner", due_date: addDays(end, 14), status: "open", source: "milestone" });
  for (const e of expiring) actions.push({ action: `Renew ${e.kind} approval for "${e.title}" (expires ${e.expiry_date})`, owner: "Governance recorder", due_date: e.expiry_date < due ? e.expiry_date : due, status: "open", source: "governance" });

  const verified = indicators.filter((i) => i.status === "verified");
  const active = stages.find((x) => x.stage === "active")?.projects ?? 0;
  const ideasTotal = ideaCounts.reduce((sum, x) => sum + x.n, 0);
  const withTarget = verified.filter((i) => i.meets_target !== undefined);
  const summary = [
    `${n(active, "project")} active at cutoff; ${activated} activated during ${period}.`,
    `${n(ideasTotal, "research idea")} in the pipeline${fromGaps ? `, ${fromGaps} generated from hospital-data research gaps` : ""}.`,
    verified.length ? `${withTarget.filter((i) => i.meets_target).length} of ${n(withTarget.length, "verified indicator")} met target; indicator completeness ${completeness}%.` : `No verified quality indicators for ${period}.`,
    intelligence ? `Hospital data (${intelligence.covers}, ${intelligence.total_cases} cases) yielded ${n((intelligence.confirmed_gaps as unknown[]).length, "confirmed research gap")}; ${intelligence.gaps_awaiting_review} awaiting review.` : "No hospital-data analysis covers this period yet.",
    `${n(onHold.length, "project")} on hold, ${n(overdue.length, "overdue milestone")}, ${n(expiring.length, "approval")} expiring within 60 days.`,
  ];

  return {
    period, cutoff: end, hospital: ws.name, country: ws.country, currency: ws.currency, disclosure_threshold: small,
    executive_summary: summary,
    funnel: { ideas_by_status: ideaCounts, triaged_in_period: triage.length, median_triage_days: triage.length ? r2(median(triage)!) : null, ideas_from_gaps: fromGaps },
    portfolio: { by_stage: stages, activated_in_period: activated, by_category: byCategory },
    milestones: { due_in_period: ms.length, completed_on_time: onTime, on_time_rate_percent: ms.length ? r2((100 * onTime) / ms.length) : null, overdue_unresolved: overdue.length },
    outputs, training: { ...training, completion_percent: training.enrolled ? r2((100 * training.completed) / training.enrolled) : null },
    partnerships, indicators, indicator_completeness_percent: completeness,
    research_intelligence: intelligence,
    risks: { on_hold: onHold.map((p) => ({ project: p.title, reason: p.hold_reason })), approvals_expiring: expiring, approval_problems: gateRisks },
    actions,
    limitations: [
      "Aggregate data only: no patient-level records are held. Associations from hospital data are unadjusted and do not show causation.",
      `Cells with fewer than ${small} events or non-events are suppressed.`,
      "Missing, unverified, not-applicable and suppressed values are excluded from target comparisons.",
    ],
  };
}
export type Snapshot = Awaited<ReturnType<typeof buildSnapshot>>;
