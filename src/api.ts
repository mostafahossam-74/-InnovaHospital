// HTTP API: /v1/workspaces/{workspaceId}/... (Handoff §8 API map).
// Every workspace route: authenticate → resolve grants server-side → run
// inside a tenant-scoped transaction (row-level security) → audit mutations.
import { z } from "zod";
import type { Pool } from "./db.ts";
import { audit, withTenant } from "./db.ts";
import { ApiError, Router, encodeCursor, pageParams } from "./http.ts";
import { actorId, isPlatformAdmin, memberships, ROLES, STAFF } from "./auth.ts";
import type { AuthConfig } from "./auth.ts";
import { isValidTimeZone } from "./period.ts";
import { checkLocalSession, LOCAL_ISSUER } from "./local-auth.ts";
import { registerLocalAuthRoutes } from "./api-local-auth.ts";
import { conflict, idParam, makeScoped, notFound, text, version, W, wsParam } from "./api-common.ts";
import { registerDataRoutes } from "./api-data.ts";
import type { DataDeps } from "./api-data.ts";
import { registerOfficeRoutes } from "./api-office.ts";
import { registerTrainingRoutes } from "./api-training.ts";
import { registerReportRoutes } from "./api-reports.ts";
import type { ReportDeps } from "./api-reports.ts";
import { registerStudyRoutes } from "./api-studies.ts";
import type { StudyDeps } from "./api-studies.ts";

const roleEnum = z.enum(ROLES as [string, ...string[]]);
const provisionBody = z.object({
  name: text(160),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  country: z.string().regex(/^[A-Z]{2}$/),
  timezone: z.string().refine(isValidTimeZone, "Unknown IANA timezone").default("Africa/Cairo"),
  currency: z.string().regex(/^[A-Z]{3}$/).default("EGP"),
  locale: z.enum(["en", "ar"]).default("en"),
}).strict();
const grantBody = z.object({
  issuer: z.string().min(1).max(500), subject: text(255), role: roleEnum,
  department_id: z.string().uuid().nullable().default(null),
  grant_end: z.string().date().nullable().default(null),
  email: z.string().email().optional(), display_name: text(200).optional(),
}).strict();
const settingsPatch = z.object({
  expected_version: version,
  name: text(160).optional(),
  timezone: z.string().refine(isValidTimeZone, "Unknown IANA timezone").optional(),
  locale: z.enum(["en", "ar"]).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  small_cell: z.number().int().min(1).max(100).optional(),
  report_day: z.number().int().min(1).max(28).optional(),
  report_hour: z.number().int().min(0).max(23).optional(),
  research_director: text(255).nullable().optional(),
  privacy_contact: text(255).nullable().optional(),
}).strict();
const departmentBody = z.object({
  code: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/), name: text(120),
  site: text(120).optional(), service_line: text(120).optional(), lead: text(255).optional(),
}).strict();

export type Deps = { pool: Pool; auth: AuthConfig; reports: ReportDeps; corsOrigins?: string[]; data?: DataDeps; studies?: Omit<StudyDeps, "store" | "synthetic" | "drafter"> };

export function buildRouter({ pool, auth: authConfig, reports, corsOrigins = [], data = { drafter: null }, studies = { agent: null, deidKey: "dev-only-deid-key" } }: Deps): Router {
  const r = new Router(corsOrigins);
  const auth: AuthConfig = authConfig.local
    ? { ...authConfig, verify: (id, o) => checkLocalSession(pool, id, o.allowPasswordChange) }
    : authConfig;
  if (auth.local) registerLocalAuthRoutes(r, { pool, auth, secret: auth.local.secret });
  const { scoped, identify } = makeScoped(pool, auth);
  const requireAdmin = async (ctx: Parameters<typeof identify>[0]) => {
    const me = await identify(ctx);
    if (!(await isPlatformAdmin(pool, me))) throw new ApiError(403, "forbidden", "Platform admin required");
    return me;
  };

  r.on("GET", "/healthz", async () => { await pool.query("SELECT 1"); return { body: { status: "ok" } }; });

  r.on("GET", "/v1/me", async (ctx) => {
    const me = await identify(ctx);
    const ms = await memberships(pool, me);
    const ids = [...ms.keys()];
    const ws = ids.length ? (await pool.query("SELECT id, name, country, currency, locale FROM workspace WHERE id = ANY($1) ORDER BY name", [ids])).rows : [];
    return { body: {
      issuer: me.issuer, subject: me.subject, email: me.email, name: me.name, platform_admin: await isPlatformAdmin(pool, me),
      workspaces: ws.map((w) => ({ ...w, grants: ms.get(w.id)!.map((g) => ({ role: g.role, department_id: g.departmentId })),
        roles: [...new Set(ms.get(w.id)!.map((g) => g.role))].sort() })),
    } };
  });

  // ---- Platform administration ------------------------------------------------
  r.on("GET", "/v1/admin/workspaces", async (ctx) => {
    await requireAdmin(ctx);
    // Platform admins see identifiers and names only, not tenant data (Handoff §3).
    const { rows } = await pool.query("SELECT id, name, slug, country, active, created_at FROM workspace ORDER BY name");
    return { body: { items: rows } };
  });

  r.on("POST", "/v1/admin/workspaces", async (ctx) => {
    const me = await requireAdmin(ctx);
    const b = provisionBody.parse(await ctx.body());
    const { rows } = await pool.query<{ id: string }>("SELECT provision_workspace($1,$2,$3,$4,$5,$6,$7,$8) AS id",
      [me.issuer, me.subject, b.name, b.slug, b.country, b.timezone, b.currency, b.locale]);
    return { status: 201, body: { id: rows[0].id } };
  });

  r.on("POST", "/v1/admin/workspaces/{workspaceId}/departments", async (ctx) => {
    const me = await requireAdmin(ctx);
    const wsId = wsParam(ctx);
    const b = departmentBody.parse(await ctx.body());
    return withTenant(pool, wsId, async (c) => {
      if (!(await c.query("SELECT 1 FROM workspace WHERE id = $1", [wsId])).rowCount) throw notFound("Workspace");
      const { rows } = await c.query("INSERT INTO department (workspace_id, code, name, site, service_line, lead) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [wsId, b.code, b.name, b.site ?? null, b.service_line ?? null, b.lead ?? null]);
      await audit(c, wsId, actorId(me), "department.create", "department", rows[0].id, { code: b.code }, ctx.requestId);
      return { status: 201, body: { id: rows[0].id } };
    });
  });

  r.on("POST", "/v1/admin/workspaces/{workspaceId}/memberships", async (ctx) => {
    const me = await requireAdmin(ctx);
    const wsId = wsParam(ctx);
    const b = grantBody.parse(await ctx.body());
    return withTenant(pool, wsId, (c) => grant(c, wsId, actorId(me), b, ctx.requestId));
  });

  // ---- Settings, departments, members -------------------------------------------
  r.on("GET", `${W}/settings`, (ctx) => scoped(ctx, ROLES as never, async (c, _me, wsId) => {
    const ws = (await c.query(`SELECT id, name, slug, country, timezone, locale, currency, small_cell, report_day, report_hour,
      research_director, privacy_contact, version, updated_at FROM workspace WHERE id = $1`, [wsId])).rows[0];
    return { body: ws };
  }));

  r.on("PATCH", `${W}/settings`, (ctx) => scoped(ctx, ["hospital_admin"], async (c, me, wsId) => {
    const { expected_version, ...changes } = settingsPatch.parse(await ctx.body());
    const cols = Object.keys(changes) as (keyof typeof changes)[];
    if (!cols.length) throw new ApiError(422, "no_changes", "No changes supplied");
    const sets = cols.map((k, i) => `${k} = $${i + 3}`).join(", ");
    const upd = await c.query(`UPDATE workspace SET ${sets}, version = version + 1, updated_at = now() WHERE id = $1 AND version = $2 RETURNING version`,
      [wsId, expected_version, ...cols.map((k) => changes[k])]);
    if (!upd.rowCount) throw conflict("settings");
    await audit(c, wsId, actorId(me), "settings.update", "workspace", wsId, changes, ctx.requestId);
    return { body: { version: upd.rows[0].version } };
  }));

  r.on("GET", `${W}/departments`, (ctx) => scoped(ctx, ROLES as never, async (c) => {
    const { rows } = await c.query("SELECT id, code, name, site, service_line, lead, active, reporting_inclusion, version FROM department ORDER BY name");
    return { body: { items: rows } };
  }));

  r.on("POST", `${W}/departments`, (ctx) => scoped(ctx, ["hospital_admin"], async (c, me, wsId) => {
    const b = departmentBody.parse(await ctx.body());
    const { rows } = await c.query("INSERT INTO department (workspace_id, code, name, site, service_line, lead) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [wsId, b.code, b.name, b.site ?? null, b.service_line ?? null, b.lead ?? null]);
    await audit(c, wsId, actorId(me), "department.create", "department", rows[0].id, { code: b.code }, ctx.requestId);
    return { status: 201, body: { id: rows[0].id } };
  }));

  r.on("GET", `${W}/memberships`, (ctx) => scoped(ctx, STAFF, async (c) => {
    const { rows } = await c.query(`SELECT m.id, m.issuer, m.subject, m.role, m.department_id, d.name AS department,
        coalesce(la.display_name, m.display_name) AS display_name, coalesce(la.email, m.email) AS email, m.grant_start, m.grant_end
      FROM membership m LEFT JOIN department d ON d.id = m.department_id
      LEFT JOIN local_account la ON m.issuer = $1 AND la.subject::text = m.subject
      WHERE m.active ORDER BY coalesce(la.email, m.email, m.subject), m.role`, [LOCAL_ISSUER]);
    return { body: { items: rows.map((x) => ({ ...x, actor: `${x.issuer}|${x.subject}` })) } };
  }));

  r.on("POST", `${W}/memberships`, (ctx) => scoped(ctx, ["hospital_admin"], async (c, me, wsId) => {
    const b = grantBody.parse(await ctx.body());
    return grant(c, wsId, actorId(me), b, ctx.requestId);
  }));

  r.on("POST", `${W}/memberships/{id}/revoke`, (ctx) => scoped(ctx, ["hospital_admin"], async (c, me, wsId) => {
    const b = z.object({ reason: text(1000) }).strict().parse(await ctx.body());
    const { rows } = await c.query("UPDATE membership SET active = false, revoked_at = now() WHERE id = $1 AND active RETURNING issuer, subject, role",
      [idParam(ctx)]);
    if (!rows.length) throw notFound("Grant");
    await audit(c, wsId, actorId(me), "membership.revoke", "membership", `${rows[0].issuer}|${rows[0].subject}`, { role: rows[0].role }, ctx.requestId, b.reason);
    return { status: 204, body: null };
  }));

  r.on("GET", `${W}/audit`, (ctx) => scoped(ctx, ["hospital_admin", "research_director"], async (c) => {
    const { limit, cursor } = pageParams(ctx.query, 200);
    const entity = ctx.query.get("entity_id");
    const { rows } = await c.query(`SELECT seq, actor, action, entity_type, entity_id, details, reason, correlation_id, created_at FROM audit_event
      WHERE ($1::bigint IS NULL OR seq < $1) AND ($2::text IS NULL OR entity_id = $2) ORDER BY seq DESC LIMIT $3`,
      [cursor, entity, limit + 1]);
    const page = rows.slice(0, limit);
    return { body: { items: page, next_cursor: rows.length > limit ? encodeCursor(String(page.at(-1)!.seq)) : null } };
  }));

  registerDataRoutes({ r, pool, scoped, identify }, data);
  registerOfficeRoutes({ r, pool, scoped, identify });
  registerTrainingRoutes({ r, pool, scoped, identify });
  registerReportRoutes({ r, pool, scoped, identify }, reports);
  registerStudyRoutes({ r, pool, scoped, identify }, { ...studies, drafter: data.drafter, store: reports.store, synthetic: reports.synthetic });
  return r;
}

async function grant(c: import("./db.ts").Client, wsId: string, actor: string, b: z.infer<typeof grantBody>, requestId: string) {
  if (b.department_id && !(await c.query("SELECT 1 FROM department WHERE id = $1", [b.department_id])).rowCount) throw notFound("Department");
  const { rows } = await c.query(
    `INSERT INTO membership (workspace_id, issuer, subject, role, department_id, grant_end, email, display_name, invited_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (workspace_id, issuer, subject, role, coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid))
     DO UPDATE SET active = true, revoked_at = NULL, grant_end = excluded.grant_end RETURNING id`,
    [wsId, b.issuer, b.subject, b.role, b.department_id, b.grant_end, b.email ?? null, b.display_name ?? null, actor]);
  await audit(c, wsId, actor, "membership.grant", "membership", `${b.issuer}|${b.subject}`, { role: b.role, department_id: b.department_id }, requestId);
  return { status: 201, body: { id: rows[0].id, role: b.role, department_id: b.department_id } };
}
