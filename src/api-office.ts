// Research office routes (Handoff §2, §4): idea intake and triage, project
// portfolio with governance gates, milestones, outputs, training,
// partnerships and quality indicators.
import { z } from "zod";
import type { Client } from "./db.ts";
import { audit } from "./db.ts";
import { membersWithRoles, notify } from "./notifications.ts";
import { ApiError } from "./http.ts";
import { actorId, can, departmentScope, ROLES, STAFF } from "./auth.ts";
import type { Identity, Role, WorkspaceAccess } from "./auth.ts";
import { conflict, forbidden, idempotent, idParam, notFound, period, text, uuid, version, W } from "./api-common.ts";
import type { RouteDeps } from "./api-common.ts";

const OFFICE: Role[] = ["coordinator", "research_director"];
const CATEGORIES = ["clinical_effectiveness", "health_economics", "epidemiology", "quality_improvement", "operational", "other"] as const;
const icd = z.string().regex(/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/);

const ideaFields = {
  title: text(300), research_question: text(4000), rationale: text(8000), design: text(500),
  study_category: z.enum(CATEGORIES), population: text(2000), data_sources: text(2000),
  primary_outcome: text(1000).nullable().optional(), comparator: text(1000).nullable().optional(),
  analysis_plan: text(8000).nullable().optional(), economic_method: text(4000).nullable().optional(),
  expected_output: text(1000).nullable().optional(), aggregate_volume: z.number().int().min(0).nullable().optional(),
  condition_codes: z.array(icd).max(20).optional(),
};
const ideaCreate = z.object({ department_id: uuid, pi: text(500).optional(), ...ideaFields }).strict();
const ideaPatch = z.object({ expected_version: version, ...Object.fromEntries(Object.entries(ideaFields).map(([k, v]) => [k, (v as z.ZodType).optional()])) }).strict();

/** Allowed idea moves and who may make them. */
const IDEA_MOVES: Record<string, Record<string, "owner" | "office">> = {
  draft: { submitted: "owner" },
  returned: { submitted: "owner" },
  submitted: { returned: "office", feasibility: "office", rejected: "office", deferred: "office" },
  feasibility: { accepted: "office", rejected: "office", deferred: "office", returned: "office" },
  deferred: { feasibility: "office", rejected: "office" },
};
const PROJECT_MOVES: Record<string, string[]> = {
  draft: ["submitted"], submitted: ["feasibility", "draft"], feasibility: ["governance", "draft"],
  governance: ["active", "feasibility"], active: ["on_hold", "complete"], on_hold: ["active", "complete"], complete: ["archived"],
};

function scopeFilter(access: WorkspaceAccess, col = "department_id", start = 1): { sql: string; params: unknown[] } {
  const depts = departmentScope(access, ROLES);
  return depts === null ? { sql: "true", params: [] } : { sql: `${col} = ANY($${start})`, params: [depts] };
}
const isOwner = (me: Identity, row: { pi: string; created_by?: string }) => [row.pi, row.created_by].includes(actorId(me));

/** Current ethics and data decisions must be valid for the working protocol version (Handoff §4 steps 5-6). */
export async function gateProblems(c: Client, projectId: string, protocolVersion: number, today: string): Promise<string[]> {
  const { rows } = await c.query("SELECT kind, decision, protocol_version, effective_date, expiry_date FROM governance_decision WHERE project_id = $1 AND NOT superseded", [projectId]);
  const problems: string[] = [];
  for (const kind of ["ethics", "data"]) {
    const d = rows.find((x) => x.kind === kind);
    if (!d) problems.push(`${kind}: no decision recorded`);
    else if (!["approved", "determination"].includes(d.decision)) problems.push(`${kind}: decision is ${d.decision}`);
    else if (d.protocol_version !== protocolVersion) problems.push(`${kind}: decision covers protocol v${d.protocol_version}, working version is v${protocolVersion}`);
    else if (d.effective_date > today) problems.push(`${kind}: not effective until ${d.effective_date}`);
    else if (d.expiry_date && d.expiry_date < today) problems.push(`${kind}: expired on ${d.expiry_date}`);
  }
  return problems;
}
const todayIso = () => new Date().toISOString().slice(0, 10);

async function holdProject(c: Client, wsId: string, actor: string, p: { id: string; stage: string }, reason: string, requestId: string) {
  const held = (await c.query("UPDATE project SET stage = 'on_hold', hold_reason = $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING pi, department_id, version",
    [p.id, reason])).rows[0];
  await c.query("INSERT INTO project_stage_history (workspace_id, project_id, from_stage, to_stage, actor, reason) VALUES ($1,$2,$3,'on_hold',$4,$5)", [wsId, p.id, p.stage, actor, reason]);
  await audit(c, wsId, actor, "project.hold", "project", p.id, { reason }, requestId);
  // The PI and the coordinators for the department; the message links to the project, not the reason.
  await notify(c, wsId, { kind: "project_on_hold", recipients: [held.pi, ...await membersWithRoles(c, ["coordinator"], held.department_id)], exclude: [actor],
    entityType: "project", entityId: p.id, linkPath: `/#/w/${wsId}/projects/${p.id}`, dedupe: `project_on_hold:${p.id}:v${held.version}` });
}

/**
 * Holds every active project whose approvals are no longer valid on `today` (YYYY-MM-DD) and
 * lists decisions expiring within 60 days. Called by the expiry-check route and the scheduler.
 */
export async function expirySweep(c: Client, wsId: string, actor: string, today: string, correlationId: string) {
  const active = (await c.query("SELECT id, stage, protocol_version FROM project WHERE stage = 'active'")).rows;
  const held: { id: string; problems: string[] }[] = [];
  for (const p of active) {
    const problems = await gateProblems(c, p.id, p.protocol_version, today);
    if (problems.length) { await holdProject(c, wsId, actor, p, problems.join("; "), correlationId); held.push({ id: p.id, problems }); }
  }
  const expiring = (await c.query(`SELECT g.project_id, p.title, g.kind, g.expiry_date FROM governance_decision g JOIN project p ON p.id = g.project_id
    WHERE NOT g.superseded AND g.expiry_date BETWEEN $1::date AND $1::date + 60 ORDER BY g.expiry_date`, [today])).rows;
  return { held, expiring_within_60_days: expiring };
}

/** Gated write on an active project: if its approvals are no longer valid, hold it and refuse. */
async function requireValidActive(c: Client, wsId: string, actor: string, project: { id: string; stage: string; protocol_version: number }, requestId: string) {
  if (project.stage !== "active") return;
  const problems = await gateProblems(c, project.id, project.protocol_version, todayIso());
  if (problems.length) {
    await holdProject(c, wsId, actor, project, problems.join("; "), requestId);
    throw new ApiError(409, "approval_invalid", "The project's approvals are no longer valid; it has been put on hold", problems);
  }
}

export function registerOfficeRoutes({ r, scoped }: RouteDeps) {
  const loadProject = async (c: Client, id: string, access: WorkspaceAccess) => {
    const p = (await c.query("SELECT * FROM project WHERE id = $1", [id])).rows[0];
    if (!p || !can(access, ROLES, p.department_id)) throw notFound("Project");
    return p;
  };

  // ---- Ideas ----------------------------------------------------------------------
  r.on("GET", `${W}/ideas`, (ctx) => scoped(ctx, STAFF, async (c, _me, _ws, access) => {
    const f = scopeFilter(access, "i.department_id", 2);
    const { rows } = await c.query(`SELECT i.*, d.name AS department, g.title AS gap_title FROM idea i JOIN department d ON d.id = i.department_id
      LEFT JOIN research_gap g ON g.id = i.source_gap_id
      WHERE ($1::text IS NULL OR i.status = $1) AND ${f.sql} ORDER BY i.updated_at DESC LIMIT 300`, [ctx.query.get("status"), ...f.params]);
    return { body: { items: rows } };
  }));

  r.on("GET", `${W}/ideas/{id}`, (ctx) => scoped(ctx, STAFF, async (c, _me, _ws, access) => {
    const i = (await c.query("SELECT i.*, d.name AS department FROM idea i JOIN department d ON d.id = i.department_id WHERE i.id = $1", [idParam(ctx)])).rows[0];
    if (!i || !can(access, ROLES, i.department_id)) throw notFound("Idea");
    i.history = (await c.query("SELECT from_status, to_status, actor, reason, created_at FROM idea_history WHERE idea_id = $1 ORDER BY created_at", [i.id])).rows;
    return { body: i };
  }));

  r.on("POST", `${W}/ideas`, (ctx) => scoped(ctx, ["investigator", "coordinator", "department_lead", "research_director", "innovastat_reviewer"], async (c, me, wsId, access) => {
    const b = ideaCreate.parse(await ctx.body());
    if (!can(access, ["investigator", "coordinator", "department_lead", "research_director", "innovastat_reviewer"], b.department_id)) throw forbidden("Your grant does not cover this department");
    const cols = Object.keys(ideaFields).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    const vals = cols.map((k) => (b as Record<string, unknown>)[k]);
    const id = (await c.query(`INSERT INTO idea (workspace_id, department_id, pi, created_by, ${cols.join(",")})
      VALUES ($1,$2,$3,$4,${cols.map((_, i) => `$${i + 5}`).join(",")}) RETURNING id`, [wsId, b.department_id, b.pi ?? actorId(me), actorId(me), ...vals])).rows[0].id;
    await audit(c, wsId, actorId(me), "idea.create", "idea", id, {}, ctx.requestId);
    return { status: 201, body: { id, status: "draft", version: 1 } };
  }));

  r.on("PATCH", `${W}/ideas/{id}`, (ctx) => scoped(ctx, STAFF, async (c, me, wsId, access) => {
    const { expected_version, ...changes } = ideaPatch.parse(await ctx.body()) as Record<string, unknown> & { expected_version: number };
    const i = (await c.query("SELECT * FROM idea WHERE id = $1 FOR UPDATE", [idParam(ctx)])).rows[0];
    if (!i || !can(access, ROLES, i.department_id)) throw notFound("Idea");
    if (!isOwner(me, i) && !can(access, OFFICE, i.department_id)) throw forbidden();
    if (!["draft", "returned"].includes(i.status)) throw new ApiError(409, "invalid_state", "Only draft or returned ideas can be edited");
    const cols = Object.keys(changes);
    if (!cols.length) throw new ApiError(422, "no_changes", "No changes supplied");
    const upd = await c.query(`UPDATE idea SET ${cols.map((k, n) => `${k} = $${n + 3}`).join(", ")}, version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 RETURNING version`, [i.id, expected_version, ...cols.map((k) => changes[k])]);
    if (!upd.rowCount) throw conflict("idea");
    await audit(c, wsId, actorId(me), "idea.update", "idea", i.id, { fields: cols }, ctx.requestId);
    return { body: { version: upd.rows[0].version } };
  }));

  r.on("POST", `${W}/ideas/{id}/transition`, (ctx) => scoped(ctx, STAFF, async (c, me, wsId, access) => {
    const b = z.object({ target: z.enum(["submitted", "returned", "feasibility", "accepted", "rejected", "deferred"]), expected_version: version,
      reason: text(4000).optional(), priority: z.number().int().min(1).max(5).optional(), next_action: text(1000).optional() }).strict().parse(await ctx.body());
    const i = (await c.query("SELECT * FROM idea WHERE id = $1 FOR UPDATE", [idParam(ctx)])).rows[0];
    if (!i || !can(access, ROLES, i.department_id)) throw notFound("Idea");
    if (i.version !== b.expected_version) throw conflict("idea");
    const who = IDEA_MOVES[i.status]?.[b.target];
    if (!who) throw new ApiError(409, "invalid_transition", `An idea cannot move from ${i.status} to ${b.target}`);
    if (who === "owner" && !isOwner(me, i) && !can(access, OFFICE, i.department_id)) throw forbidden();
    if (who === "office") {
      if (!can(access, OFFICE, i.department_id)) throw forbidden("Only the research office triages ideas");
      if (!b.reason) throw new ApiError(422, "reason_required", "A triage decision needs a reason");
    }
    await c.query(`UPDATE idea SET status = $2, version = version + 1, updated_at = now(),
        reviewer = CASE WHEN $3 THEN $4 ELSE reviewer END, triage_reason = coalesce($5, triage_reason),
        priority = coalesce($6, priority), next_action = coalesce($7, next_action) WHERE id = $1`,
      [i.id, b.target, who === "office", actorId(me), b.reason ?? null, b.priority ?? null, b.next_action ?? null]);
    await c.query("INSERT INTO idea_history (workspace_id, idea_id, from_status, to_status, actor, reason) VALUES ($1,$2,$3,$4,$5,$6)",
      [wsId, i.id, i.status, b.target, actorId(me), b.reason ?? null]);
    await audit(c, wsId, actorId(me), "idea.transition", "idea", i.id, { from: i.status, to: b.target }, ctx.requestId, b.reason);
    return { body: { status: b.target, version: i.version + 1 } };
  }));

  // Atomic, idempotent conversion: one accepted idea becomes exactly one project.
  r.on("POST", `${W}/ideas/{id}/convert`, (ctx) => scoped(ctx, OFFICE, async (c, me, wsId, access) => {
    const b = z.object({ expected_version: version, study_type: text(200).optional(), target_end: z.string().date().optional() }).strict().parse(await ctx.body());
    const id = idParam(ctx);
    return idempotent(c, ctx, wsId, `idea.convert:${id}`, async () => {
      const i = (await c.query("SELECT * FROM idea WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!i || !can(access, OFFICE, i.department_id)) throw notFound("Idea");
      if (i.status !== "accepted") throw new ApiError(409, "invalid_state", "Only accepted ideas can be converted");
      if (i.version !== b.expected_version) throw conflict("idea");
      const pid = (await c.query(`INSERT INTO project (workspace_id, idea_id, department_id, title, pi, study_type, study_category, objective, condition_codes, target_end)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [wsId, i.id, i.department_id, i.title, i.pi, b.study_type ?? i.design, i.study_category, i.research_question, i.condition_codes, b.target_end ?? null])).rows[0].id;
      await c.query("UPDATE idea SET status = 'converted', project_id = $2, version = version + 1, updated_at = now() WHERE id = $1", [i.id, pid]);
      await c.query("INSERT INTO idea_history (workspace_id, idea_id, from_status, to_status, actor) VALUES ($1,$2,'accepted','converted',$3)", [wsId, i.id, actorId(me)]);
      await audit(c, wsId, actorId(me), "idea.convert", "idea", i.id, { project: pid }, ctx.requestId);
      return { status: 201, body: { project_id: pid } };
    });
  }));

  // ---- Projects --------------------------------------------------------------------
  r.on("GET", `${W}/projects`, (ctx) => scoped(ctx, STAFF, async (c, me, _ws, access) => {
    const f = scopeFilter(access, "p.department_id", 4);
    // Investigators without a broader grant see the projects they lead.
    const onlyOwn = [...access.roles].every((x) => x === "investigator");
    const { rows } = await c.query(`SELECT p.*, d.name AS department,
        (SELECT count(*)::int FROM milestone m WHERE m.project_id = p.id AND m.state NOT IN ('done','cancelled') AND m.due_date < current_date) AS overdue_milestones
      FROM project p JOIN department d ON d.id = p.department_id
      WHERE ($1::text IS NULL OR p.stage = $1) AND (NOT $2 OR p.pi = $3) AND ${f.sql}
      ORDER BY p.updated_at DESC LIMIT 300`, [ctx.query.get("stage"), onlyOwn, actorId(me), ...f.params]);
    return { body: { items: rows } };
  }));

  r.on("GET", `${W}/projects/{id}`, (ctx) => scoped(ctx, STAFF, async (c, _me, _ws, access) => {
    const p = await loadProject(c, idParam(ctx), access);
    const [history, decisions, milestones, outputs] = await Promise.all([
      c.query("SELECT from_stage, to_stage, actor, reason, created_at FROM project_stage_history WHERE project_id = $1 ORDER BY created_at", [p.id]),
      c.query("SELECT * FROM governance_decision WHERE project_id = $1 ORDER BY recorded_at DESC", [p.id]),
      c.query("SELECT * FROM milestone WHERE project_id = $1 ORDER BY due_date", [p.id]),
      c.query("SELECT * FROM research_output WHERE project_id = $1 ORDER BY updated_at DESC", [p.id]),
    ]);
    return { body: { ...p, history: history.rows, decisions: decisions.rows, milestones: milestones.rows, outputs: outputs.rows,
      gate_problems: await gateProblems(c, p.id, p.protocol_version, todayIso()) } };
  }));

  r.on("POST", `${W}/projects`, (ctx) => scoped(ctx, ["investigator", "coordinator", "research_director"], async (c, me, wsId, access) => {
    const b = z.object({ department_id: uuid, title: text(300), study_type: text(200), study_category: z.enum(CATEGORIES), objective: text(4000).optional(),
      condition_codes: z.array(icd).max(20).default([]), pi: text(500).optional(), target_end: z.string().date().optional() }).strict().parse(await ctx.body());
    if (!can(access, ["investigator", "coordinator", "research_director"], b.department_id)) throw forbidden("Your grant does not cover this department");
    const id = (await c.query(`INSERT INTO project (workspace_id, department_id, title, pi, study_type, study_category, objective, condition_codes, target_end)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [wsId, b.department_id, b.title, b.pi ?? actorId(me), b.study_type, b.study_category, b.objective ?? null, b.condition_codes, b.target_end ?? null])).rows[0].id;
    await audit(c, wsId, actorId(me), "project.create", "project", id, {}, ctx.requestId);
    return { status: 201, body: { id, stage: "draft", version: 1 } };
  }));

  r.on("POST", `${W}/projects/{id}/transition`, (ctx) => scoped(ctx, ["investigator", ...OFFICE], async (c, me, wsId, access) => {
    const b = z.object({ target: z.enum(["draft", "submitted", "feasibility", "governance", "active", "on_hold", "complete", "archived"]),
      expected_version: version, reason: text(4000).optional() }).strict().parse(await ctx.body());
    const p = await loadProject(c, idParam(ctx), access);
    if (p.version !== b.expected_version) throw conflict("project");
    if (!PROJECT_MOVES[p.stage]?.includes(b.target)) throw new ApiError(409, "invalid_transition", `A project cannot move from ${p.stage} to ${b.target}`);
    const officer = can(access, OFFICE, p.department_id);
    const ownerSubmit = b.target === "submitted" && p.pi === actorId(me);
    if (!officer && !ownerSubmit) throw forbidden();
    if (["on_hold", "draft", "complete"].includes(b.target) && !b.reason) throw new ApiError(422, "reason_required", `Moving to ${b.target} needs a reason`);
    if (b.target === "active") {
      const problems = await gateProblems(c, p.id, p.protocol_version, todayIso());
      if (problems.length) throw new ApiError(409, "gate_failed", "Valid ethics and data decisions for the working protocol version are required", problems);
    }
    await c.query("UPDATE project SET stage = $2, hold_reason = CASE WHEN $2 = 'on_hold' THEN $3 ELSE NULL END, version = version + 1, updated_at = now() WHERE id = $1",
      [p.id, b.target, b.reason ?? null]);
    await c.query("INSERT INTO project_stage_history (workspace_id, project_id, from_stage, to_stage, actor, reason) VALUES ($1,$2,$3,$4,$5,$6)",
      [wsId, p.id, p.stage, b.target, actorId(me), b.reason ?? null]);
    await audit(c, wsId, actorId(me), "project.stage", "project", p.id, { from: p.stage, to: b.target }, ctx.requestId, b.reason);
    return { body: { stage: b.target, version: p.version + 1 } };
  }));

  // Material scope change: new protocol version; approvals must be re-obtained.
  r.on("POST", `${W}/projects/{id}/amend`, (ctx) => scoped(ctx, ["investigator", ...OFFICE], async (c, me, wsId, access) => {
    const b = z.object({ expected_version: version, reason: text(4000) }).strict().parse(await ctx.body());
    const p = await loadProject(c, idParam(ctx), access);
    if (p.pi !== actorId(me) && !can(access, OFFICE, p.department_id)) throw forbidden();
    if (p.version !== b.expected_version) throw conflict("project");
    await c.query("UPDATE project SET protocol_version = protocol_version + 1, version = version + 1, updated_at = now() WHERE id = $1", [p.id]);
    await audit(c, wsId, actorId(me), "project.amend", "project", p.id, { protocol_version: p.protocol_version + 1 }, ctx.requestId, b.reason);
    if (p.stage === "active") await holdProject(c, wsId, actorId(me), p, `Protocol amended to v${p.protocol_version + 1}: approvals must cover the new version`, ctx.requestId);
    return { body: { protocol_version: p.protocol_version + 1 } };
  }));

  r.on("POST", `${W}/projects/{id}/decisions`, (ctx) => scoped(ctx, ["governance_recorder"], async (c, me, wsId, access) => {
    const b = z.object({ kind: z.enum(["ethics", "data"]), authority: text(300), decision: z.enum(["approved", "denied", "determination", "revoked"]),
      reference: text(200), effective_date: z.string().date(), expiry_date: z.string().date().nullable().default(null),
      protocol_version: z.number().int().positive(), permitted_scope: text(2000) }).strict()
      .refine((x) => !x.expiry_date || x.expiry_date >= x.effective_date, { message: "expiry_date must not be before effective_date", path: ["expiry_date"] })
      .parse(await ctx.body());
    const p = await loadProject(c, idParam(ctx), access);
    await c.query("UPDATE governance_decision SET superseded = true WHERE project_id = $1 AND kind = $2 AND NOT superseded", [p.id, b.kind]);
    const id = (await c.query(`INSERT INTO governance_decision (workspace_id, project_id, kind, authority, decision, reference, effective_date, expiry_date,
        protocol_version, permitted_scope, recorder) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [wsId, p.id, b.kind, b.authority, b.decision, b.reference, b.effective_date, b.expiry_date, b.protocol_version, b.permitted_scope, actorId(me)])).rows[0].id;
    await audit(c, wsId, actorId(me), "decision.record", "project", p.id, { kind: b.kind, decision: b.decision, reference: b.reference }, ctx.requestId);
    let held = false;
    if (p.stage === "active") {
      const problems = await gateProblems(c, p.id, p.protocol_version, todayIso());
      if (problems.length) { await holdProject(c, wsId, actorId(me), p, problems.join("; "), ctx.requestId); held = true; }
    }
    return { status: 201, body: { id, project_on_hold: held } };
  }));

  // Expiry sweep (run by the scheduler daily, or by the office on demand).
  r.on("POST", `${W}/governance/expiry-check`, (ctx) => scoped(ctx, OFFICE, async (c, me, wsId) =>
    ({ body: await expirySweep(c, wsId, actorId(me), todayIso(), ctx.requestId) })));

  // ---- Milestones and outputs -------------------------------------------------------------
  r.on("POST", `${W}/projects/{id}/milestones`, (ctx) => scoped(ctx, ["investigator", ...OFFICE], async (c, me, wsId, access) => {
    const b = z.object({ title: text(300), owner: text(500), due_date: z.string().date() }).strict().parse(await ctx.body());
    const p = await loadProject(c, idParam(ctx), access);
    if (p.pi !== actorId(me) && !can(access, OFFICE, p.department_id)) throw forbidden();
    const id = (await c.query("INSERT INTO milestone (workspace_id, project_id, title, owner, due_date) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [wsId, p.id, b.title, b.owner, b.due_date])).rows[0].id;
    await audit(c, wsId, actorId(me), "milestone.create", "milestone", id, { project: p.id }, ctx.requestId);
    return { status: 201, body: { id } };
  }));

  r.on("PATCH", `${W}/milestones/{id}`, (ctx) => scoped(ctx, ["investigator", ...OFFICE], async (c, me, wsId, access) => {
    const b = z.object({ expected_version: version, state: z.enum(["planned", "in_progress", "blocked", "done", "cancelled"]).optional(),
      due_date: z.string().date().optional(), blocker: text(2000).nullable().optional(), completed_date: z.string().date().optional() }).strict().parse(await ctx.body());
    const m = (await c.query("SELECT * FROM milestone WHERE id = $1 FOR UPDATE", [idParam(ctx)])).rows[0];
    if (!m) throw notFound("Milestone");
    const p = await loadProject(c, m.project_id, access);
    if (p.pi !== actorId(me) && m.owner !== actorId(me) && !can(access, OFFICE, p.department_id)) throw forbidden();
    if (m.version !== b.expected_version) throw conflict("milestone");
    await requireValidActive(c, wsId, actorId(me), p, ctx.requestId);
    const state = b.state ?? m.state;
    const completed = state === "done" ? (b.completed_date ?? m.completed_date ?? todayIso()) : null;
    await c.query("UPDATE milestone SET state = $2, due_date = $3, blocker = $4, completed_date = $5, version = version + 1 WHERE id = $1",
      [m.id, state, b.due_date ?? m.due_date, b.blocker === undefined ? m.blocker : b.blocker, completed]);
    await audit(c, wsId, actorId(me), "milestone.update", "milestone", m.id, { state }, ctx.requestId);
    return { body: { version: m.version + 1 } };
  }));

  r.on("GET", `${W}/outputs`, (ctx) => scoped(ctx, STAFF, async (c, _me, _ws, access) => {
    const f = scopeFilter(access, "p.department_id");
    const { rows } = await c.query(`SELECT o.*, p.title AS project_title, d.name AS department FROM research_output o
      JOIN project p ON p.id = o.project_id JOIN department d ON d.id = p.department_id WHERE ${f.sql} ORDER BY o.updated_at DESC LIMIT 300`, f.params);
    return { body: { items: rows } };
  }));

  r.on("POST", `${W}/projects/{id}/outputs`, (ctx) => scoped(ctx, ["investigator", ...OFFICE], async (c, me, wsId, access) => {
    const b = z.object({ output_type: z.enum(["protocol", "sap", "analysis", "manuscript", "abstract", "poster", "economic_model", "report"]),
      title: text(500), lead: text(500), venue: text(300).optional() }).strict().parse(await ctx.body());
    const p = await loadProject(c, idParam(ctx), access);
    if (p.pi !== actorId(me) && !can(access, OFFICE, p.department_id)) throw forbidden();
    const id = (await c.query("INSERT INTO research_output (workspace_id, project_id, output_type, title, lead, venue) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [wsId, p.id, b.output_type, b.title, b.lead, b.venue ?? null])).rows[0].id;
    await audit(c, wsId, actorId(me), "output.create", "research_output", id, { project: p.id }, ctx.requestId);
    return { status: 201, body: { id } };
  }));

  r.on("PATCH", `${W}/outputs/{id}`, (ctx) => scoped(ctx, ["investigator", ...OFFICE, "innovastat_reviewer"], async (c, me, wsId, access) => {
    const b = z.object({ expected_version: version, status: z.enum(["planned", "in_progress", "qc", "approved", "submitted", "accepted", "published", "released"]).optional(),
      venue: text(300).nullable().optional(), submitted_date: z.string().date().nullable().optional(), accepted_date: z.string().date().nullable().optional(),
      published_date: z.string().date().nullable().optional(), doi: text(200).nullable().optional() }).strict().parse(await ctx.body());
    const o = (await c.query("SELECT * FROM research_output WHERE id = $1 FOR UPDATE", [idParam(ctx)])).rows[0];
    if (!o) throw notFound("Output");
    const p = await loadProject(c, o.project_id, access);
    if (o.version !== b.expected_version) throw conflict("output");
    // QC approval is the reviewer's or office's; the lead cannot approve their own output.
    if (b.status === "approved" && (o.lead === actorId(me) || !can(access, ["innovastat_reviewer", ...OFFICE], p.department_id))) throw forbidden("Another reviewer must approve this output");
    if (["submitted", "released"].includes(b.status ?? "") && o.status !== "approved" && o.status !== b.status) throw new ApiError(409, "not_approved", "Outputs are submitted or released only after approval");
    await requireValidActive(c, wsId, actorId(me), p, ctx.requestId);
    const { expected_version, ...changes } = b;
    const cols = Object.keys(changes) as (keyof typeof changes)[];
    if (!cols.length) throw new ApiError(422, "no_changes", "No changes supplied");
    await c.query(`UPDATE research_output SET ${cols.map((k, n) => `${k} = $${n + 2}`).join(", ")}, version = version + 1, updated_at = now() WHERE id = $1`,
      [o.id, ...cols.map((k) => changes[k])]);
    await audit(c, wsId, actorId(me), "output.update", "research_output", o.id, changes, ctx.requestId);
    return { body: { version: o.version + 1 } };
  }));

  // ---- Training and partnerships ---------------------------------------------------------
  r.on("GET", `${W}/training`, (ctx) => scoped(ctx, STAFF, async (c) => ({ body: { items: (await c.query("SELECT * FROM training_cohort ORDER BY start_date DESC")).rows } })));
  r.on("POST", `${W}/training`, (ctx) => scoped(ctx, OFFICE, async (c, me, wsId) => {
    const b = z.object({ title: text(300), competencies: z.array(text(200)).max(30).default([]), facilitator: text(300), start_date: z.string().date(),
      end_date: z.string().date(), capacity: z.number().int().positive().optional(), method: z.enum(["in_person", "online", "blended"]).default("in_person") }).strict().parse(await ctx.body());
    const id = (await c.query(`INSERT INTO training_cohort (workspace_id, title, competencies, facilitator, start_date, end_date, capacity, method)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [wsId, b.title, b.competencies, b.facilitator, b.start_date, b.end_date, b.capacity ?? null, b.method])).rows[0].id;
    await audit(c, wsId, actorId(me), "training.create", "training_cohort", id, {}, ctx.requestId);
    return { status: 201, body: { id } };
  }));
  r.on("PATCH", `${W}/training/{id}`, (ctx) => scoped(ctx, OFFICE, async (c, me, wsId) => {
    const b = z.object({ expected_version: version, enrolled: z.number().int().min(0), completed: z.number().int().min(0) }).strict().parse(await ctx.body());
    const upd = await c.query("UPDATE training_cohort SET enrolled = $3, completed = $4, version = version + 1 WHERE id = $1 AND version = $2 RETURNING version",
      [idParam(ctx), b.expected_version, b.enrolled, b.completed]);
    if (!upd.rowCount) throw conflict("cohort");
    await audit(c, wsId, actorId(me), "training.update", "training_cohort", ctx.params.id, b, ctx.requestId);
    return { body: { version: upd.rows[0].version } };
  }));

  r.on("GET", `${W}/partnerships`, (ctx) => scoped(ctx, ["research_director", "coordinator", "hospital_admin", "innovastat_reviewer"], async (c) =>
    ({ body: { items: (await c.query("SELECT * FROM partnership ORDER BY updated_at DESC")).rows } })));
  r.on("POST", `${W}/partnerships`, (ctx) => scoped(ctx, OFFICE, async (c, me, wsId) => {
    const b = z.object({ organization: text(300), opportunity_type: z.enum(["sponsor", "grant", "collaboration"]), owner: text(500), purpose: text(2000),
      next_action: text(1000).optional(), next_date: z.string().date().optional(), amount: z.number().min(0).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional() }).strict()
      .refine((x) => (x.amount === undefined) === (x.currency === undefined), { message: "amount and currency go together", path: ["currency"] }).parse(await ctx.body());
    const id = (await c.query(`INSERT INTO partnership (workspace_id, organization, opportunity_type, owner, purpose, next_action, next_date, amount, currency)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [wsId, b.organization, b.opportunity_type, b.owner, b.purpose, b.next_action ?? null, b.next_date ?? null, b.amount ?? null, b.currency ?? null])).rows[0].id;
    await audit(c, wsId, actorId(me), "partnership.create", "partnership", id, {}, ctx.requestId);
    return { status: 201, body: { id } };
  }));
  r.on("PATCH", `${W}/partnerships/{id}`, (ctx) => scoped(ctx, OFFICE, async (c, me, wsId) => {
    const b = z.object({ expected_version: version, stage: z.enum(["lead", "qualified", "proposal", "contracting", "signed", "active", "closed", "lost"]).optional(),
      next_action: text(1000).nullable().optional(), next_date: z.string().date().nullable().optional() }).strict().parse(await ctx.body());
    const { expected_version, ...changes } = b;
    const cols = Object.keys(changes) as (keyof typeof changes)[];
    if (!cols.length) throw new ApiError(422, "no_changes", "No changes supplied");
    const upd = await c.query(`UPDATE partnership SET ${cols.map((k, n) => `${k} = $${n + 3}`).join(", ")}, version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 RETURNING version`, [idParam(ctx), expected_version, ...cols.map((k) => changes[k])]);
    if (!upd.rowCount) throw conflict("partnership");
    await audit(c, wsId, actorId(me), "partnership.update", "partnership", ctx.params.id, changes, ctx.requestId);
    return { body: { version: upd.rows[0].version } };
  }));

  // ---- Quality indicators --------------------------------------------------------------
  r.on("GET", `${W}/indicator-definitions`, (ctx) => scoped(ctx, ROLES, async (c) =>
    ({ body: { items: (await c.query("SELECT * FROM indicator_definition WHERE active ORDER BY code, def_version DESC")).rows } })));

  r.on("POST", `${W}/indicator-definitions`, (ctx) => scoped(ctx, ["research_director", "hospital_admin"], async (c, me, wsId) => {
    const b = z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/), name: text(200), category: text(100), numerator_definition: text(2000),
      denominator_definition: text(2000), direction: z.enum(["higher_better", "lower_better"]), target_percent: z.number().min(0).max(100).optional() }).strict().parse(await ctx.body());
    // A changed definition is a new version; observations keep the version they were entered against.
    const v = (await c.query("SELECT coalesce(max(def_version), 0) + 1 AS v FROM indicator_definition WHERE code = $1", [b.code])).rows[0].v;
    await c.query("UPDATE indicator_definition SET active = false WHERE code = $1", [b.code]);
    const id = (await c.query(`INSERT INTO indicator_definition (workspace_id, code, def_version, name, category, numerator_definition, denominator_definition, direction, target_bp, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [wsId, b.code, v, b.name, b.category, b.numerator_definition, b.denominator_definition, b.direction,
        b.target_percent === undefined ? null : Math.round(b.target_percent * 100), actorId(me)])).rows[0].id;
    await audit(c, wsId, actorId(me), "indicator.define", "indicator_definition", id, { code: b.code, version: v }, ctx.requestId);
    return { status: 201, body: { id, def_version: v } };
  }));

  r.on("GET", `${W}/indicators`, (ctx) => scoped(ctx, STAFF, async (c, _me, _ws, access) => {
    const f = scopeFilter(access, "o.department_id", 2);
    const { rows } = await c.query(`SELECT o.*, d.name AS department, def.code, def.name, def.def_version, def.target_bp, def.direction FROM indicator_observation o
      JOIN indicator_definition def ON def.id = o.definition_id JOIN department d ON d.id = o.department_id
      WHERE ($1::text IS NULL OR o.period = $1) AND ${f.sql} ORDER BY o.period DESC, d.name, def.code`, [ctx.query.get("period"), ...f.params]);
    return { body: { items: rows } };
  }));

  r.on("PUT", `${W}/indicators/{department}/{period}/{code}`, (ctx) => scoped(ctx, ["data_steward", "coordinator"], async (c, me, wsId, access) => {
    const b = z.object({ numerator: z.number().int().min(0), denominator: z.number().int().min(0), evidence_reference: text(200).optional(),
      expected_version: z.number().int().min(0).default(0) }).strict().refine((x) => x.numerator <= x.denominator, "numerator cannot exceed denominator").parse(await ctx.body());
    const per = period.parse(ctx.params.period);
    const dept = (await c.query("SELECT id FROM department WHERE id::text = $1 OR code = $1", [ctx.params.department])).rows[0];
    if (!dept) throw notFound("Department");
    if (!can(access, ["data_steward", "coordinator"], dept.id)) throw forbidden("Your grant does not cover this department");
    const def = (await c.query("SELECT id FROM indicator_definition WHERE code = $1 AND active", [ctx.params.code])).rows[0];
    if (!def) throw notFound("Indicator definition");
    const cur = (await c.query("SELECT * FROM indicator_observation WHERE definition_id = $1 AND department_id = $2 AND period = $3 FOR UPDATE", [def.id, dept.id, per])).rows[0];
    if ((cur?.input_version ?? 0) !== b.expected_version) throw conflict("indicator value");
    if (cur) {
      // An edit is a new input version that needs verification again.
      await c.query(`UPDATE indicator_observation SET numerator = $2, denominator = $3, evidence_reference = $4, input_version = input_version + 1,
        status = 'submitted', submitted_by = $5, verified_by = NULL, verified_at = NULL WHERE id = $1`, [cur.id, b.numerator, b.denominator, b.evidence_reference ?? null, actorId(me)]);
    } else {
      await c.query(`INSERT INTO indicator_observation (workspace_id, definition_id, department_id, period, numerator, denominator, evidence_reference, submitted_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [wsId, def.id, dept.id, per, b.numerator, b.denominator, b.evidence_reference ?? null, actorId(me)]);
    }
    await audit(c, wsId, actorId(me), "indicator.submit", "indicator_observation", `${dept.id}/${per}/${ctx.params.code}`, { numerator: b.numerator, denominator: b.denominator }, ctx.requestId);
    return { body: { input_version: (cur?.input_version ?? 0) + 1, status: "submitted" } };
  }));

  r.on("POST", `${W}/indicators/{id}/verify`, (ctx) => scoped(ctx, ["innovastat_reviewer", "research_director", "department_lead"], async (c, me, wsId, access) => {
    const b = z.object({ decision: z.enum(["verified", "returned"]), expected_version: version, note: text(2000).optional() }).strict().parse(await ctx.body());
    const o = (await c.query("SELECT * FROM indicator_observation WHERE id = $1 FOR UPDATE", [idParam(ctx)])).rows[0];
    if (!o || !can(access, ["innovastat_reviewer", "research_director", "department_lead"], o.department_id)) throw notFound("Indicator value");
    if (o.input_version !== b.expected_version) throw conflict("indicator value");
    if (o.submitted_by === actorId(me)) throw forbidden("The person who entered a value cannot verify it");
    await c.query("UPDATE indicator_observation SET status = $2, verified_by = $3, verified_at = now(), note = $4 WHERE id = $1",
      [o.id, b.decision, b.decision === "verified" ? actorId(me) : null, b.note ?? null]);
    await audit(c, wsId, actorId(me), `indicator.${b.decision}`, "indicator_observation", o.id, {}, ctx.requestId, b.note);
    return { body: { status: b.decision } };
  }));
}

