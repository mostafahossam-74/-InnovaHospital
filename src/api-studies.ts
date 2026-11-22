// Study workbench (InnovaStat-internal) and the hospital report cycle.
//
//   hospital uploads Excel ─▶ [analyst + agent proposes, statistician confirms]:
//     data dictionary ─▶ cleaning + discovery/validation split ─▶ hypotheses ─▶
//     locked analysis plan ─▶ result on validation data ─▶ proposal (research idea)
//   ─▶ Gaps & Ideas report (statistician approves, InnovaStat releases)
//   ─▶ research director approves each idea ─▶ idea + project (ongoing study)
//   ─▶ Results report ─▶ research director approves ─▶ manuscript ─▶ sent.
//
// Hospital roles see their uploads' receipt status and, after release, the
// reports, the proposals in them and sent manuscripts. Everything else is
// internal to InnovaStat (analyst, statistician).
import { z } from "zod";
import type { Client } from "./db.ts";
import { audit, canonicalJson, sha256 } from "./db.ts";
import { ApiError } from "./http.ts";
import type { Ctx } from "./http.ts";
import { actorId, can, INTERNAL } from "./auth.ts";
import type { Identity, Role, WorkspaceAccess } from "./auth.ts";
import { conflict, forbidden, idempotent, idParam, notFound, text, uuid, version, W } from "./api-common.ts";
import type { RouteDeps } from "./api-common.ts";
import { clean, deidentify, dictionarySchema, MAX_COLUMNS, MAX_ROWS, parseCsv, parseWorkbook, profile, ruleDictionary, validateDictionary, variablesOf } from "./studies/data.ts";
import type { ColumnProfile, DictEntry, Raw } from "./studies/data.ts";
import { screen, templateInterpretation, templatePlan } from "./studies/hypotheses.ts";
import type { Hypothesis, Variable } from "./studies/hypotheses.ts";
import { OUTPUT, unsupported } from "./studies/agent.ts";
import type { AgentTask, StudyAgent } from "./studies/agent.ts";
import { PlanError, planSchema, runPlan } from "./stats/study.ts";
import type { Plan, Row } from "./stats/study.ts";
import { templateIdea } from "./analytics/ideas.ts";
import type { GapForIdea, IdeaDrafter } from "./analytics/ideas.ts";
import { gapsIdeasSnapshot, renderClientPdf, resultsSnapshot, templateManuscript } from "./studies/reports.ts";
import type { ObjectStore } from "./storage.ts";

export type StudyDeps = { agent: StudyAgent | null; drafter: IdeaDrafter | null; store: ObjectStore; deidKey: string; synthetic?: boolean };

const ANALYST: Role[] = ["innovastat_analyst", "innovastat_reviewer"];
const STATISTICIAN: Role[] = ["innovastat_reviewer"];
const UPLOADERS: Role[] = ["data_steward", "coordinator", "research_director", "hospital_admin", "innovastat_analyst", "innovastat_reviewer"];
const HOSPITAL_DECIDERS: Role[] = ["research_director", "hospital_admin"];
const isInternal = (a: WorkspaceAccess) => INTERNAL.some((r) => a.roles.has(r));
const mode = z.enum(["rules", "claude"]).default("rules");

/** The assigned statistician (or any statistician when none is assigned) confirms steps. */
function requireStatistician(access: WorkspaceAccess, me: Identity, ds: { statistician: string | null }) {
  if (!access.roles.has("innovastat_reviewer")) throw forbidden("A statistician confirms this step");
  if (ds.statistician && ds.statistician !== actorId(me)) throw forbidden("Only the statistician assigned to this dataset confirms its steps");
}

async function loadDataset(c: Client, id: string) {
  const d = (await c.query("SELECT * FROM study_dataset WHERE id = $1", [id])).rows[0];
  if (!d) throw notFound("Dataset");
  return d;
}

export function registerStudyRoutes({ r, scoped }: RouteDeps, deps: StudyDeps) {
  /** Runs an agent task, validates its output, logs the call; returns null (with reasons) to fall back to rules. */
  async function agentRun<T>(c: Client, wsId: string, me: Identity, task: AgentTask, subject: string | null, input: unknown, check: (out: any) => string[]): Promise<{ output: T | null; problems: string[] }> {
    if (!deps.agent) throw new ApiError(503, "agent_unavailable", "The Claude study agent is not configured (set INNOVA_ANTHROPIC_API_KEY); use the rule-based option");
    const a = await deps.agent.run(task, input);
    let problems = a.problems, output: T | null = null;
    if (a.output) {
      const parsed = OUTPUT[task].safeParse(a.output);
      if (!parsed.success) problems = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`);
      else { problems = check(parsed.data); if (!problems.length) output = parsed.data as T; }
    }
    await c.query(`INSERT INTO agent_call (workspace_id, task, subject_id, model, accepted, problems, input_tokens, output_tokens, requested_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [wsId, task, subject, a.model, output !== null, problems, a.input_tokens ?? null, a.output_tokens ?? null, actorId(me)]);
    return { output, problems };
  }

  // ---- Upload (hospital or InnovaStat) ------------------------------------------------------
  r.on("POST", `${W}/studies/datasets`, (ctx) => scoped(ctx, UPLOADERS, async (c, me, wsId, access) => {
    const q = ctx.query;
    const title = text(300).parse(q.get("title") ?? "");
    const dept = q.get("department_id");
    if (dept && !uuid.safeParse(dept).success) throw new ApiError(422, "invalid_input", "department_id must be a UUID");
    if (dept && !can(access, UPLOADERS, dept)) throw forbidden("Your grant does not cover this department");
    const fileName = (q.get("file_name") ?? "upload.xlsx").slice(0, 200);
    const type = String(ctx.req.headers["content-type"] ?? "");
    const buf = await ctx.raw();
    if (!buf.length) throw new ApiError(422, "empty_file", "The file is empty");
    let sheets;
    try {
      sheets = /csv/i.test(type) || /\.csv$/i.test(fileName) ? parseCsv(buf.toString("utf8")) : await parseWorkbook(buf);
    } catch { throw new ApiError(422, "unreadable_file", "The file could not be read as an Excel workbook (.xlsx) or CSV"); }
    if (!sheets.length) throw new ApiError(422, "no_data", "No sheet with a header row and data was found");
    const sheet = sheets.find((s) => s.name === q.get("sheet")) ?? sheets[0];
    if (sheet.rows.length > MAX_ROWS || sheet.headers.length > MAX_COLUMNS) throw new ApiError(422, "too_large", `At most ${MAX_ROWS} rows and ${MAX_COLUMNS} columns per sheet`);
    if (sheet.rows.length < 20) throw new ApiError(422, "too_small", "A study dataset needs at least 20 rows");
    // De-identify before anything is stored.
    const de = deidentify(sheet.headers, sheet.rows, `${deps.deidKey}|${wsId}`);
    const ws = (await c.query("SELECT small_cell FROM workspace WHERE id = $1", [wsId])).rows[0];
    const prof = profile(de.headers, de.rows, ws.small_cell);
    const id = (await c.query(`INSERT INTO study_dataset (workspace_id, department_id, title, file_name, file_sha256, sheet_name, sheets, row_count, headers, profile, deid_report, uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [wsId, dept, title, fileName, sha256(buf.toString("base64")), sheet.name, sheets.map((s) => s.name), de.rows.length, de.headers, JSON.stringify(prof), de.report, actorId(me)])).rows[0].id;
    for (let i = 0; i < de.rows.length; i += 1000) {
      const chunk = de.rows.slice(i, i + 1000);
      await c.query(`INSERT INTO dataset_row (workspace_id, dataset_id, row_no, raw) SELECT $1, $2, n, r FROM unnest($3::int[], $4::jsonb[]) AS t(n, r)`,
        [wsId, id, chunk.map((_, k) => i + k), chunk.map((row) => JSON.stringify(row))]);
    }
    await audit(c, wsId, actorId(me), "dataset.upload", "study_dataset", id, { rows: de.rows.length, dropped: de.report.dropped_columns.length }, ctx.requestId);
    return { status: 201, body: { id, title, rows: de.rows.length, columns: de.headers.length, sheet: sheet.name, sheets: sheets.map((s) => s.name), deidentification: de.report } };
  }));

  r.on("GET", `${W}/studies/datasets`, (ctx) => scoped(ctx, UPLOADERS, async (c, me, _ws, access) => {
    if (isInternal(access)) {
      const { rows } = await c.query(`SELECT d.id, d.title, d.file_name, d.row_count, d.stage, d.statistician, d.dictionary_status, d.cleaning_status, d.uploaded_by, d.created_at, dep.name AS department,
          (SELECT count(*)::int FROM study_hypothesis h WHERE h.dataset_id = d.id) AS hypotheses,
          (SELECT count(*)::int FROM study_result s WHERE s.dataset_id = d.id) AS results
        FROM study_dataset d LEFT JOIN department dep ON dep.id = d.department_id ORDER BY d.created_at DESC`);
      return { body: { items: rows } };
    }
    // Hospital view: receipt only. The analysis stays internal until a report is released.
    const { rows } = await c.query(`SELECT d.id, d.title, d.file_name, d.row_count, d.created_at, dep.name AS department, 'received' AS status
      FROM study_dataset d LEFT JOIN department dep ON dep.id = d.department_id WHERE d.uploaded_by = $1 ORDER BY d.created_at DESC`, [actorId(me)]);
    return { body: { items: rows } };
  }));

  r.on("GET", `${W}/studies/datasets/{id}`, (ctx) => scoped(ctx, INTERNAL, async (c) => {
    const d = await loadDataset(c, idParam(ctx));
    const [h, plans, results, calls] = await Promise.all([
      c.query("SELECT * FROM study_hypothesis WHERE dataset_id = $1 ORDER BY status = 'rejected', priority DESC, title", [d.id]),
      c.query("SELECT id, hypothesis_id, status, origin, version, sha256, plan->>'title' AS title, created_at, locked_by, locked_at FROM analysis_plan WHERE dataset_id = $1 ORDER BY created_at", [d.id]),
      c.query("SELECT id, plan_id, hypothesis_id, status, run_by, reviewed_by, (results->'primary') AS primary, (results->>'significant')::boolean AS significant, created_at FROM study_result WHERE dataset_id = $1 ORDER BY created_at", [d.id]),
      c.query("SELECT task, model, accepted, problems, created_at FROM agent_call WHERE subject_id = $1 ORDER BY created_at DESC LIMIT 20", [d.id]),
    ]);
    return { body: { ...d, hypotheses: h.rows, plans: plans.rows, results: results.rows, agent_calls: calls.rows, agent_available: Boolean(deps.agent) } };
  }));

  r.on("PATCH", `${W}/studies/datasets/{id}`, (ctx) => scoped(ctx, ANALYST, async (c, me, wsId) => {
    const b = z.object({ expected_version: version, statistician: text(500).nullable().optional(), title: text(300).optional() }).strict().parse(await ctx.body());
    const { expected_version, ...ch } = b;
    const cols = Object.keys(ch) as (keyof typeof ch)[];
    const upd = await c.query(`UPDATE study_dataset SET ${cols.map((k, i) => `${k} = $${i + 3}`).join(", ")}, version = version + 1 WHERE id = $1 AND version = $2 RETURNING version`,
      [idParam(ctx), expected_version, ...cols.map((k) => ch[k])]);
    if (!upd.rowCount) throw conflict("dataset");
    await audit(c, wsId, actorId(me), "dataset.update", "study_dataset", ctx.params.id, ch, ctx.requestId);
    return { body: { version: upd.rows[0].version } };
  }));

  // ---- Step 1: data dictionary ---------------------------------------------------------------
  r.on("POST", `${W}/studies/datasets/{id}/dictionary/propose`, (ctx) => scoped(ctx, ANALYST, async (c, me, wsId) => {
    const b = z.object({ mode }).strict().parse(await ctx.body());
    const d = await loadDataset(c, idParam(ctx));
    if (d.dictionary_status === "confirmed") throw new ApiError(409, "already_confirmed", "The dictionary is confirmed; cleaning has used it");
    const prof = d.profile as ColumnProfile[];
    let entries: DictEntry[] = ruleDictionary(prof), origin = "rules", problems: string[] = [];
    if (b.mode === "claude") {
      const res = await agentRun<{ entries: DictEntry[] }>(c, wsId, me, "dictionary", d.id, { columns: prof }, (o) => validateDictionary(o.entries, prof)
        .concat(o.entries.length !== prof.length ? [`expected ${prof.length} columns, got ${o.entries.length}`] : []));
      if (res.output) { entries = res.output.entries; origin = "claude"; } else problems = res.problems;
    }
    await c.query("UPDATE study_dataset SET dictionary = $2, dictionary_origin = $3, dictionary_status = 'proposed', stage = 'dictionary', version = version + 1 WHERE id = $1",
      [d.id, JSON.stringify(entries), origin]);
    await audit(c, wsId, actorId(me), "dataset.dictionary.propose", "study_dataset", d.id, { origin, problems }, ctx.requestId);
    return { body: { origin, fallback_reasons: problems, entries, problems_to_resolve: validateDictionary(entries, prof) } };
  }));

  r.on("PUT", `${W}/studies/datasets/{id}/dictionary`, (ctx) => scoped(ctx, ANALYST, async (c, me, wsId) => {
    const b = z.object({ expected_version: version, entries: dictionarySchema }).strict().parse(await ctx.body());
    const d = await loadDataset(c, idParam(ctx));
    if (d.dictionary_status === "confirmed") throw new ApiError(409, "already_confirmed", "The dictionary is confirmed");
    const upd = await c.query("UPDATE study_dataset SET dictionary = $3, dictionary_origin = coalesce(dictionary_origin, 'manual') || '+edited', dictionary_status = 'proposed', stage = 'dictionary', version = version + 1 WHERE id = $1 AND version = $2 RETURNING version",
      [d.id, b.expected_version, JSON.stringify(b.entries)]);
    if (!upd.rowCount) throw conflict("dataset");
    await audit(c, wsId, actorId(me), "dataset.dictionary.edit", "study_dataset", d.id, {}, ctx.requestId);
    return { body: { version: upd.rows[0].version, problems_to_resolve: validateDictionary(b.entries, d.profile) } };
  }));

  r.on("POST", `${W}/studies/datasets/{id}/dictionary/confirm`, (ctx) => scoped(ctx, STATISTICIAN, async (c, me, wsId, access) => {
    const b = z.object({ expected_version: version }).strict().parse(await ctx.body());
    const d = await loadDataset(c, idParam(ctx));
    requireStatistician(access, me, d);
    if (d.version !== b.expected_version) throw conflict("dataset");
    if (d.dictionary_status !== "proposed") throw new ApiError(409, "invalid_state", "There is no proposed dictionary to confirm");
    const problems = validateDictionary(d.dictionary, d.profile);
    if (problems.length) throw new ApiError(422, "dictionary_invalid", "Resolve the dictionary problems first", problems);
    await c.query("UPDATE study_dataset SET dictionary_status = 'confirmed', dictionary_confirmed_by = $2, dictionary_confirmed_at = now(), stage = 'cleaning', version = version + 1 WHERE id = $1", [d.id, actorId(me)]);
    await audit(c, wsId, actorId(me), "dataset.dictionary.confirm", "study_dataset", d.id, {}, ctx.requestId);
    return { body: { status: "confirmed" } };
  }));

  // ---- Step 2: cleaning and split --------------------------------------------------------------
  r.on("POST", `${W}/studies/datasets/{id}/clean`, (ctx) => scoped(ctx, ANALYST, async (c, me, wsId) => {
    const d = await loadDataset(c, idParam(ctx));
    if (d.dictionary_status !== "confirmed") throw new ApiError(409, "dictionary_not_confirmed", "The statistician confirms the dictionary first");
    if (d.cleaning_status === "confirmed") throw new ApiError(409, "already_confirmed", "Cleaning is confirmed");
    const raw = (await c.query("SELECT raw FROM dataset_row WHERE dataset_id = $1 ORDER BY row_no", [d.id])).rows.map((x) => x.raw as Raw[]);
    const res = clean(d.headers, raw, d.dictionary, { seed: d.split_seed, discoveryFraction: Number(d.discovery_fraction) });
    await c.query("UPDATE dataset_row SET clean = NULL WHERE dataset_id = $1", [d.id]);
    // Cleaning may drop duplicate rows; store kept rows in order.
    await c.query("CREATE TEMP TABLE IF NOT EXISTS clean_tmp (n int, r jsonb) ON COMMIT DROP");
    for (let i = 0; i < res.rows.length; i += 1000) {
      const chunk = res.rows.slice(i, i + 1000);
      await c.query("INSERT INTO clean_tmp SELECT * FROM unnest($1::int[], $2::jsonb[])", [chunk.map((_, k) => i + k), chunk.map((x) => JSON.stringify(x))]);
    }
    await c.query("UPDATE dataset_row d SET clean = t.r FROM clean_tmp t WHERE d.dataset_id = $1 AND d.row_no = t.n", [d.id]);
    const vars = variablesOf(d.dictionary, res.report.derived);
    await c.query("UPDATE study_dataset SET cleaning_report = $2, cleaning_status = 'proposed', variables = $3, version = version + 1 WHERE id = $1", [d.id, res.report, JSON.stringify(vars)]);
    await audit(c, wsId, actorId(me), "dataset.clean", "study_dataset", d.id, { rows_out: res.report.rows_out }, ctx.requestId);
    return { body: res.report };
  }));

  r.on("POST", `${W}/studies/datasets/{id}/cleaning/confirm`, (ctx) => scoped(ctx, STATISTICIAN, async (c, me, wsId, access) => {
    const b = z.object({ expected_version: version }).strict().parse(await ctx.body());
    const d = await loadDataset(c, idParam(ctx));
    requireStatistician(access, me, d);
    if (d.version !== b.expected_version) throw conflict("dataset");
    if (d.cleaning_status !== "proposed") throw new ApiError(409, "invalid_state", "Run the cleaning first");
    await c.query("UPDATE study_dataset SET cleaning_status = 'confirmed', cleaning_confirmed_by = $2, cleaning_confirmed_at = now(), stage = 'hypotheses', version = version + 1 WHERE id = $1", [d.id, actorId(me)]);
    await audit(c, wsId, actorId(me), "dataset.cleaning.confirm", "study_dataset", d.id, {}, ctx.requestId);
    return { body: { status: "confirmed" } };
  }));

  const cleanRows = async (c: Client, datasetId: string) =>
    (await c.query("SELECT clean FROM dataset_row WHERE dataset_id = $1 AND clean IS NOT NULL ORDER BY row_no", [datasetId])).rows.map((x) => x.clean as Row);
  const requireCleaned = (d: any) => { if (d.cleaning_status !== "confirmed") throw new ApiError(409, "cleaning_not_confirmed", "The statistician confirms the cleaning first"); };

  // ---- Step 3: hypotheses ------------------------------------------------------------------------
  r.on("POST", `${W}/studies/datasets/{id}/hypotheses/generate`, (ctx) => scoped(ctx, ANALYST, async (c, me, wsId) => {
    const b = z.object({ mode }).strict().parse(await ctx.body());
    const d = await loadDataset(c, idParam(ctx));
    requireCleaned(d);
    const ws = (await c.query("SELECT currency FROM workspace WHERE id = $1", [wsId])).rows[0];
    const vars = d.variables as Variable[];
    const rules = screen(await cleanRows(c, d.id), vars, { currency: ws.currency });
    let list: (Hypothesis & { origin: string })[] = rules.map((h) => ({ ...h, origin: "rules" })), problems: string[] = [];
    if (b.mode === "claude") {
      const names = new Set(vars.map((v) => v.name));
      const input = { variables: vars, cleaning: { ...d.cleaning_report, variables: d.cleaning_report.variables.map((v: any) => ({ ...v, examples_invalid: undefined })) },
        screening: rules.map((h) => ({ title: h.title, kind: h.kind, variables: h.variables, screening: h.screening })) };
      const res = await agentRun<{ hypotheses: any[] }>(c, wsId, me, "hypotheses", d.id, input, (o) => o.hypotheses.flatMap((h: any, i: number) => [
        ...[h.exposure, h.outcome, h.cost, h.diagnosis].filter((v: string | null) => v && !names.has(v)).map((v: string) => `hypothesis ${i + 1}: unknown variable ${v}`),
        ...unsupported(h.statement, input).map((n) => `hypothesis ${i + 1}: number ${n} is not in the data summaries`),
        ...(h.kind !== "burden" && (!h.exposure || !h.outcome || !h.treated || !h.reference) ? [`hypothesis ${i + 1}: needs exposure levels and an outcome`] : []),
      ]));
      if (res.output) list = list.concat(res.output.hypotheses.map((h: any, i: number) => ({
        key: `claude:${sha256(h.title).slice(0, 12)}:${i}`, kind: h.kind, study_category: h.study_category, title: h.title, statement: `${h.statement} Rationale: ${h.rationale}`,
        variables: { exposure: h.exposure ?? undefined, treated: h.treated ?? undefined, reference: h.reference ?? undefined, outcome: h.outcome ?? undefined,
          outcome_type: h.outcome_type ?? undefined, cost: h.cost ?? undefined, diagnosis: h.diagnosis ?? undefined, diagnosis_value: h.diagnosis_value ?? undefined },
        screening: {}, priority: 50, origin: "claude" })));
      else problems = res.problems;
    }
    let added = 0;
    for (const h of list) {
      const ins = await c.query(`INSERT INTO study_hypothesis (workspace_id, dataset_id, hypothesis_key, kind, study_category, title, statement, variables, screening, priority, origin, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (workspace_id, dataset_id, hypothesis_key) DO NOTHING`,
        [wsId, d.id, h.key, h.kind, h.study_category, h.title, h.statement, h.variables, h.screening, h.priority, h.origin, actorId(me)]);
      added += ins.rowCount ?? 0;
    }
    await c.query("UPDATE study_dataset SET stage = 'hypotheses' WHERE id = $1 AND stage = 'cleaning'", [d.id]);
    await audit(c, wsId, actorId(me), "dataset.hypotheses.generate", "study_dataset", d.id, { added, mode: b.mode, problems }, ctx.requestId);
    return { body: { added, total_candidates: list.length, fallback_reasons: problems } };
  }));

  r.on("POST", `${W}/studies/hypotheses/{id}/decision`, (ctx) => scoped(ctx, STATISTICIAN, async (c, me, wsId, access) => {
    const b = z.object({ status: z.enum(["confirmed", "rejected"]), reason: text(4000), expected_version: version }).strict().parse(await ctx.body());
    const h = (await c.query("SELECT * FROM study_hypothesis WHERE id = $1 FOR UPDATE", [idParam(ctx)])).rows[0];
    if (!h) throw notFound("Hypothesis");
    requireStatistician(access, me, await loadDataset(c, h.dataset_id));
    if (h.version !== b.expected_version) throw conflict("hypothesis");
    await c.query("UPDATE study_hypothesis SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4, version = version + 1 WHERE id = $1", [h.id, b.status, actorId(me), b.reason]);
    await audit(c, wsId, actorId(me), `hypothesis.${b.status}`, "study_hypothesis", h.id, {}, ctx.requestId, b.reason);
    return { body: { status: b.status } };
  }));

  // ---- Step 4: analysis plans ------------------------------------------------------------------------
  const checkPlanVars = (plan: Plan, vars: Variable[]) => {
    const names = new Set([...vars.map((v) => v.name)]);
    const used = [plan.exposure.variable, plan.outcome.variable, plan.outcome.event_variable, ...plan.covariates, plan.economics?.cost_variable, plan.economics?.effect_variable, ...plan.population.filters.map((f) => f.variable)].filter(Boolean) as string[];
    const problems = used.filter((u) => !names.has(u)).map((u) => `unknown variable ${u}`);
    const postExposure = vars.filter((v) => ["outcome", "cost", "los", "time_to_event", "event_date", "discharge_date"].includes(v.role)).map((v) => v.name);
    for (const cv of plan.covariates) if (postExposure.includes(cv)) problems.push(`${cv} is measured after the exposure and must not be a covariate`);
    if (plan.split !== "validation") problems.push("confirmatory plans run on the validation split");
    return problems;
  };

  r.on("POST", `${W}/studies/hypotheses/{id}/plans`, (ctx) => scoped(ctx, ANALYST, async (c, me, wsId) => {
    const b = z.object({ mode: z.enum(["template", "claude"]).default("template") }).strict().parse(await ctx.body());
    const h = (await c.query("SELECT * FROM study_hypothesis WHERE id = $1", [idParam(ctx)])).rows[0];
    if (!h) throw notFound("Hypothesis");
    if (h.status !== "confirmed") throw new ApiError(409, "not_confirmed", "Plans are written for statistician-confirmed hypotheses");
    const d = await loadDataset(c, h.dataset_id);
    const vars = d.variables as Variable[];
    let plan = templatePlan({ ...h, key: h.hypothesis_key }, vars), origin = "template", justification: string | null = null, problems: string[] = [];
    if (b.mode === "claude") {
      const res = await agentRun<{ plan: Plan; justification: string }>(c, wsId, me, "plan", h.id, { hypothesis: { title: h.title, statement: h.statement, kind: h.kind, variables: h.variables }, variables: vars },
        (o) => checkPlanVars(o.plan, vars));
      if (res.output) { plan = res.output.plan; justification = res.output.justification; origin = "claude"; } else problems = res.problems;
    }
    if (!plan) throw new ApiError(422, "no_plan_template", "Burden hypotheses are descriptive: create a proposal directly, or write a plan by hand");
    const id = (await c.query(`INSERT INTO analysis_plan (workspace_id, hypothesis_id, dataset_id, plan, justification, origin, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [wsId, h.id, d.id, plan, justification, origin, actorId(me)])).rows[0].id;
    await c.query("UPDATE study_dataset SET stage = 'analysis' WHERE id = $1 AND stage = 'hypotheses'", [d.id]);
    await audit(c, wsId, actorId(me), "plan.draft", "analysis_plan", id, { origin, problems }, ctx.requestId);
    return { status: 201, body: { id, origin, fallback_reasons: problems, plan, problems_to_resolve: checkPlanVars(plan, vars) } };
  }));

  r.on("GET", `${W}/studies/plans/{id}`, (ctx) => scoped(ctx, INTERNAL, async (c) => {
    const p = (await c.query("SELECT * FROM analysis_plan WHERE id = $1", [idParam(ctx)])).rows[0];
    if (!p) throw notFound("Plan");
    return { body: p };
  }));

  r.on("PATCH", `${W}/studies/plans/{id}`, (ctx) => scoped(ctx, ANALYST, async (c, me, wsId) => {
    const b = z.object({ expected_version: version, plan: planSchema, justification: text(4000).optional() }).strict().parse(await ctx.body());
    const p = (await c.query("SELECT * FROM analysis_plan WHERE id = $1 FOR UPDATE", [idParam(ctx)])).rows[0];
    if (!p) throw notFound("Plan");
    if (p.status !== "draft") throw new ApiError(409, "plan_locked", "A locked plan cannot change; draft a new plan");
    if (p.version !== b.expected_version) throw conflict("plan");
    const d = await loadDataset(c, p.dataset_id);
    await c.query("UPDATE analysis_plan SET plan = $2, justification = coalesce($3, justification), version = version + 1 WHERE id = $1", [p.id, b.plan, b.justification ?? null]);
    await audit(c, wsId, actorId(me), "plan.edit", "analysis_plan", p.id, {}, ctx.requestId);
    return { body: { version: p.version + 1, problems_to_resolve: checkPlanVars(b.plan, d.variables) } };
  }));

  r.on("POST", `${W}/studies/plans/{id}/lock`, (ctx) => scoped(ctx, STATISTICIAN, async (c, me, wsId, access) => {
    const b = z.object({ expected_version: version }).strict().parse(await ctx.body());
    const p = (await c.query("SELECT * FROM analysis_plan WHERE id = $1 FOR UPDATE", [idParam(ctx)])).rows[0];
    if (!p) throw notFound("Plan");
    const d = await loadDataset(c, p.dataset_id);
    requireStatistician(access, me, d);
    if (p.status !== "draft") throw new ApiError(409, "invalid_state", `The plan is ${p.status}`);
    if (p.version !== b.expected_version) throw conflict("plan");
    const plan = planSchema.parse(p.plan);
    const problems = checkPlanVars(plan, d.variables);
    if (problems.length) throw new ApiError(422, "plan_invalid", "Resolve the plan problems first", problems);
    const hash = sha256(canonicalJson(plan));
    await c.query("UPDATE analysis_plan SET status = 'superseded' WHERE hypothesis_id = $1 AND status = 'locked'", [p.hypothesis_id]);
    await c.query("UPDATE analysis_plan SET status = 'locked', sha256 = $2, locked_by = $3, locked_at = now(), version = version + 1 WHERE id = $1", [p.id, hash, actorId(me)]);
    await audit(c, wsId, actorId(me), "plan.lock", "analysis_plan", p.id, { sha256: hash }, ctx.requestId);
    return { body: { status: "locked", sha256: hash } };
  }));

  // ---- Step 5: run and review results -------------------------------------------------------------
  r.on("POST", `${W}/studies/plans/{id}/run`, (ctx) => scoped(ctx, ANALYST, async (c, me, wsId) => {
    const b = z.object({ interpret: z.enum(["template", "claude"]).default("template") }).strict().parse(await ctx.body());
    const p = (await c.query("SELECT * FROM analysis_plan WHERE id = $1", [idParam(ctx)])).rows[0];
    if (!p) throw notFound("Plan");
    if (p.status !== "locked") throw new ApiError(409, "plan_not_locked", "Only a plan locked by the statistician can run");
    const d = await loadDataset(c, p.dataset_id);
    const ws = (await c.query("SELECT currency FROM workspace WHERE id = $1", [wsId])).rows[0];
    const plan = planSchema.parse(p.plan);
    let result;
    try { result = runPlan(await cleanRows(c, d.id), d.variables, plan, { seed: d.split_seed, currency: ws.currency }); }
    catch (e) { if (e instanceof PlanError) throw new ApiError(422, "analysis_failed", e.message); throw e; }
    let interpretation = templateInterpretation(plan, result, d.variables), origin = "template", problems: string[] = [];
    if (b.interpret === "claude") {
      const res = await agentRun<{ interpretation: string }>(c, wsId, me, "interpret", p.id, { plan, result }, (o) => unsupported(o.interpretation, { plan, result }).map((n) => `number ${n} is not in the result`));
      if (res.output) { interpretation = res.output.interpretation; origin = "claude"; } else problems = res.problems;
    }
    const id = (await c.query(`INSERT INTO study_result (workspace_id, plan_id, hypothesis_id, dataset_id, results, sha256, plan_sha256, interpretation, interpretation_origin, run_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [wsId, p.id, p.hypothesis_id, d.id, result, sha256(canonicalJson(result)), p.sha256, interpretation, origin, actorId(me)])).rows[0].id;
    await audit(c, wsId, actorId(me), "result.run", "study_result", id, { plan_sha256: p.sha256, significant: result.significant }, ctx.requestId);
    return { status: 201, body: { id, primary: result.primary, significant: result.significant, interpretation, interpretation_origin: origin, fallback_reasons: problems } };
  }));

  r.on("GET", `${W}/studies/results/{id}`, (ctx) => scoped(ctx, INTERNAL, async (c) => {
    const x = (await c.query(`SELECT r.*, a.plan, h.title AS hypothesis_title, h.statement AS hypothesis_statement FROM study_result r
      JOIN analysis_plan a ON a.id = r.plan_id JOIN study_hypothesis h ON h.id = r.hypothesis_id WHERE r.id = $1`, [idParam(ctx)])).rows[0];
    if (!x) throw notFound("Result");
    return { body: x };
  }));

  r.on("POST", `${W}/studies/results/{id}/review`, (ctx) => scoped(ctx, STATISTICIAN, async (c, me, wsId, access) => {
    const b = z.object({ decision: z.enum(["accepted", "returned"]), note: text(4000).optional(), interpretation: text(6000).optional() }).strict()
      .refine((x) => x.decision === "accepted" || x.note, { message: "A note is required to return a result", path: ["note"] }).parse(await ctx.body());
    const x = (await c.query("SELECT * FROM study_result WHERE id = $1 FOR UPDATE", [idParam(ctx)])).rows[0];
    if (!x) throw notFound("Result");
    requireStatistician(access, me, await loadDataset(c, x.dataset_id));
    if (x.status !== "pending_review") throw new ApiError(409, "invalid_state", `The result is ${x.status}`);
    if (x.run_by === actorId(me)) throw forbidden("A statistician other than the person who ran the analysis reviews it");
    if (b.interpretation) {
      const bad = unsupported(b.interpretation, { results: x.results });
      if (bad.length) throw new ApiError(422, "unsupported_numbers", "The edited interpretation states numbers that are not in the result", bad);
    }
    await c.query("UPDATE study_result SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4, interpretation = coalesce($5, interpretation), interpretation_origin = CASE WHEN $5 IS NULL THEN interpretation_origin ELSE interpretation_origin || '+statistician' END WHERE id = $1",
      [x.id, b.decision, actorId(me), b.note ?? null, b.interpretation ?? null]);
    await audit(c, wsId, actorId(me), `result.${b.decision}`, "study_result", x.id, {}, ctx.requestId, b.note);
    return { body: { status: b.decision } };
  }));

  // ---- Step 6: proposals (suggested research ideas) --------------------------------------------------
  r.on("POST", `${W}/proposals`, (ctx) => scoped(ctx, ANALYST, async (c, me, wsId) => {
    const b = z.object({ hypothesis_id: uuid.optional(), result_id: uuid.optional(), gap_id: uuid.optional(), department_id: uuid.nullable().default(null),
      mode: z.enum(["template", "claude"]).default("template") }).strict()
      .refine((x) => [x.hypothesis_id, x.result_id, x.gap_id].filter(Boolean).length === 1, "Give exactly one of hypothesis_id, result_id or gap_id").parse(await ctx.body());
    const ws = (await c.query("SELECT name, currency FROM workspace WHERE id = $1", [wsId])).rows[0];
    let input: GapForIdea, evidence: Record<string, unknown>, priority = 0, src: { dataset_id: string | null; hypothesis_id: string | null; result_id: string | null; gap_id: string | null };
    if (b.gap_id) {
      const g = (await c.query("SELECT * FROM research_gap WHERE id = $1", [b.gap_id])).rows[0];
      if (!g) throw notFound("Gap");
      if (g.status !== "confirmed") throw new ApiError(409, "not_confirmed", "Proposals come from confirmed gaps");
      input = { ...g, hospital: ws.name, currency: ws.currency };
      evidence = { statement: g.statement, source: "aggregate hospital data", metrics: g.metrics }; priority = Number(g.priority_score);
      src = { dataset_id: null, hypothesis_id: null, result_id: null, gap_id: g.id };
    } else {
      const res = b.result_id ? (await c.query("SELECT * FROM study_result WHERE id = $1", [b.result_id])).rows[0] : null;
      if (b.result_id && !res) throw notFound("Result");
      if (res && res.status !== "accepted") throw new ApiError(409, "not_accepted", "Proposals come from statistician-accepted results");
      const h = (await c.query("SELECT * FROM study_hypothesis WHERE id = $1", [res?.hypothesis_id ?? b.hypothesis_id])).rows[0];
      if (!h) throw notFound("Hypothesis");
      if (h.status !== "confirmed") throw new ApiError(409, "not_confirmed", "Proposals come from confirmed hypotheses");
      const d = await loadDataset(c, h.dataset_id);
      const label = (n?: string) => (d.variables as Variable[]).find((v) => v.name === n)?.label ?? n ?? "";
      const econ = res?.results.economics;
      const gapType = h.kind === "economic" ? "cost_effectiveness" : h.kind === "burden" ? "high_burden_unstudied" : "management_outcome_variation";
      input = { id: h.id, gap_type: gapType, study_category: h.study_category, title: h.title, statement: h.statement,
        condition_code: h.variables.diagnosis_value ?? null, condition_label: h.variables.diagnosis_value ?? label(h.variables.outcome),
        metrics: { management: h.variables.treated, reference: h.variables.reference, outcome_label: label(h.variables.outcome).toLowerCase(),
          incremental_cost: econ?.incremental_cost ?? h.screening.mean_cost_treated - h.screening.mean_cost_reference, n: h.screening.n_treated, n_ref: h.screening.n_reference, managements: [] },
        suggested_designs: [], hospital: ws.name, currency: ws.currency };
      evidence = { statement: h.statement, result: res ? res.interpretation : null, primary: res?.results.primary ?? null, significant: res?.results.significant ?? null, economics: econ ?? null };
      priority = Number(h.priority) + (res?.results.significant ? 10 : 0);
      src = { dataset_id: d.id, hypothesis_id: h.id, result_id: res?.id ?? null, gap_id: null };
    }
    let concept = templateIdea(input), origin = "template", problems: string[] = [];
    if (b.mode === "claude") {
      if (!deps.drafter) throw new ApiError(503, "agent_unavailable", "Claude drafting is not configured (set INNOVA_ANTHROPIC_API_KEY)");
      const d2 = await deps.drafter.draft({ ...input, statement: [input.statement, evidence.result].filter(Boolean).join(" ") });
      await c.query("INSERT INTO agent_call (workspace_id, task, subject_id, model, accepted, problems, requested_by) VALUES ($1,'proposal',$2,$3,$4,$5,$6)",
        [wsId, src.hypothesis_id ?? src.gap_id, d2.model, Boolean(d2.draft), d2.problems, actorId(me)]);
      if (d2.draft) { concept = d2.draft; origin = "claude"; } else problems = d2.problems;
    }
    const id = (await c.query(`INSERT INTO proposal (workspace_id, dataset_id, hypothesis_id, result_id, gap_id, department_id, title, concept, evidence, study_category, priority, origin, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [wsId, src.dataset_id, src.hypothesis_id, src.result_id, src.gap_id, b.department_id, concept.title, concept, evidence, concept.study_category, Math.min(100, priority), origin, actorId(me)])).rows[0].id;
    await audit(c, wsId, actorId(me), "proposal.draft", "proposal", id, { origin, problems }, ctx.requestId);
    return { status: 201, body: { id, origin, fallback_reasons: problems, concept } };
  }));

  r.on("GET", `${W}/proposals`, (ctx) => scoped(ctx, [...INTERNAL, ...HOSPITAL_DECIDERS, "coordinator", "department_lead"], async (c, _me, _ws, access) => {
    const internal = isInternal(access);
    const { rows } = await c.query(`SELECT p.*, d.name AS department FROM proposal p LEFT JOIN department d ON d.id = p.department_id
      WHERE ($1 OR p.status IN ('released','approved','declined')) ORDER BY p.priority DESC, p.created_at DESC`, [internal]);
    return { body: { items: rows } };
  }));

  r.on("PATCH", `${W}/proposals/{id}`, (ctx) => scoped(ctx, ANALYST, async (c, me, wsId) => {
    const b = z.object({ expected_version: version, concept: z.record(z.string(), z.unknown()), department_id: uuid.nullable().optional() }).strict().parse(await ctx.body());
    const p = (await c.query("SELECT * FROM proposal WHERE id = $1 FOR UPDATE", [idParam(ctx)])).rows[0];
    if (!p) throw notFound("Proposal");
    if (!["draft", "confirmed"].includes(p.status)) throw new ApiError(409, "invalid_state", "Released proposals cannot change");
    if (p.version !== b.expected_version) throw conflict("proposal");
    const concept = { ...p.concept, ...b.concept };
    // Edits after confirmation need a fresh confirmation.
    await c.query("UPDATE proposal SET concept = $2, title = $3, department_id = coalesce($4, department_id), status = 'draft', confirmed_by = NULL, confirmed_at = NULL, version = version + 1 WHERE id = $1",
      [p.id, concept, String(concept.title ?? p.title), b.department_id ?? null]);
    await audit(c, wsId, actorId(me), "proposal.edit", "proposal", p.id, {}, ctx.requestId);
    return { body: { version: p.version + 1 } };
  }));

  r.on("POST", `${W}/proposals/{id}/confirm`, (ctx) => scoped(ctx, STATISTICIAN, async (c, me, wsId) => {
    const b = z.object({ expected_version: version }).strict().parse(await ctx.body());
    const p = (await c.query("SELECT * FROM proposal WHERE id = $1 FOR UPDATE", [idParam(ctx)])).rows[0];
    if (!p) throw notFound("Proposal");
    if (p.status !== "draft") throw new ApiError(409, "invalid_state", `The proposal is ${p.status}`);
    if (p.version !== b.expected_version) throw conflict("proposal");
    await c.query("UPDATE proposal SET status = 'confirmed', confirmed_by = $2, confirmed_at = now(), version = version + 1 WHERE id = $1", [p.id, actorId(me)]);
    await audit(c, wsId, actorId(me), "proposal.confirm", "proposal", p.id, {}, ctx.requestId);
    return { body: { status: "confirmed" } };
  }));

  // ---- Reports to the hospital -----------------------------------------------------------------------
  r.on("POST", `${W}/client-reports`, (ctx) => scoped(ctx, ANALYST, async (c, me, wsId) => {
    const b = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("gaps_ideas"), title: text(300).default("Research gaps and suggested studies"), proposal_ids: z.array(uuid).min(1).max(50) }).strict(),
      z.object({ kind: z.literal("results"), title: text(300).optional(), project_id: uuid, result_ids: z.array(uuid).min(1).max(20) }).strict(),
    ]).parse(await ctx.body());
    const snapshot = b.kind === "gaps_ideas" ? await gapsIdeasSnapshot(c, wsId, b.proposal_ids) : await resultsSnapshot(c, wsId, b.project_id, b.result_ids);
    const title = b.title ?? `Study results: ${(snapshot as any).project.title}`;
    const scope = b.kind === "results" ? b.project_id : null;
    const revision = (await c.query("SELECT coalesce(max(revision),0)+1 AS v FROM client_report WHERE kind = $1 AND project_id IS NOT DISTINCT FROM $2", [b.kind, scope])).rows[0].v;
    const digest = sha256(canonicalJson(snapshot));
    const id = (await c.query(`INSERT INTO client_report (workspace_id, kind, project_id, title, revision, snapshot, digest, author) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [wsId, b.kind, scope, title, revision, snapshot, digest, actorId(me)])).rows[0].id;
    await audit(c, wsId, actorId(me), "client_report.draft", "client_report", id, { kind: b.kind }, ctx.requestId);
    return { status: 201, body: { id, revision, digest } };
  }));

  const visibleReport = (access: WorkspaceAccess, status: string) => isInternal(access) || ["released", "hospital_approved", "hospital_returned", "superseded"].includes(status);
  r.on("GET", `${W}/client-reports`, (ctx) => scoped(ctx, [...INTERNAL, ...HOSPITAL_DECIDERS, "coordinator", "department_lead", "executive_reader", "investigator"], async (c, _me, _ws, access) => {
    const { rows } = await c.query("SELECT id, kind, project_id, title, revision, digest, status, author, approver, released_at, hospital_decided_by, hospital_decided_at, hospital_note, created_at FROM client_report ORDER BY created_at DESC");
    return { body: { items: rows.filter((x) => visibleReport(access, x.status)) } };
  }));

  r.on("GET", `${W}/client-reports/{id}`, (ctx) => scoped(ctx, [...INTERNAL, ...HOSPITAL_DECIDERS, "coordinator", "department_lead", "executive_reader", "investigator"], async (c, _me, _ws, access) => {
    const x = (await c.query("SELECT * FROM client_report WHERE id = $1", [idParam(ctx)])).rows[0];
    if (!x || !visibleReport(access, x.status)) throw notFound("Report");
    if (x.kind === "gaps_ideas") x.proposals = (await c.query("SELECT id, title, status, hospital_reason, hospital_decided_at, project_id, version FROM proposal WHERE id = ANY($1)",
      [x.snapshot.ideas.map((i: any) => i.proposal_id)])).rows;
    return { body: x };
  }));

  r.on("POST", `${W}/client-reports/{id}/approve`, (ctx) => scoped(ctx, STATISTICIAN, async (c, me, wsId) => {
    const b = z.object({ digest: z.string().length(64), decision: z.enum(["approve", "return"]).default("approve"), note: text(4000).optional() }).strict().parse(await ctx.body());
    const x = (await c.query("SELECT * FROM client_report WHERE id = $1 FOR UPDATE", [idParam(ctx)])).rows[0];
    if (!x) throw notFound("Report");
    if (x.status !== "draft") throw new ApiError(409, "invalid_state", `The report is ${x.status}`);
    if (x.digest !== b.digest) throw new ApiError(409, "stale_digest", "You reviewed a different version");
    if (x.author === actorId(me)) throw forbidden("A statistician other than the author approves the report");
    await c.query("UPDATE client_report SET status = $2, approver = $3, approved_at = now(), review_note = $4 WHERE id = $1", [x.id, b.decision === "approve" ? "approved" : "returned", actorId(me), b.note ?? null]);
    await audit(c, wsId, actorId(me), `client_report.${b.decision}`, "client_report", x.id, {}, ctx.requestId, b.note);
    return { body: { status: b.decision === "approve" ? "approved" : "returned" } };
  }));

  r.on("POST", `${W}/client-reports/{id}/release`, (ctx) => scoped(ctx, ANALYST, async (c, me, wsId) => {
    const b = z.object({ digest: z.string().length(64) }).strict().parse(await ctx.body());
    const id = idParam(ctx);
    return idempotent(c, ctx, wsId, `client_report.release:${id}`, async () => {
      const x = (await c.query("SELECT * FROM client_report WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!x) throw notFound("Report");
      if (x.status !== "approved") throw new ApiError(409, "invalid_state", "Only an approved report can be released");
      if (x.digest !== b.digest) throw new ApiError(409, "stale_digest", "You are releasing a different version");
      if (x.kind === "gaps_ideas") {
        const ids = x.snapshot.ideas.map((i: any) => i.proposal_id);
        const changed = (await c.query("SELECT count(*)::int AS n FROM proposal WHERE id = ANY($1) AND status <> 'confirmed'", [ids])).rows[0].n;
        if (changed) throw new ApiError(409, "inputs_changed", "A proposal in this report changed or was already released; draft a new report");
        await c.query("UPDATE proposal SET status = 'released', report_id = $2, version = version + 1 WHERE id = ANY($1)", [ids, x.id]);
      } else {
        await c.query("UPDATE client_report SET status = 'superseded' WHERE kind = 'results' AND project_id = $1 AND status IN ('released','hospital_returned')", [x.project_id]);
        await c.query("UPDATE study_result SET project_id = $2 WHERE id = ANY($1)", [x.snapshot.analyses.map((a: any) => a.result_id), x.project_id]);
      }
      const pdf = await renderClientPdf(x.snapshot, { title: x.title, revision: x.revision, status: "released", digest: x.digest, synthetic: deps.synthetic });
      const key = `${wsId}/client-reports/${x.id}.pdf`;
      const { sha256: art } = await deps.store.put(key, pdf);
      await c.query("UPDATE client_report SET status = 'released', released_by = $2, released_at = now(), artifact_key = $3, artifact_sha256 = $4 WHERE id = $1", [x.id, actorId(me), key, art]);
      await audit(c, wsId, actorId(me), "client_report.release", "client_report", x.id, { artifact_sha256: art }, ctx.requestId);
      return { body: { status: "released", artifact_sha256: art } };
    });
  }));

  r.on("GET", `${W}/client-reports/{id}/pdf`, (ctx) => scoped(ctx, [...INTERNAL, ...HOSPITAL_DECIDERS, "coordinator", "department_lead", "executive_reader", "investigator"], async (c, me, wsId, access) => {
    const x = (await c.query("SELECT * FROM client_report WHERE id = $1", [idParam(ctx)])).rows[0];
    if (!x || !visibleReport(access, x.status)) throw notFound("Report");
    const data = x.artifact_key ? await deps.store.get(x.artifact_key, x.artifact_sha256) : await renderClientPdf(x.snapshot, { title: x.title, revision: x.revision, status: x.status, digest: x.digest, synthetic: deps.synthetic });
    await audit(c, wsId, actorId(me), "client_report.download", "client_report", x.id, {}, ctx.requestId);
    return { body: null, raw: { contentType: "application/pdf", data, headers: { "content-disposition": `attachment; filename="innovahospital-${x.kind}-r${x.revision}.pdf"` } } };
  }));

  // Hospital decision on a results report.
  r.on("POST", `${W}/client-reports/{id}/hospital-decision`, (ctx) => scoped(ctx, HOSPITAL_DECIDERS, async (c, me, wsId) => {
    const b = z.object({ decision: z.enum(["approved", "returned"]), note: text(4000).optional() }).strict()
      .refine((x) => x.decision === "approved" || x.note, { message: "Say what needs to change", path: ["note"] }).parse(await ctx.body());
    const x = (await c.query("SELECT * FROM client_report WHERE id = $1 FOR UPDATE", [idParam(ctx)])).rows[0];
    if (!x || !["released", "hospital_approved", "hospital_returned"].includes(x.status)) throw notFound("Report");
    if (x.kind !== "results") throw new ApiError(409, "invalid_kind", "Ideas are approved one by one");
    if (x.status !== "released") throw new ApiError(409, "already_decided", `The report is ${x.status.replace("_", " ")}`);
    await c.query("UPDATE client_report SET status = $2, hospital_decided_by = $3, hospital_decided_at = now(), hospital_note = $4 WHERE id = $1",
      [x.id, b.decision === "approved" ? "hospital_approved" : "hospital_returned", actorId(me), b.note ?? null]);
    await audit(c, wsId, actorId(me), `client_report.hospital_${b.decision}`, "client_report", x.id, {}, ctx.requestId, b.note);
    return { body: { status: b.decision === "approved" ? "hospital_approved" : "hospital_returned" } };
  }));

  // Hospital decision on one suggested idea: approval starts an ongoing study.
  r.on("POST", `${W}/proposals/{id}/hospital-decision`, (ctx) => scoped(ctx, HOSPITAL_DECIDERS, async (c, me, wsId) => {
    const b = z.object({ decision: z.enum(["approved", "declined"]), reason: text(4000).optional(), department_id: uuid.optional(), pi: text(500).optional(), expected_version: version }).strict()
      .refine((x) => x.decision === "approved" || x.reason, { message: "Give a reason for declining", path: ["reason"] })
      .refine((x) => x.decision === "declined" || x.department_id, { message: "Choose the department that will run the study", path: ["department_id"] }).parse(await ctx.body());
    const p = (await c.query("SELECT * FROM proposal WHERE id = $1 FOR UPDATE", [idParam(ctx)])).rows[0];
    if (!p || !["released", "approved", "declined"].includes(p.status)) throw notFound("Proposal");
    if (p.status !== "released") throw new ApiError(409, "already_decided", `The idea was already ${p.status}`);
    if (p.version !== b.expected_version) throw conflict("proposal");
    let ideaId: string | null = null, projectId: string | null = null;
    if (b.decision === "approved") {
      if (!(await c.query("SELECT 1 FROM department WHERE id = $1", [b.department_id])).rowCount) throw notFound("Department");
      const k = p.concept;
      const pi = b.pi ?? actorId(me);
      ideaId = (await c.query(`INSERT INTO idea (workspace_id, department_id, title, research_question, rationale, design, study_category, population, data_sources,
          primary_outcome, comparator, analysis_plan, economic_method, expected_output, condition_codes, origin, pi, status, reviewer, triage_reason, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'{}',$15,$16,'accepted',$17,$18,$17) RETURNING id`,
        [wsId, b.department_id, k.title, k.research_question, k.rationale, k.design, k.study_category, k.population, k.data_sources, k.primary_outcome ?? null,
          k.comparator ?? null, k.analysis_plan ?? null, k.economic_method ?? null, k.expected_output ?? null, p.origin === "claude" ? "claude" : "engine", pi, actorId(me),
          `Approved from the InnovaStat Gaps & Ideas report${b.reason ? `: ${b.reason}` : ""}`])).rows[0].id;
      projectId = (await c.query(`INSERT INTO project (workspace_id, idea_id, department_id, title, pi, study_type, study_category, objective) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [wsId, ideaId, b.department_id, k.title, pi, k.design, k.study_category, k.research_question])).rows[0].id;
      await c.query("UPDATE idea SET status = 'converted', project_id = $2 WHERE id = $1", [ideaId, projectId]);
      await c.query("INSERT INTO idea_history (workspace_id, idea_id, from_status, to_status, actor, reason) VALUES ($1,$2,'accepted','converted',$3,'Approved from Gaps & Ideas report')", [wsId, ideaId, actorId(me)]);
    }
    await c.query("UPDATE proposal SET status = $2, hospital_decided_by = $3, hospital_decided_at = now(), hospital_reason = $4, idea_id = $5, project_id = $6, version = version + 1 WHERE id = $1",
      [p.id, b.decision, actorId(me), b.reason ?? null, ideaId, projectId]);
    await audit(c, wsId, actorId(me), `proposal.hospital_${b.decision}`, "proposal", p.id, { project: projectId }, ctx.requestId, b.reason);
    return { body: { status: b.decision, project_id: projectId } };
  }));

  // ---- Manuscripts ---------------------------------------------------------------------------------
  r.on("POST", `${W}/projects/{id}/manuscripts`, (ctx) => scoped(ctx, ANALYST, async (c, me, wsId) => {
    const b = z.object({ mode: z.enum(["template", "claude"]).default("template") }).strict().parse(await ctx.body());
    const projectId = idParam(ctx);
    const rep = (await c.query("SELECT * FROM client_report WHERE kind = 'results' AND project_id = $1 AND status = 'hospital_approved' ORDER BY revision DESC LIMIT 1", [projectId])).rows[0];
    if (!rep) throw new ApiError(409, "results_not_approved", "The hospital approves a results report before the manuscript is written");
    let sections: Record<string, string> = templateManuscript(rep.snapshot), origin = "template", problems: string[] = [];
    if (b.mode === "claude") {
      const res = await agentRun<Record<string, string>>(c, wsId, me, "manuscript", projectId, rep.snapshot,
        (o) => Object.entries(o).flatMap(([k, v]) => unsupported(String(v), rep.snapshot).map((n) => `${k}: number ${n} is not in the approved results`)));
      if (res.output) { sections = res.output; origin = "claude"; } else problems = res.problems;
    }
    const v = (await c.query("SELECT coalesce(max(version),0)+1 AS v FROM manuscript WHERE project_id = $1", [projectId])).rows[0].v;
    const id = (await c.query("INSERT INTO manuscript (workspace_id, project_id, results_report_id, version, sections, origin, author) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [wsId, projectId, rep.id, v, sections, origin, actorId(me)])).rows[0].id;
    await audit(c, wsId, actorId(me), "manuscript.draft", "manuscript", id, { origin, problems }, ctx.requestId);
    return { status: 201, body: { id, version: v, origin, fallback_reasons: problems, sections } };
  }));

  const manuscriptVisible = (access: WorkspaceAccess, status: string) => isInternal(access) || ["sent", "hospital_accepted", "hospital_returned"].includes(status);
  r.on("GET", `${W}/manuscripts`, (ctx) => scoped(ctx, [...INTERNAL, ...HOSPITAL_DECIDERS, "coordinator", "investigator", "department_lead"], async (c, _me, _ws, access) => {
    const { rows } = await c.query(`SELECT m.id, m.project_id, p.title AS project_title, m.version, m.status, m.origin, m.author, m.approved_by, m.sent_at, m.hospital_note, m.updated_at
      FROM manuscript m JOIN project p ON p.id = m.project_id ORDER BY m.updated_at DESC`);
    return { body: { items: rows.filter((x) => manuscriptVisible(access, x.status)) } };
  }));
  r.on("GET", `${W}/manuscripts/{id}`, (ctx) => scoped(ctx, [...INTERNAL, ...HOSPITAL_DECIDERS, "coordinator", "investigator", "department_lead"], async (c, _me, _ws, access) => {
    const m = (await c.query("SELECT m.*, p.title AS project_title FROM manuscript m JOIN project p ON p.id = m.project_id WHERE m.id = $1", [idParam(ctx)])).rows[0];
    if (!m || !manuscriptVisible(access, m.status)) throw notFound("Manuscript");
    return { body: m };
  }));
  r.on("PATCH", `${W}/manuscripts/{id}`, (ctx) => scoped(ctx, ANALYST, async (c, me, wsId) => {
    const b = z.object({ updated_at: z.string(), sections: z.record(z.string(), z.string().max(20000)) }).strict().parse(await ctx.body());
    const m = (await c.query("SELECT * FROM manuscript WHERE id = $1 FOR UPDATE", [idParam(ctx)])).rows[0];
    if (!m) throw notFound("Manuscript");
    if (!["draft", "hospital_returned"].includes(m.status)) throw new ApiError(409, "invalid_state", "Only drafts are edited");
    if (new Date(m.updated_at).toISOString() !== new Date(b.updated_at).toISOString()) throw conflict("manuscript");
    await c.query("UPDATE manuscript SET sections = $2, status = 'draft', approved_by = NULL, updated_at = now() WHERE id = $1", [m.id, { ...m.sections, ...b.sections }]);
    await audit(c, wsId, actorId(me), "manuscript.edit", "manuscript", m.id, {}, ctx.requestId);
    return { body: { status: "draft" } };
  }));
  r.on("POST", `${W}/manuscripts/{id}/approve`, (ctx) => scoped(ctx, STATISTICIAN, async (c, me, wsId) => {
    const m = (await c.query("SELECT * FROM manuscript WHERE id = $1 FOR UPDATE", [idParam(ctx)])).rows[0];
    if (!m) throw notFound("Manuscript");
    if (m.status !== "draft") throw new ApiError(409, "invalid_state", `The manuscript is ${m.status}`);
    if (m.author === actorId(me)) throw forbidden("Someone other than the author approves the manuscript");
    await c.query("UPDATE manuscript SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1", [m.id, actorId(me)]);
    await audit(c, wsId, actorId(me), "manuscript.approve", "manuscript", m.id, {}, ctx.requestId);
    return { body: { status: "approved" } };
  }));
  r.on("POST", `${W}/manuscripts/{id}/send`, (ctx) => scoped(ctx, ANALYST, async (c, me, wsId) => {
    const m = (await c.query("SELECT * FROM manuscript WHERE id = $1 FOR UPDATE", [idParam(ctx)])).rows[0];
    if (!m) throw notFound("Manuscript");
    if (m.status !== "approved") throw new ApiError(409, "invalid_state", "Only an approved manuscript is sent");
    await c.query("UPDATE manuscript SET status = 'sent', sent_by = $2, sent_at = now(), updated_at = now() WHERE id = $1", [m.id, actorId(me)]);
    // The hospital tracks journal submission and publication as a project output.
    await c.query("INSERT INTO research_output (workspace_id, project_id, output_type, title, lead, status) VALUES ($1,$2,'manuscript',$3,$4,'approved')",
      [wsId, m.project_id, String(m.sections.title ?? "Manuscript"), actorId(me)]);
    await audit(c, wsId, actorId(me), "manuscript.send", "manuscript", m.id, {}, ctx.requestId);
    return { body: { status: "sent" } };
  }));
  r.on("POST", `${W}/manuscripts/{id}/hospital-decision`, (ctx) => scoped(ctx, [...HOSPITAL_DECIDERS, "investigator"], async (c, me, wsId) => {
    const b = z.object({ decision: z.enum(["accepted", "returned"]), note: text(4000).optional() }).strict()
      .refine((x) => x.decision === "accepted" || x.note, { message: "Say what needs to change", path: ["note"] }).parse(await ctx.body());
    const m = (await c.query("SELECT * FROM manuscript WHERE id = $1 FOR UPDATE", [idParam(ctx)])).rows[0];
    if (!m || m.status !== "sent") throw notFound("Manuscript");
    await c.query("UPDATE manuscript SET status = $2, hospital_decided_by = $3, hospital_note = $4, updated_at = now() WHERE id = $1",
      [m.id, b.decision === "accepted" ? "hospital_accepted" : "hospital_returned", actorId(me), b.note ?? null]);
    await audit(c, wsId, actorId(me), `manuscript.hospital_${b.decision}`, "manuscript", m.id, {}, ctx.requestId, b.note);
    return { body: { status: b.decision } };
  }));
}

export type { Ctx };
