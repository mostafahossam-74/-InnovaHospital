// Monthly executive report workflow (Handoff §5): draft → approve (reviewer
// other than the author) → publish (director other than author and reviewer).
// Approval and release re-build the snapshot and refuse if any input changed.
import { z } from "zod";
import { audit, canonicalJson, sha256 } from "./db.ts";
import type { Client } from "./db.ts";
import { ApiError } from "./http.ts";
import { actorId, ROLES, STAFF } from "./auth.ts";
import { forbidden, idempotent, idParam, notFound, period, text, W } from "./api-common.ts";
import type { RouteDeps } from "./api-common.ts";
import { buildSnapshot } from "./reports/snapshot.ts";
import { renderPdf } from "./reports/pdf.ts";
import { membersWithRoles, notify } from "./notifications.ts";
import { disclosureProblems } from "./reports/disclosure.ts";
import { parseReportKey, reportRange } from "./period.ts";
import type { ObjectStore } from "./storage.ts";

export type ReportDeps = { store: ObjectStore; synthetic?: boolean };

/** Drafts the next revision of a report from a fresh snapshot. `period` is the report key:
 *  one month (YYYY-MM) or a range (YYYY-MM_YYYY-MM). Review and release stay with people. */
export async function draftReport(c: Client, wsId: string, period: string, actor: string, correlationId: string) {
  const snapshot = await buildSnapshot(c, wsId, period);
  const digest = sha256(canonicalJson(snapshot));
  const revision = (await c.query("SELECT coalesce(max(revision),0)+1 AS v FROM report_revision WHERE period = $1", [period])).rows[0].v;
  const id = (await c.query("INSERT INTO report_revision (workspace_id, period, revision, snapshot, digest, author) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
    [wsId, period, revision, snapshot, digest, actor])).rows[0].id;
  await audit(c, wsId, actor, "report.draft", "report_revision", id, { period, revision }, correlationId);
  // InnovaStat reviewers review drafts; without any, the research director can.
  const reviewers = await membersWithRoles(c, ["innovastat_reviewer"]);
  await notify(c, wsId, { kind: "report_review_needed", recipients: reviewers.length ? reviewers : await membersWithRoles(c, ["research_director"]),
    exclude: [actor], entityType: "report_revision", entityId: id, linkPath: `/#/w/${wsId}/reports/${id}`, params: { period }, dedupe: `report_review_needed:${id}` });
  const { start, end, label } = parseReportKey(period);
  return { id, period, period_start: start, period_end: end, period_label: label, revision, digest };
}

/** Refuses to approve or release a snapshot that would disclose a small count (independent re-check). */
function requireSafeDisclosure(snapshot: Parameters<typeof disclosureProblems>[0]) {
  const problems = disclosureProblems(snapshot);
  if (problems.length) throw new ApiError(409, "disclosure_risk", "The report would disclose a count below the hospital's threshold. Draft a new revision.", problems);
}

export function registerReportRoutes({ r, scoped }: RouteDeps, deps: ReportDeps) {
  r.on("POST", `${W}/report-runs`, (ctx) => scoped(ctx, ["coordinator"], async (c, me, wsId) => {
    // One month (period) or a range of months chosen by the coordinator (period_start, period_end).
    const b = z.object({ period: period.optional(), period_start: period.optional(), period_end: period.optional() }).strict()
      .refine((x) => (x.period === undefined) !== (x.period_start === undefined && x.period_end === undefined),
        { message: "Send period, or period_start and period_end" }).parse(await ctx.body());
    let key: string;
    try { key = (b.period ? reportRange(b.period) : reportRange(b.period_start ?? b.period_end!, b.period_end ?? b.period_start)).key; }
    catch (e) { throw new ApiError(422, "invalid_period", (e as Error).message); }
    return idempotent(c, ctx, wsId, `report.draft:${key}`, async () =>
      ({ status: 201, body: await draftReport(c, wsId, key, actorId(me), ctx.requestId) }));
  }));

  r.on("GET", `${W}/reports`, (ctx) => scoped(ctx, ROLES, async (c, _me, _ws, access) => {
    const readerOnly = [...access.roles].every((x) => x === "executive_reader");
    const { rows } = await c.query(`SELECT id, period, revision, digest, status, author, reviewer, review_note, reviewed_at, publisher, published_at, created_at
      FROM report_revision WHERE (NOT $1 OR status IN ('published','superseded')) ORDER BY period DESC, revision DESC`, [readerOnly]);
    return { body: { items: rows } };
  }));

  r.on("GET", `${W}/reports/{id}`, (ctx) => scoped(ctx, ROLES, async (c, _me, _ws, access) => {
    const rep = (await c.query("SELECT * FROM report_revision WHERE id = $1", [idParam(ctx)])).rows[0];
    const readerOnly = [...access.roles].every((x) => x === "executive_reader");
    if (!rep || (readerOnly && !["published", "superseded"].includes(rep.status))) throw notFound("Report");
    let stale: boolean | null = null;
    if (["draft", "approved"].includes(rep.status)) stale = sha256(canonicalJson(await buildSnapshot(c, rep.workspace_id, rep.period))) !== rep.digest;
    return { body: { ...rep, stale } };
  }));

  r.on("POST", `${W}/reports/{id}/review`, (ctx) => scoped(ctx, ["innovastat_reviewer", "research_director"], async (c, me, wsId) => {
    const b = z.object({ decision: z.enum(["approve", "return"]), digest: z.string().length(64), note: text(4000).optional() }).strict()
      .refine((x) => x.decision === "approve" || x.note, { message: "A note is required to return a report", path: ["note"] }).parse(await ctx.body());
    const rep = (await c.query("SELECT * FROM report_revision WHERE id = $1 FOR UPDATE", [idParam(ctx)])).rows[0];
    if (!rep) throw notFound("Report");
    if (rep.status !== "draft") throw new ApiError(409, "invalid_state", `The report is ${rep.status}`);
    if (rep.digest !== b.digest) throw new ApiError(409, "stale_digest", "You reviewed a different version of this report");
    if (rep.author === actorId(me)) throw forbidden("The author cannot review their own report");
    if (b.decision === "approve") requireSafeDisclosure(rep.snapshot);
    if (b.decision === "approve" && sha256(canonicalJson(await buildSnapshot(c, wsId, rep.period))) !== rep.digest) {
      throw new ApiError(409, "inputs_changed", "Report inputs changed after drafting. Draft a new revision.");
    }
    await c.query("UPDATE report_revision SET status = $2, reviewer = $3, review_note = $4, reviewed_at = now() WHERE id = $1",
      [rep.id, b.decision === "approve" ? "approved" : "returned", actorId(me), b.note ?? null]);
    await audit(c, wsId, actorId(me), b.decision === "approve" ? "report.approve" : "report.return", "report_revision", rep.id, { digest: b.digest }, ctx.requestId, b.note);
    const link = { entityType: "report_revision", entityId: rep.id, linkPath: `/#/w/${wsId}/reports/${rep.id}`, params: { period: rep.period } };
    if (b.decision === "approve") {
      // The publisher must differ from author and reviewer.
      await notify(c, wsId, { kind: "report_release_needed", recipients: await membersWithRoles(c, ["research_director"]),
        exclude: [rep.author, actorId(me)], ...link, dedupe: `report_release_needed:${rep.id}` });
    } else {
      // Back to the author; a draft from the scheduler goes to the coordinators, who draft reports.
      const recipients = rep.author.startsWith("service:") ? await membersWithRoles(c, ["coordinator"]) : [rep.author];
      await notify(c, wsId, { kind: "report_returned", recipients, exclude: [actorId(me)], ...link, dedupe: `report_returned:${rep.id}` });
    }
    return { body: { status: b.decision === "approve" ? "approved" : "returned" } };
  }));

  r.on("POST", `${W}/reports/{id}/publish`, (ctx) => scoped(ctx, ["research_director"], async (c, me, wsId) => {
    const b = z.object({ digest: z.string().length(64) }).strict().parse(await ctx.body());
    const id = idParam(ctx);
    return idempotent(c, ctx, wsId, `report.publish:${id}`, async () => {
      const rep = (await c.query("SELECT * FROM report_revision WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!rep) throw notFound("Report");
      if (rep.status !== "approved") throw new ApiError(409, "invalid_state", "Only an approved report can be published");
      if (rep.digest !== b.digest) throw new ApiError(409, "stale_digest", "You are releasing a different version of this report");
      if ([rep.author, rep.reviewer].includes(actorId(me))) throw forbidden("Release needs someone other than the author and the reviewer");
      requireSafeDisclosure(rep.snapshot);
      if (sha256(canonicalJson(await buildSnapshot(c, wsId, rep.period))) !== rep.digest) throw new ApiError(409, "inputs_changed", "Report inputs changed after approval. Draft a new revision.");
      const newer = (await c.query("SELECT max(revision) AS v FROM report_revision WHERE period = $1 AND status IN ('published','superseded')", [rep.period])).rows[0].v;
      if (newer !== null && newer >= rep.revision) throw new ApiError(409, "newer_release", "A newer revision was already released");
      const pdf = await renderPdf(rep.snapshot, { revision: rep.revision, status: "published", digest: rep.digest, synthetic: deps.synthetic });
      const key = `${wsId}/reports/${rep.period}/r${rep.revision}-${rep.id}.pdf`;
      const { sha256: artifactSha } = await deps.store.put(key, pdf);
      await c.query("UPDATE report_revision SET status = 'superseded' WHERE period = $1 AND status = 'published'", [rep.period]);
      await c.query("UPDATE report_revision SET status = 'published', publisher = $2, published_at = now(), artifact_key = $3, artifact_sha256 = $4 WHERE id = $1",
        [rep.id, actorId(me), key, artifactSha]);
      await audit(c, wsId, actorId(me), "report.publish", "report_revision", rep.id, { digest: rep.digest, artifact_sha256: artifactSha }, ctx.requestId);
      return { body: { status: "published", artifact_sha256: artifactSha } };
    });
  }));

  r.on("POST", `${W}/reports/{id}/withdraw`, (ctx) => scoped(ctx, ["research_director"], async (c, me, wsId) => {
    const b = z.object({ reason: text(2000) }).strict().parse(await ctx.body());
    const upd = await c.query("UPDATE report_revision SET status = 'withdrawn' WHERE id = $1 AND status = 'published' RETURNING id", [idParam(ctx)]);
    if (!upd.rowCount) throw new ApiError(409, "invalid_state", "Only a published report can be withdrawn");
    await audit(c, wsId, actorId(me), "report.withdraw", "report_revision", ctx.params.id, {}, ctx.requestId, b.reason);
    return { body: { status: "withdrawn" } };
  }));

  // Published: the stored, hash-checked artifact. Drafts: a watermarked preview for staff.
  r.on("GET", `${W}/reports/{id}/pdf`, (ctx) => scoped(ctx, ROLES, async (c, me, wsId, access) => {
    const rep = (await c.query("SELECT * FROM report_revision WHERE id = $1", [idParam(ctx)])).rows[0];
    const staff = STAFF.some((x) => access.roles.has(x));
    if (!rep || (!staff && !["published", "superseded"].includes(rep.status))) throw notFound("Report");
    const data = rep.artifact_key ? await deps.store.get(rep.artifact_key, rep.artifact_sha256)
      : await renderPdf(rep.snapshot, { revision: rep.revision, status: rep.status, digest: rep.digest, synthetic: deps.synthetic });
    await audit(c, wsId, actorId(me), "report.download", "report_revision", rep.id, { status: rep.status }, ctx.requestId);
    return { body: null, raw: { contentType: "application/pdf", data, headers: { "content-disposition": `attachment; filename="innovahospital-${rep.period}-r${rep.revision}.pdf"` } } };
  }));
}
