// Hospital data and analytics routes: aggregate uploads with independent
// verification, frozen analysis runs, the research-gap register and research
// ideas generated from confirmed gaps.
import { z } from "zod";
import type { Client } from "./db.ts";
import { audit, sha256 } from "./db.ts";
import { ApiError } from "./http.ts";
import { actorId, can, departmentScope, STAFF } from "./auth.ts";
import type { Role, WorkspaceAccess } from "./auth.ts";
import { conflict, forbidden, idParam, notFound, period, text, uuid, version, W } from "./api-common.ts";
import type { RouteDeps } from "./api-common.ts";
import { analyze, DEFAULT_CONFIG } from "./analytics/engine.ts";
import type { CaseRow, ParamRow, PortfolioItem } from "./analytics/engine.ts";
import { detectGaps } from "./analytics/gaps.ts";
import { templateIdea } from "./analytics/ideas.ts";
import type { GapForIdea, IdeaDrafter, IdeaDraft } from "./analytics/ideas.ts";

export type DataDeps = { drafter: IdeaDrafter | null };

const SUBMITTERS: Role[] = ["data_steward", "coordinator"];
const VERIFIERS: Role[] = ["data_steward", "innovastat_reviewer", "research_director"];
const ANALYSTS: Role[] = ["coordinator", "innovastat_reviewer", "research_director"];
const GAP_DECIDERS: Role[] = ["innovastat_reviewer", "research_director"];
const IDEA_MAKERS: Role[] = ["coordinator", "investigator", "innovastat_reviewer", "research_director", "department_lead"];
const MAX_ROWS = 20000;

const count = z.number().int().min(0).max(10_000_000);
const caseRow = z.object({
  period, department: z.string().min(1).max(32),
  condition_code: z.string().regex(/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/, "ICD-10 code, e.g. I21 or I21.4"),
  condition_label: text(200), management: text(120),
  age_band: text(20).default("all"), sex: z.enum(["all", "female", "male"]).default("all"),
  cases: count, deaths: count.nullable().default(null), readmissions_30d: count.nullable().default(null),
  complications: count.nullable().default(null),
  los_days_sum: z.number().min(0).max(1e9).nullable().default(null), cost_sum: z.number().min(0).max(1e13).nullable().default(null),
}).strict().refine((r) => [r.deaths, r.readmissions_30d, r.complications].every((v) => v === null || v <= r.cases), "Events cannot exceed cases");
const paramRow = z.object({
  period, department: z.string().min(1).max(32),
  parameter_code: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/), parameter_label: text(200),
  value: z.number().finite(), unit: text(40).nullable().default(null),
}).strict();
const uploadBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("case_aggregates"), label: text(200), source_method: text(1000), evidence_reference: text(200).optional(),
    attestation: z.literal(true), rows: z.array(caseRow).min(1).max(MAX_ROWS) }).strict(),
  z.object({ kind: z.literal("parameters"), label: text(200), source_method: text(1000), evidence_reference: text(200).optional(),
    attestation: z.literal(true), rows: z.array(paramRow).min(1).max(MAX_ROWS) }).strict(),
]);

async function departmentsByCode(c: Client) {
  const { rows } = await c.query<{ id: string; code: string; name: string }>("SELECT id, code, name FROM department");
  return new Map(rows.map((d) => [d.code, d]));
}

async function insertChunks(c: Client, table: string, cols: string[], rows: unknown[][]) {
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    const values = chunk.map((_, ri) => `(${cols.map((__, ci) => `$${ri * cols.length + ci + 1}`).join(",")})`).join(",");
    await c.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${values}`, chunk.flat());
  }
}

function requireDepartments(access: WorkspaceAccess, roles: Role[], deptIds: string[]) {
  const outside = deptIds.filter((d) => !can(access, roles, d));
  if (outside.length) throw forbidden("Your grant does not cover every department in this upload");
}

export function registerDataRoutes({ r, scoped }: RouteDeps, deps: DataDeps) {
  // ---- Uploads ------------------------------------------------------------------
  r.on("POST", `${W}/uploads`, (ctx) => scoped(ctx, SUBMITTERS, async (c, me, wsId, access) => {
    const b = uploadBody.parse(await ctx.body());
    const depts = await departmentsByCode(c);
    const unknown = [...new Set(b.rows.map((x) => x.department))].filter((code) => !depts.has(code));
    if (unknown.length) throw new ApiError(422, "unknown_department", `Unknown department codes: ${unknown.join(", ")}`);
    requireDepartments(access, SUBMITTERS, [...new Set(b.rows.map((x) => depts.get(x.department)!.id))]);
    const periods = b.rows.map((x) => x.period).sort();
    const id = (await c.query(
      `INSERT INTO data_upload (workspace_id, kind, label, source_method, evidence_reference, attestation, period_from, period_to, row_count, sha256, submitted_by)
       VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8,$9,$10) RETURNING id`,
      [wsId, b.kind, b.label, b.source_method, b.evidence_reference ?? null, periods[0], periods.at(-1), b.rows.length, sha256(b.rows), actorId(me)])).rows[0].id;
    try {
      if (b.kind === "case_aggregates") {
        await insertChunks(c, "case_aggregate", ["workspace_id", "upload_id", "period", "department_id", "condition_code", "condition_label", "management",
          "age_band", "sex", "cases", "deaths", "readmissions_30d", "complications", "los_days_sum", "cost_sum"],
          b.rows.map((x) => [wsId, id, x.period, depts.get(x.department)!.id, x.condition_code, x.condition_label, x.management, x.age_band, x.sex,
            x.cases, x.deaths, x.readmissions_30d, x.complications, x.los_days_sum, x.cost_sum]));
      } else {
        await insertChunks(c, "parameter_observation", ["workspace_id", "upload_id", "period", "department_id", "parameter_code", "parameter_label", "value", "unit"],
          b.rows.map((x) => [wsId, id, x.period, depts.get(x.department)!.id, x.parameter_code, x.parameter_label, x.value, x.unit]));
      }
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new ApiError(422, "duplicate_rows", "The upload repeats a cell (same period, department, condition, management and stratum)");
      throw e;
    }
    await audit(c, wsId, actorId(me), "upload.submit", "data_upload", id, { kind: b.kind, rows: b.rows.length }, ctx.requestId);
    return { status: 201, body: { id, row_count: b.rows.length, period_from: periods[0], period_to: periods.at(-1), status: "submitted" } };
  }));

  r.on("GET", `${W}/uploads`, (ctx) => scoped(ctx, STAFF, async (c) => {
    const { rows } = await c.query(`SELECT u.id, u.kind, u.label, u.source_method, u.evidence_reference, u.period_from, u.period_to, u.row_count,
        u.sha256, u.status, u.submitted_by, u.verified_by, u.verified_at, u.review_note, u.version, u.created_at,
        (SELECT array_agg(DISTINCT d.name ORDER BY d.name) FROM department d WHERE d.id IN (
           SELECT department_id FROM case_aggregate WHERE upload_id = u.id UNION SELECT department_id FROM parameter_observation WHERE upload_id = u.id)) AS departments
      FROM data_upload u ORDER BY u.created_at DESC LIMIT 200`);
    return { body: { items: rows } };
  }));

  r.on("GET", `${W}/uploads/{id}`, (ctx) => scoped(ctx, STAFF, async (c) => {
    const id = idParam(ctx);
    const u = (await c.query("SELECT * FROM data_upload WHERE id = $1", [id])).rows[0];
    if (!u) throw notFound("Upload");
    const rows = u.kind === "case_aggregates"
      ? (await c.query(`SELECT a.period, d.code AS department, a.condition_code, a.condition_label, a.management, a.age_band, a.sex, a.cases,
          a.deaths, a.readmissions_30d, a.complications, a.los_days_sum::float8 AS los_days_sum, a.cost_sum::float8 AS cost_sum
          FROM case_aggregate a JOIN department d ON d.id = a.department_id WHERE a.upload_id = $1
          ORDER BY a.period, d.code, a.condition_code, a.management LIMIT 500`, [id])).rows
      : (await c.query(`SELECT p.period, d.code AS department, p.parameter_code, p.parameter_label, p.value::float8 AS value, p.unit
          FROM parameter_observation p JOIN department d ON d.id = p.department_id WHERE p.upload_id = $1 ORDER BY p.period, d.code, p.parameter_code LIMIT 500`, [id])).rows;
    return { body: { ...u, rows_preview: rows } };
  }));

  r.on("POST", `${W}/uploads/{id}/verify`, (ctx) => scoped(ctx, VERIFIERS, async (c, me, wsId, access) => {
    const b = z.object({ decision: z.enum(["verified", "returned"]), note: text(2000).optional(), expected_version: version }).strict()
      .refine((x) => x.decision === "verified" || x.note, { message: "A note is required to return an upload", path: ["note"] }).parse(await ctx.body());
    const id = idParam(ctx);
    const u = (await c.query("SELECT * FROM data_upload WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!u) throw notFound("Upload");
    if (u.version !== b.expected_version) throw conflict("upload");
    if (u.status !== "submitted") throw new ApiError(409, "invalid_state", `The upload is ${u.status}`);
    if (u.submitted_by === actorId(me)) throw forbidden("The person who submitted data cannot verify it");
    const deptIds = (await c.query(`SELECT DISTINCT department_id FROM case_aggregate WHERE upload_id = $1
      UNION SELECT DISTINCT department_id FROM parameter_observation WHERE upload_id = $1`, [id])).rows.map((x) => x.department_id);
    requireDepartments(access, VERIFIERS, deptIds);
    await c.query("UPDATE data_upload SET status = $2, verified_by = $3, verified_at = now(), review_note = $4, version = version + 1 WHERE id = $1",
      [id, b.decision, b.decision === "verified" ? actorId(me) : null, b.note ?? null]);
    await audit(c, wsId, actorId(me), `upload.${b.decision}`, "data_upload", id, {}, ctx.requestId, b.note);
    return { body: { id, status: b.decision } };
  }));

  // ---- Analyses -----------------------------------------------------------------
  const analysisBody = z.object({
    period_from: period, period_to: period,
    department_ids: z.array(uuid).max(200).optional(),
    min_cases: z.number().int().min(5).max(10000).optional(),
    alpha: z.number().min(0.001).max(0.2).optional(),
    high_burden_share: z.number().min(0.005).max(0.5).optional(),
  }).strict().refine((x) => x.period_from <= x.period_to, { message: "period_from must not be after period_to", path: ["period_to"] });

  r.on("POST", `${W}/analyses`, (ctx) => scoped(ctx, ANALYSTS, async (c, me, wsId) => {
    const b = analysisBody.parse(await ctx.body());
    const ws = (await c.query("SELECT name, currency FROM workspace WHERE id = $1", [wsId])).rows[0];
    const depts = b.department_ids ?? (await c.query("SELECT id FROM department WHERE reporting_inclusion")).rows.map((x) => x.id);
    // Newest verified upload wins for each department-month (corrections replace earlier data).
    const caseRows = (await c.query<CaseRow & { upload_id: string }>(`
      WITH latest AS (
        SELECT DISTINCT ON (a.department_id, a.period) a.department_id, a.period, a.upload_id
        FROM case_aggregate a JOIN data_upload u ON u.id = a.upload_id
        WHERE u.status = 'verified' AND a.period BETWEEN $1 AND $2 AND a.department_id = ANY($3)
        ORDER BY a.department_id, a.period, u.verified_at DESC)
      SELECT a.period, a.department_id, d.name AS department, a.condition_code, a.condition_label, a.management, a.cases, a.deaths,
        a.readmissions_30d, a.complications, a.los_days_sum::float8 AS los_days_sum, a.cost_sum::float8 AS cost_sum, a.upload_id
      FROM case_aggregate a JOIN latest l USING (department_id, period, upload_id) JOIN department d ON d.id = a.department_id
      ORDER BY a.period, d.name, a.condition_code, a.management, a.age_band, a.sex`, [b.period_from, b.period_to, depts])).rows;
    const paramRows = (await c.query<ParamRow & { upload_id: string }>(`
      SELECT DISTINCT ON (p.department_id, p.period, p.parameter_code) p.period, p.department_id, d.name AS department, p.parameter_code,
        p.parameter_label, p.value::float8 AS value, p.unit, p.upload_id
      FROM parameter_observation p JOIN data_upload u ON u.id = p.upload_id JOIN department d ON d.id = p.department_id
      WHERE u.status = 'verified' AND p.period BETWEEN $1 AND $2 AND p.department_id = ANY($3)
      ORDER BY p.department_id, p.period, p.parameter_code, u.verified_at DESC`, [b.period_from, b.period_to, depts])).rows;
    if (!caseRows.length) throw new ApiError(422, "no_verified_data", "No verified case data covers this period and these departments");
    const portfolio: PortfolioItem[] = [
      ...(await c.query("SELECT title, condition_codes, stage AS status FROM project WHERE stage <> 'archived'")).rows.map((p) => ({ kind: "project" as const, ...p })),
      ...(await c.query("SELECT title, condition_codes, status FROM idea WHERE status NOT IN ('rejected','converted')")).rows.map((p) => ({ kind: "idea" as const, ...p })),
    ];
    const cfg = { ...DEFAULT_CONFIG, currency: ws.currency, ...Object.fromEntries(Object.entries({ min_cases: b.min_cases, alpha: b.alpha, high_burden_share: b.high_burden_share }).filter(([, v]) => v !== undefined)) };
    const results = analyze(caseRows.map(({ upload_id, ...x }) => x), paramRows.map(({ upload_id, ...x }) => x), portfolio, cfg);
    const uploadIds = [...new Set([...caseRows, ...paramRows].map((x) => x.upload_id))].sort();
    const id = (await c.query(`INSERT INTO analysis_run (workspace_id, period_from, period_to, department_ids, upload_ids, config, engine_version, results, sha256, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [wsId, b.period_from, b.period_to, depts, uploadIds, cfg, results.engine_version, results, sha256(results), actorId(me)])).rows[0].id;
    const gaps = detectGaps(results);
    const deptIdOk = new Set(depts);
    for (const g of gaps) {
      await c.query(`INSERT INTO research_gap (workspace_id, analysis_id, gap_key, gap_type, study_category, title, statement, condition_code, condition_label,
          department_id, metrics, priority_score, suggested_designs, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [wsId, id, g.gap_key, g.gap_type, g.study_category, g.title, g.statement, g.condition_code, g.condition_label,
          g.department_id && deptIdOk.has(g.department_id) ? g.department_id : null, g.metrics, g.priority_score, g.suggested_designs, actorId(me)]);
    }
    await audit(c, wsId, actorId(me), "analysis.run", "analysis_run", id, { uploads: uploadIds.length, gaps: gaps.length }, ctx.requestId);
    return { status: 201, body: { id, summary: results.summary, gaps: gaps.length } };
  }));

  r.on("GET", `${W}/analyses`, (ctx) => scoped(ctx, STAFF, async (c) => {
    const { rows } = await c.query(`SELECT a.id, a.period_from, a.period_to, a.engine_version, a.sha256, a.created_by, a.created_at,
        a.results->'summary' AS summary, (SELECT count(*)::int FROM research_gap g WHERE g.analysis_id = a.id) AS gaps
      FROM analysis_run a ORDER BY a.created_at DESC LIMIT 100`);
    return { body: { items: rows } };
  }));

  r.on("GET", `${W}/analyses/{id}`, (ctx) => scoped(ctx, STAFF, async (c) => {
    const a = (await c.query("SELECT * FROM analysis_run WHERE id = $1", [idParam(ctx)])).rows[0];
    if (!a) throw notFound("Analysis");
    return { body: a };
  }));

  // ---- Research gaps --------------------------------------------------------------
  r.on("GET", `${W}/gaps`, (ctx) => scoped(ctx, STAFF, async (c) => {
    const status = ctx.query.get("status"), analysis = ctx.query.get("analysis_id"), type = ctx.query.get("gap_type");
    const latest = ctx.query.get("latest") !== "false";
    const { rows } = await c.query(`SELECT g.*, d.name AS department,
        (SELECT count(*)::int FROM idea i WHERE i.source_gap_id = g.id) AS ideas
      FROM research_gap g LEFT JOIN department d ON d.id = g.department_id
      WHERE ($1::text IS NULL OR g.status = $1) AND ($2::uuid IS NULL OR g.analysis_id = $2) AND ($3::text IS NULL OR g.gap_type = $3)
        AND ($2::uuid IS NOT NULL OR NOT $4 OR g.analysis_id = (SELECT id FROM analysis_run ORDER BY created_at DESC LIMIT 1) OR g.status <> 'proposed')
      ORDER BY g.priority_score DESC, g.created_at DESC LIMIT 300`, [status, analysis, type, latest]);
    return { body: { items: rows } };
  }));

  r.on("GET", `${W}/gaps/{id}`, (ctx) => scoped(ctx, STAFF, async (c) => {
    const g = (await c.query("SELECT g.*, d.name AS department FROM research_gap g LEFT JOIN department d ON d.id = g.department_id WHERE g.id = $1", [idParam(ctx)])).rows[0];
    if (!g) throw notFound("Gap");
    g.ideas = (await c.query("SELECT id, title, status, origin, created_at FROM idea WHERE source_gap_id = $1 ORDER BY created_at", [g.id])).rows;
    return { body: g };
  }));

  r.on("POST", `${W}/gaps/{id}/decision`, (ctx) => scoped(ctx, GAP_DECIDERS, async (c, me, wsId) => {
    const b = z.object({ status: z.enum(["confirmed", "rejected", "deferred"]), reason: text(4000), expected_version: version }).strict().parse(await ctx.body());
    const id = idParam(ctx);
    const g = (await c.query("SELECT * FROM research_gap WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!g) throw notFound("Gap");
    if (g.version !== b.expected_version) throw conflict("gap");
    if (g.created_by === actorId(me)) throw forbidden("The person who ran the analysis cannot decide its gaps");
    await c.query("UPDATE research_gap SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4, version = version + 1 WHERE id = $1",
      [id, b.status, actorId(me), b.reason]);
    await audit(c, wsId, actorId(me), `gap.${b.status}`, "research_gap", id, {}, ctx.requestId, b.reason);
    return { body: { id, status: b.status, version: g.version + 1 } };
  }));

  r.on("POST", `${W}/gaps/{id}/ideas`, (ctx) => scoped(ctx, IDEA_MAKERS, async (c, me, wsId, access) => {
    const b = z.object({ mode: z.enum(["template", "claude"]).default("template"), department_id: uuid, pi: text(500).optional() }).strict().parse(await ctx.body());
    const g = (await c.query("SELECT * FROM research_gap WHERE id = $1", [idParam(ctx)])).rows[0];
    if (!g) throw notFound("Gap");
    if (g.status !== "confirmed") throw new ApiError(409, "gap_not_confirmed", "Ideas are drafted from confirmed gaps only");
    if (!can(access, IDEA_MAKERS, b.department_id)) throw forbidden("Your grant does not cover this department");
    if (!(await c.query("SELECT 1 FROM department WHERE id = $1", [b.department_id])).rowCount) throw notFound("Department");
    const ws = (await c.query("SELECT name, currency FROM workspace WHERE id = $1", [wsId])).rows[0];
    const input: GapForIdea = { id: g.id, gap_type: g.gap_type, study_category: g.study_category, title: g.title, statement: g.statement,
      condition_code: g.condition_code, condition_label: g.condition_label, metrics: g.metrics, suggested_designs: g.suggested_designs,
      hospital: ws.name, currency: ws.currency };
    let draft: IdeaDraft = templateIdea(input), origin = "engine", problems: string[] = [];
    if (b.mode === "claude") {
      if (!deps.drafter) throw new ApiError(503, "drafter_unavailable", "Claude drafting is not configured (set INNOVA_ANTHROPIC_API_KEY)");
      const res = await deps.drafter.draft(input);
      if (res.draft) { draft = res.draft; origin = "claude"; } else problems = res.problems; // deterministic template fallback
    }
    const volume = g.metrics?.n !== undefined ? Number(g.metrics.n) + Number(g.metrics.n_ref ?? 0) : g.metrics?.cases ?? null;
    const id = (await c.query(`INSERT INTO idea (workspace_id, department_id, title, research_question, rationale, design, study_category, population,
        data_sources, primary_outcome, comparator, analysis_plan, economic_method, expected_output, aggregate_volume, condition_codes, source_gap_id,
        origin, pi, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
      [wsId, b.department_id, draft.title, draft.research_question, draft.rationale, draft.design, draft.study_category, draft.population,
        draft.data_sources, draft.primary_outcome, draft.comparator, draft.analysis_plan, draft.economic_method, draft.expected_output,
        Number.isFinite(volume) ? volume : null, g.condition_code ? [g.condition_code] : [], g.id, origin, b.pi ?? actorId(me), actorId(me)])).rows[0].id;
    await audit(c, wsId, actorId(me), "idea.generate", "idea", id, { gap: g.id, origin, problems }, ctx.requestId);
    return { status: 201, body: { id, origin, fallback_reasons: problems, ...draft } };
  }));

  // Department-scoped readers use this to know which departments they may act in.
  r.on("GET", `${W}/my-scope`, (ctx) => scoped(ctx, STAFF, async (_c, _me, _ws, access) => ({
    body: { roles: [...access.roles].sort(), departments_for: Object.fromEntries([...access.roles].map((role) => [role, departmentScope(access, [role])])) },
  })));
}
