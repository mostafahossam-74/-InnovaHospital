// Training: cohorts and per-person records (Developer_Handoff §2 "Training", §4 state sequence
// enrolled → attended → assessed → completed or incomplete, §6 cohort and enrollment fields).
// A cohort states its completion rule; once it has ended, a training manager (or the research
// office) records each person's decision, which the rule determines. Attendance and score
// changes are audited.
import { z } from "zod";
import type { Client } from "./db.ts";
import { audit } from "./db.ts";
import { ApiError } from "./http.ts";
import { actorId, can, STAFF } from "./auth.ts";
import type { Role, WorkspaceAccess } from "./auth.ts";
import { conflict, forbidden, idParam, notFound, text, uuid, version, W } from "./api-common.ts";
import type { RouteDeps } from "./api-common.ts";
import { localDate } from "./period.ts";

export const TRAINERS: Role[] = ["training_manager", "coordinator", "research_director"];

type Cohort = { sessions: number; min_attendance_percent: number; assessment_required: boolean; pass_score: number | null; completion_rule_version: number };
type Enrollment = { attended_sessions: number[]; score: number | null };

/** Completion rule v1: attended at least min_attendance_percent of the sessions, and passed the assessment when one is required. */
export function meetsCompletionRule(c: Cohort, e: Enrollment): { meets: boolean; attendance_percent: number; reasons: string[] } {
  const attendance = Math.round((10000 * new Set(e.attended_sessions).size) / c.sessions) / 100;
  const reasons: string[] = [];
  // Exact integer comparison: attended × 100 ≥ minimum × sessions.
  if (new Set(e.attended_sessions).size * 100 < c.min_attendance_percent * c.sessions) reasons.push(`attended ${attendance}% of sessions, below ${c.min_attendance_percent}%`);
  if (c.assessment_required) {
    if (e.score === null) reasons.push("no assessment score");
    else if (e.score < (c.pass_score ?? 0)) reasons.push(`score ${e.score} below the pass score ${c.pass_score}`);
  }
  return { meets: reasons.length === 0, attendance_percent: attendance, reasons };
}

const today = async (c: Client, wsId: string) =>
  localDate(new Date(), (await c.query("SELECT timezone FROM workspace WHERE id = $1", [wsId])).rows[0].timezone).date;

async function loadCohort(c: Client, id: string, access: WorkspaceAccess, write: boolean) {
  const cohort = (await c.query("SELECT * FROM training_cohort WHERE id = $1" + (write ? " FOR UPDATE" : ""), [id])).rows[0];
  if (!cohort) throw notFound("Cohort");
  if (write && !can(access, TRAINERS, cohort.department_id)) throw forbidden("Your grant does not cover this cohort's department");
  return cohort;
}

export function registerTrainingRoutes({ r, scoped }: RouteDeps) {
  const counts = `(SELECT count(*) FILTER (WHERE state <> 'withdrawn') FROM training_enrollment e WHERE e.cohort_id = c.id)::int AS people,
    (SELECT count(*) FILTER (WHERE state = 'completed') FROM training_enrollment e WHERE e.cohort_id = c.id)::int AS people_completed,
    (SELECT count(*) FILTER (WHERE state = 'incomplete') FROM training_enrollment e WHERE e.cohort_id = c.id)::int AS people_incomplete`;

  r.on("GET", `${W}/training`, (ctx) => scoped(ctx, STAFF, async (c) =>
    ({ body: { items: (await c.query(`SELECT c.*, ${counts} FROM training_cohort c ORDER BY start_date DESC, title`)).rows } })));

  r.on("POST", `${W}/training`, (ctx) => scoped(ctx, TRAINERS, async (c, me, wsId, access) => {
    const b = z.object({
      title: text(300), competencies: z.array(text(200)).max(30).default([]), facilitator: text(300),
      start_date: z.string().date(), end_date: z.string().date(), capacity: z.number().int().positive().optional(),
      method: z.enum(["in_person", "online", "blended"]).default("in_person"), department_id: uuid.nullable().default(null),
      sessions: z.number().int().min(1).max(100).default(1), min_attendance_percent: z.number().int().min(0).max(100).default(80),
      assessment_required: z.boolean().default(false), pass_score: z.number().int().min(0).max(100).nullable().default(null),
      language: z.enum(["en", "ar"]).default("en"),
    }).strict().refine((x) => x.end_date >= x.start_date, { message: "end_date is before start_date", path: ["end_date"] })
      .refine((x) => !x.assessment_required || x.pass_score !== null, { message: "Set pass_score when an assessment is required", path: ["pass_score"] })
      .parse(await ctx.body());
    if (!can(access, TRAINERS, b.department_id)) throw forbidden("Your grant does not cover this department");
    const id = (await c.query(`INSERT INTO training_cohort (workspace_id, title, competencies, facilitator, start_date, end_date, capacity, method,
        department_id, sessions, min_attendance_percent, assessment_required, pass_score, language)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [wsId, b.title, b.competencies, b.facilitator, b.start_date, b.end_date, b.capacity ?? null, b.method, b.department_id, b.sessions,
        b.min_attendance_percent, b.assessment_required, b.pass_score, b.language])).rows[0].id;
    await audit(c, wsId, actorId(me), "training.create", "training_cohort", id, { sessions: b.sessions, rule: { min_attendance_percent: b.min_attendance_percent, pass_score: b.pass_score } }, ctx.requestId);
    return { status: 201, body: { id } };
  }));

  r.on("GET", `${W}/training/{id}`, (ctx) => scoped(ctx, STAFF, async (c, _me, _ws, access) => {
    const cohort = await loadCohort(c, idParam(ctx), access, false);
    const people = (await c.query("SELECT * FROM training_enrollment WHERE cohort_id = $1 ORDER BY participant_name, created_at", [cohort.id])).rows;
    return { body: { ...cohort, enrollments: people.map((e) => ({ ...e, rule: meetsCompletionRule(cohort, e) })) } };
  }));

  // Counts entered by hand: only for cohorts without person records (recorded before them).
  r.on("PATCH", `${W}/training/{id}`, (ctx) => scoped(ctx, TRAINERS, async (c, me, wsId, access) => {
    const b = z.object({ expected_version: version, enrolled: z.number().int().min(0), completed: z.number().int().min(0) }).strict()
      .refine((x) => x.completed <= x.enrolled, { message: "completed is more than enrolled", path: ["completed"] }).parse(await ctx.body());
    const cohort = await loadCohort(c, idParam(ctx), access, true);
    if ((await c.query("SELECT 1 FROM training_enrollment WHERE cohort_id = $1 LIMIT 1", [cohort.id])).rowCount) {
      throw new ApiError(409, "has_enrollments", "This cohort has person records; its counts come from them");
    }
    if (cohort.version !== b.expected_version) throw conflict("cohort");
    await c.query("UPDATE training_cohort SET enrolled = $2, completed = $3, version = version + 1 WHERE id = $1", [cohort.id, b.enrolled, b.completed]);
    await audit(c, wsId, actorId(me), "training.update", "training_cohort", cohort.id, { enrolled: b.enrolled, completed: b.completed }, ctx.requestId);
    return { body: { version: cohort.version + 1 } };
  }));

  r.on("POST", `${W}/training/{id}/enrollments`, (ctx) => scoped(ctx, TRAINERS, async (c, me, wsId, access) => {
    const b = z.object({ participant_name: text(200), participant_email: z.string().trim().toLowerCase().email().max(200).nullable().default(null),
      department_id: uuid.nullable().default(null), member: text(500).nullable().default(null) }).strict().parse(await ctx.body());
    const cohort = await loadCohort(c, idParam(ctx), access, true);
    const people = (await c.query("SELECT count(*)::int AS n FROM training_enrollment WHERE cohort_id = $1 AND state <> 'withdrawn'", [cohort.id])).rows[0].n;
    if (cohort.capacity && people >= cohort.capacity) throw new ApiError(409, "cohort_full", `The cohort is full (${cohort.capacity})`);
    try {
      const id = (await c.query(`INSERT INTO training_enrollment (workspace_id, cohort_id, participant_name, participant_email, department_id, member, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [wsId, cohort.id, b.participant_name, b.participant_email, b.department_id, b.member, actorId(me)])).rows[0].id;
      await audit(c, wsId, actorId(me), "training.enroll", "training_enrollment", id, { cohort: cohort.id }, ctx.requestId);
      return { status: 201, body: { id } };
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new ApiError(409, "already_enrolled", "This person is already enrolled in the cohort");
      throw e;
    }
  }));

  /** Load an enrollment with its cohort, for a write by someone whose grant covers the cohort. */
  async function loadEnrollment(c: Client, id: string, access: WorkspaceAccess) {
    const e = (await c.query("SELECT * FROM training_enrollment WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!e) throw notFound("Enrollment");
    return { e, cohort: await loadCohort(c, e.cohort_id, access, true) };
  }

  // Attendance, score, certificate reference, or withdrawal.
  r.on("PATCH", `${W}/training/enrollments/{id}`, (ctx) => scoped(ctx, TRAINERS, async (c, me, wsId, access) => {
    const b = z.object({ expected_version: version, attended_sessions: z.array(z.number().int().min(1)).max(100).optional(),
      score: z.number().int().min(0).max(100).nullable().optional(), certificate_reference: text(200).nullable().optional(),
      withdraw: z.literal(true).optional() }).strict().parse(await ctx.body());
    const { e, cohort } = await loadEnrollment(c, idParam(ctx), access);
    if (e.version !== b.expected_version) throw conflict("enrollment");
    const decided = ["completed", "incomplete", "withdrawn"].includes(e.state);
    if (decided && (b.attended_sessions || b.score !== undefined || b.withdraw)) throw new ApiError(409, "decided", `The enrollment is already ${e.state}`);
    if (b.certificate_reference !== undefined && e.state !== "completed") throw new ApiError(409, "not_completed", "A certificate is recorded only for a completed enrollment");
    if (b.attended_sessions?.some((s) => s > cohort.sessions)) throw new ApiError(422, "invalid_session", `The cohort has ${cohort.sessions} sessions`);
    const attended = b.attended_sessions ? [...new Set(b.attended_sessions)].sort((x, y) => x - y) : e.attended_sessions;
    const score = b.score === undefined ? e.score : b.score;
    // State follows the handoff sequence: enrolled → attended → assessed (decisions come later).
    const state = b.withdraw ? "withdrawn" : decided ? e.state : score !== null ? "assessed" : attended.length ? "attended" : "enrolled";
    await c.query(`UPDATE training_enrollment SET attended_sessions = $2, score = $3, state = $4, certificate_reference = $5, version = version + 1 WHERE id = $1`,
      [e.id, attended, score, state, b.certificate_reference === undefined ? e.certificate_reference : b.certificate_reference]);
    const changes: Record<string, unknown> = { state };
    if (b.attended_sessions) changes.attended_sessions = attended;
    if (b.score !== undefined) changes.score = score;
    if (b.certificate_reference !== undefined) changes.certificate_reference = b.certificate_reference;
    await audit(c, wsId, actorId(me), b.withdraw ? "training.withdraw" : "training.record", "training_enrollment", e.id, changes, ctx.requestId);
    return { body: { version: e.version + 1, state } };
  }));

  // The completion decision, after the cohort has ended; the cohort's rule determines it.
  r.on("POST", `${W}/training/enrollments/{id}/decide`, (ctx) => scoped(ctx, TRAINERS, async (c, me, wsId, access) => {
    const b = z.object({ expected_version: version }).strict().parse(await ctx.body());
    const { e, cohort } = await loadEnrollment(c, idParam(ctx), access);
    if (e.version !== b.expected_version) throw conflict("enrollment");
    if (["completed", "incomplete", "withdrawn"].includes(e.state)) throw new ApiError(409, "decided", `The enrollment is already ${e.state}`);
    const day = await today(c, wsId);
    if (cohort.end_date > day) throw new ApiError(409, "cohort_not_ended", `The cohort ends on ${cohort.end_date}`);
    const rule = meetsCompletionRule(cohort, e);
    const state = rule.meets ? "completed" : "incomplete";
    await c.query(`UPDATE training_enrollment SET state = $2, completion_date = $3, reviewer = $4, decided_at = now(), rule_version = $5, version = version + 1 WHERE id = $1`,
      [e.id, state, rule.meets ? day : null, actorId(me), cohort.completion_rule_version]);
    await audit(c, wsId, actorId(me), "training.decide", "training_enrollment", e.id, { state, rule_version: cohort.completion_rule_version, ...rule }, ctx.requestId);
    return { body: { state, ...rule, version: e.version + 1 } };
  }));
}
