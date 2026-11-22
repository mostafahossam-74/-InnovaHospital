// Executive report snapshot (Handoff §5) for the months a coordinator chooses. Built
// deterministically from the database as of the end of the last month, so rebuilding it later
// gives the same digest unless an input changed; approval and release compare
// a fresh build against the stored one.
import type { Client } from "../db.ts";
import { gateProblems } from "../api-office.ts";
import { meetsCompletionRule } from "../api-training.ts";
import { findLeak, pooledIndicator } from "./disclosure.ts";
import { parseReportKey } from "../period.ts";
import type { DepartmentCell, Figure } from "./disclosure.ts";

const monthEnd = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const addDays = (iso: string, d: number) => new Date(Date.parse(iso) + d * 86400000).toISOString().slice(0, 10);
const median = (v: number[]) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const r2 = (v: number) => Math.round(v * 100) / 100;
const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export type IndicatorStatus = "missing" | "unverified" | "returned" | "not_applicable" | "suppressed" | "verified";

/** `period` is the report key: one month (YYYY-MM) or a range (YYYY-MM_YYYY-MM). Data is monthly. */
export async function buildSnapshot(c: Client, wsId: string, period: string) {
  const range = parseReportKey(period);
  const end = monthEnd(range.end), start = `${range.start}-01`, label = range.label;
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
  const fromGaps = (await c.query("SELECT count(*)::int AS n FROM idea WHERE source_gap_id IS NOT NULL OR origin IN ('engine','claude')")).rows[0].n;

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
  // Training completion (Handoff §5 KPI): people meeting their cohort's completion rule, divided by the
  // eligible people: enrolled, not withdrawn, in cohorts that ended during the report's months.
  // Cohorts recorded before person records count with the numbers entered for them.
  const cohorts = (await c.query(`SELECT c.*, (SELECT count(*) FROM training_enrollment e WHERE e.cohort_id = c.id)::int AS records
    FROM training_cohort c WHERE c.end_date BETWEEN $1 AND $2 ORDER BY c.end_date, c.title`, [start, end])).rows;
  const trainees = cohorts.length ? (await c.query("SELECT cohort_id, state, attended_sessions, score FROM training_enrollment WHERE state <> 'withdrawn' AND cohort_id = ANY($1)",
    [cohorts.map((x) => x.id)])).rows : [];
  const trainingCohorts = cohorts.map((co) => {
    if (!co.records) return { title: co.title, end_date: co.end_date, source: "counts", eligible: co.enrolled, completed: co.completed, awaiting_decision: null };
    const mine = trainees.filter((t) => t.cohort_id === co.id);
    return { title: co.title, end_date: co.end_date, source: "records", eligible: mine.length,
      completed: mine.filter((t) => meetsCompletionRule(co, t).meets).length,
      awaiting_decision: mine.filter((t) => !["completed", "incomplete"].includes(t.state)).length };
  });
  const sumOf = (k: "eligible" | "completed" | "awaiting_decision") => trainingCohorts.reduce((s, x) => s + (x[k] ?? 0), 0);
  const training = { cohorts_ended: trainingCohorts.length, eligible: sumOf("eligible"), completed: sumOf("completed"), awaiting_decision: sumOf("awaiting_decision"), cohorts: trainingCohorts };
  const partnerships = (await c.query(`SELECT stage, currency, count(*)::int AS n, coalesce(sum(amount),0)::float8 AS value FROM partnership
    GROUP BY stage, currency ORDER BY stage, currency`)).rows;

  // ---- Quality indicators (with disclosure control) ------------------------------
  const defs = (await c.query("SELECT id, code, name, def_version, target_bp, direction FROM indicator_definition WHERE active ORDER BY code")).rows;
  const obs = (await c.query(`SELECT definition_id, department_id, period, numerator, denominator, status, input_version FROM indicator_observation
    WHERE period BETWEEN $1 AND $2 ORDER BY period`, [range.start, range.end])).rows;
  const indicators: Record<string, unknown>[] = [];
  const indicatorTotals: Record<string, unknown>[] = [];
  // Reports released before (published, later superseded or withdrawn): what readers have already
  // seen, so this report cannot be combined with them to reveal a small count (overlapping ranges).
  const released = (await c.query(`SELECT period, snapshot FROM report_revision WHERE published_at IS NOT NULL AND period <> $1 ORDER BY period, revision`, [period])).rows
    .map((r) => ({ months: parseReportKey(r.period).months, snapshot: r.snapshot }));
  for (const d of defs) {
    const cells: DepartmentCell[] = [];
    const rows: Record<string, unknown>[] = [];
    for (const dep of depts) {
      // The department's months in the range, added up once every month is in and verified.
      const mine = obs.filter((x) => x.definition_id === d.id && x.department_id === dep.id);
      const o = mine.length ? { numerator: mine.reduce((sum, x) => sum + x.numerator, 0), denominator: mine.reduce((sum, x) => sum + x.denominator, 0) } : null;
      const item: Record<string, unknown> = { department: dep.name, code: d.code, name: d.name, definition_version: d.def_version };
      let status: IndicatorStatus;
      if (mine.length < range.months.length) status = "missing";
      else if (mine.some((x) => x.status === "returned")) status = "returned";
      else if (mine.some((x) => x.status !== "verified")) status = "unverified";
      else if (o!.denominator === 0) status = "not_applicable"; // zero eligible cases differs from missing data
      else if (o!.numerator < small || o!.denominator - o!.numerator < small) status = "suppressed"; // numerator and complement
      else status = "verified";
      item.status = status;
      if (range.months.length > 1 && mine.length < range.months.length) item.months_missing = range.months.filter((m) => !mine.some((x) => x.period === m));
      if (mine.length) item.input_version = range.months.length > 1 ? mine.map((x) => `${x.period}:${x.input_version}`).join(",") : mine[0].input_version;
      if (status === "verified") {
        const v = o!;
        item.numerator = v.numerator; item.denominator = v.denominator; item.percent = r2((100 * v.numerator) / v.denominator);
        if (d.target_bp !== null) {
          item.target_percent = d.target_bp / 100;
          // Exact integer comparison, no rounding (Handoff §5 step 3).
          item.meets_target = d.direction === "higher_better" ? v.numerator * 10000 >= v.denominator * d.target_bp : v.numerator * 10000 <= v.denominator * d.target_bp;
        }
      }
      rows.push(item);
      cells.push({ status, numerator: o ? o.numerator : null, denominator: o ? o.denominator : null });
    }
    // Hospital-wide rate over the same definition version, hidden when it or the remainder
    // after subtracting the shown departments is small (differencing within the report).
    let total: Record<string, unknown> = { code: d.code, name: d.name, definition_version: d.def_version, ...pooledIndicator(cells, small, d) };

    // Differencing across reports: hide figures that, combined with released reports, would reveal
    // a small count for some departments and months. One figure at a time, until nothing leaks.
    const mineReleased = released.map((r) => ({
      months: r.months,
      rows: (r.snapshot.indicators ?? []).filter((x: any) => x.code === d.code && x.definition_version === d.def_version),
      total: (r.snapshot.indicator_totals ?? []).find((x: any) => x.code === d.code && x.definition_version === d.def_version),
    })).filter((r) => r.rows.length);
    if (mineReleased.length) {
      const shownFig = (x: any) => typeof x?.numerator === "number" || x?.status === "not_applicable";
      // Figures as published (a not-applicable row shows 0 of 0).
      const nums = (x: any) => ({ numerator: x.numerator ?? 0, denominator: x.denominator ?? 0 });
      const oldFigs: Figure[] = mineReleased.flatMap((r) => [
        ...r.rows.filter(shownFig).map((x: any) => ({ depts: [x.department], months: r.months, ...nums(x) })),
        ...(shownFig(r.total) ? [{ depts: r.rows.map((x: any) => x.department), months: r.months, ...nums(r.total) }] : []),
      ]);
      for (let guard = 0; guard <= rows.length; guard++) {
        // The new report's figures, total first so it is the first to go.
        const newFigs: { fig: Figure; row: number | "total" }[] = [
          ...(shownFig(total) ? [{ fig: { depts: rows.map((x) => x.department as string), months: range.months, ...nums(total) }, row: "total" as const }] : []),
          ...rows.map((x, i) => ({ x, i })).filter(({ x }) => shownFig(x)).map(({ x, i }) => ({ fig: { depts: [x.department as string], months: range.months, ...nums(x) }, row: i })),
        ];
        const leak = findLeak(small, newFigs.map((f) => f.fig), oldFigs);
        if (!leak) break;
        const hide = newFigs[leak.figure].row;
        if (hide === "total") total = { code: d.code, name: d.name, definition_version: d.def_version, status: "suppressed", departments: rows.length, suppression_reason: "overlap" };
        else {
          const x = rows[hide];
          rows[hide] = { department: x.department, code: x.code, name: x.name, definition_version: x.definition_version, status: "suppressed", suppression_reason: "overlap", input_version: x.input_version };
          cells[hide] = { ...cells[hide], status: "suppressed" };
          if (shownFig(total)) total = { code: d.code, name: d.name, definition_version: d.def_version, ...pooledIndicator(cells, small, d) };
        }
      }
    }
    indicators.push(...rows);
    indicatorTotals.push(total);
  }
  const applicable = indicators.filter((i) => i.status !== "not_applicable");
  const completeness = applicable.length ? r2((100 * applicable.filter((i) => ["verified", "suppressed"].includes(i.status as string)).length) / applicable.length) : null;

  // ---- Research from InnovaStat: only what has been released to the hospital ---------------
  const releasedReports = (await c.query(`SELECT kind, count(*)::int AS n FROM client_report
    WHERE status IN ('released','hospital_approved','hospital_returned','superseded') AND released_at::date <= $1 GROUP BY kind ORDER BY kind`, [end])).rows;
  const ideasReleased = (await c.query(`SELECT p.title, p.study_category, p.status, p.priority::float8 AS priority FROM proposal p
    WHERE p.status IN ('released','approved','declined') ORDER BY p.priority DESC, p.title LIMIT 15`)).rows;
  const awaiting = ideasReleased.filter((x) => x.status === "released").length;
  const resultsAwaiting = (await c.query("SELECT count(*)::int AS n FROM client_report WHERE kind = 'results' AND status = 'released'")).rows[0].n;
  const manuscripts = (await c.query("SELECT status, count(*)::int AS n FROM manuscript WHERE status IN ('sent','hospital_accepted','hospital_returned') GROUP BY status ORDER BY status")).rows;
  const intelligence = releasedReports.length || ideasReleased.length ? {
    reports_released: releasedReports, ideas: ideasReleased, ideas_awaiting_decision: awaiting,
    ideas_approved: ideasReleased.filter((x) => x.status === "approved").length, results_awaiting_approval: resultsAwaiting, manuscripts,
  } : null;

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
  if (awaiting > 0) actions.push({ action: `Decide on ${n(awaiting, "research idea")} from InnovaStat`, owner: "Research director", due_date: addDays(end, 14), status: "open", source: "proposals" });
  if (resultsAwaiting > 0) actions.push({ action: `Review ${n(resultsAwaiting, "study results report")}`, owner: "Research director", due_date: addDays(end, 14), status: "open", source: "results" });
  for (const p of onHold) actions.push({ action: `Resolve hold on "${p.title}"`, owner: "Principal investigator", due_date: due, status: "open", source: `project:${p.id}` });
  for (const m of overdue) actions.push({ action: `Complete overdue milestone "${m.title}" (${m.project})`, owner: "Milestone owner", due_date: addDays(end, 14), status: "open", source: "milestone" });
  for (const t of trainingCohorts) if (t.awaiting_decision) actions.push({ action: `Record completion decisions for ${n(t.awaiting_decision, "person", "people")} in "${t.title}"`,
    owner: "Training manager", due_date: addDays(end, 14), status: "open", source: "training" });
  for (const e of expiring) actions.push({ action: `Renew ${e.kind} approval for "${e.title}" (expires ${e.expiry_date})`, owner: "Governance recorder", due_date: e.expiry_date < due ? e.expiry_date : due, status: "open", source: "governance" });

  const verified = indicators.filter((i) => i.status === "verified");
  const active = stages.find((x) => x.stage === "active")?.projects ?? 0;
  const ideasTotal = ideaCounts.reduce((sum, x) => sum + x.n, 0);
  const withTarget = verified.filter((i) => i.meets_target !== undefined);
  const summary = [
    `${n(active, "project")} active at cutoff; ${activated} activated during ${label}.`,
    `${n(ideasTotal, "research idea")} in the pipeline${fromGaps ? `, ${fromGaps} generated from hospital-data research gaps` : ""}.`,
    verified.length ? `${withTarget.filter((i) => i.meets_target).length} of ${n(withTarget.length, "verified indicator")} met target; indicator completeness ${completeness}%.` : `No verified quality indicators for ${label}.`,
    intelligence ? `InnovaStat has suggested ${n(ideasReleased.length, "research idea")} from hospital data: ${intelligence.ideas_approved} approved, ${awaiting} awaiting a decision.` : "No InnovaStat research report has been released yet.",
    `${n(onHold.length, "project")} on hold, ${n(overdue.length, "overdue milestone")}, ${n(expiring.length, "approval")} expiring within 60 days.`,
  ];

  return {
    period, period_start: range.start, period_end: range.end, period_label: label, months: range.months.length, cutoff: end, hospital: ws.name, country: ws.country, currency: ws.currency, disclosure_threshold: small,
    executive_summary: summary,
    funnel: { ideas_by_status: ideaCounts, triaged_in_period: triage.length, median_triage_days: triage.length ? r2(median(triage)!) : null, ideas_from_gaps: fromGaps },
    portfolio: { by_stage: stages, activated_in_period: activated, by_category: byCategory },
    milestones: { due_in_period: ms.length, completed_on_time: onTime, on_time_rate_percent: ms.length ? r2((100 * onTime) / ms.length) : null, overdue_unresolved: overdue.length },
    outputs, training: { ...training, enrolled: training.eligible, completion_percent: training.eligible ? r2((100 * training.completed) / training.eligible) : null },
    partnerships, indicators, indicator_totals: indicatorTotals, indicator_completeness_percent: completeness,
    research_intelligence: intelligence,
    risks: { on_hold: onHold.map((p) => ({ project: p.title, reason: p.hold_reason })), approvals_expiring: expiring, approval_problems: gateRisks },
    actions,
    limitations: [
      "Aggregate data only: no patient-level records are held. Associations from hospital data are unadjusted and do not show causation.",
      `Cells with fewer than ${small} events or non-events are suppressed. A figure is also suppressed when subtracting other figures, in this report or in reports already released, would reveal such a cell.`,
      "Missing, unverified, not-applicable and suppressed values are excluded from target comparisons.",
    ],
  };
}
export type Snapshot = Awaited<ReturnType<typeof buildSnapshot>>;
