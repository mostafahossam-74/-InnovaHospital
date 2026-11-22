// The scheduler (src/scheduler.ts): monthly report drafts at each workspace's local
// schedule, the daily expiry sweep, once-only runs, retries and concurrent workers.
// Times are fixed; each workspace's created_at is set back so they are not "new".
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./helpers.ts";
import { ACTIONS, MAX_ATTEMPTS, RETRY_BASE_MS, SCHEDULER_ACTOR, tick } from "../src/scheduler.ts";
import { duePeriod, localDate } from "../src/period.ts";

let h: Awaited<ReturnType<typeof harness>>;
let cairo: string, riyadh: string, riyadhDept: Record<string, string>;
const key = () => ({ "idempotency-key": `k-${Math.random().toString(36).slice(2)}` });
const sql = (q: string) => h.ownerSql(q).trim();
const at = (iso: string) => new Date(iso);

before(async () => {
  h = await harness("ih_test_scheduler");
  const people = { coordinator: [["coordinator", null]], reviewer: [["innovastat_reviewer", null]] } as Record<string, [string, string | null][]>;
  ({ ws: cairo } = await h.provision("cairo", ["cardio"], people));
  ({ ws: riyadh, dept: riyadhDept } = await h.provision("riyadh", ["cardio"], people));
  // Cairo keeps the defaults (day 1, 09:00 Africa/Cairo). Riyadh: day 3 at 08:00 Asia/Riyadh (UTC+3, no DST).
  sql(`UPDATE workspace SET created_at = '2026-01-01' WHERE id = '${cairo}';
       UPDATE workspace SET created_at = '2026-06-10', timezone = 'Asia/Riyadh', report_day = 3, report_hour = 8 WHERE id = '${riyadh}'`);
});
after(() => h.close());

const reports = (ws: string, period: string) => sql(`SELECT count(*) FROM report_revision WHERE workspace_id = '${ws}' AND period = '${period}'`);
const job = (ws: string, kind: string, k: string) =>
  sql(`SELECT status || '|' || attempts FROM scheduled_job WHERE workspace_id = '${ws}' AND kind = '${kind}' AND job_key = '${k}'`);

test("schedule arithmetic: the slot in local month M covers month M-1", () => {
  const riyadhSchedule = { timezone: "Asia/Riyadh", schedule_day: 3, schedule_hour: 8 };
  assert.equal(duePeriod(at("2026-07-03T04:59:00Z"), riyadhSchedule).period, "2026-05");
  const due = duePeriod(at("2026-07-03T05:00:00Z"), riyadhSchedule);
  assert.equal(due.period, "2026-06");
  assert.equal(due.scheduledAt.toISOString(), "2026-07-03T05:00:00.000Z");
  assert.deepEqual(localDate(at("2026-07-03T21:30:00Z"), "Asia/Riyadh").date, "2026-07-04");
});

test("drafts last month's report when the local schedule passes, once", async () => {
  // 07:59 in Riyadh: the July slot has not come. The June slot was before the workspace existed.
  await tick(h.pool, at("2026-07-03T04:59:00Z"));
  assert.equal(job(riyadh, "report_draft", "2026-05"), "");
  assert.equal(job(riyadh, "report_draft", "2026-06"), "");
  // 08:00 in Riyadh: June is drafted by the scheduler.
  const first = await tick(h.pool, at("2026-07-03T05:00:00Z"));
  assert.ok(first.ran.some((j) => j.workspace_id === riyadh && j.kind === "report_draft" && j.job_key === "2026-06" && j.outcome === "done"));
  assert.equal(reports(riyadh, "2026-06"), "1");
  assert.equal(sql(`SELECT author FROM report_revision WHERE workspace_id = '${riyadh}' AND period = '2026-06'`), SCHEDULER_ACTOR);
  assert.equal(sql(`SELECT actor FROM audit_event WHERE workspace_id = '${riyadh}' AND action = 'report.draft'`), SCHEDULER_ACTOR);
  assert.equal(job(riyadh, "report_draft", "2026-06"), "done|1");
  // Later ticks change nothing.
  await tick(h.pool, at("2026-07-03T05:01:00Z"));
  await tick(h.pool, at("2026-07-20T12:00:00Z"));
  assert.equal(reports(riyadh, "2026-06"), "1");
  // A person still reviews the scheduler's draft.
  const draft = (await h.api("reviewer", "GET", `/v1/workspaces/${riyadh}/reports`)).body.items.find((r: any) => r.period === "2026-06");
  const rep = (await h.api("reviewer", "GET", `/v1/workspaces/${riyadh}/reports/${draft.id}`)).body;
  assert.equal((await h.api("reviewer", "POST", `/v1/workspaces/${riyadh}/reports/${draft.id}/review`, { decision: "approve", digest: rep.digest })).status, 200);
});

test("a month a person already drafted is skipped", async () => {
  // (Earlier ticks already drafted Cairo's June on schedule; use a month none has reached.)
  assert.equal((await h.api("coordinator", "POST", `/v1/workspaces/${cairo}/report-runs`, { period: "2026-10" }, key())).status, 201);
  await tick(h.pool, at("2026-11-01T12:00:00Z"));
  assert.equal(reports(cairo, "2026-10"), "1");
  assert.equal(job(cairo, "report_draft", "2026-10"), "done|1");
  assert.equal(sql(`SELECT result->>'skipped' FROM scheduled_job WHERE workspace_id = '${cairo}' AND job_key = '2026-10'`), "already_drafted");
});

test("the expiry sweep runs once per local day and holds a project whose approval lapsed", async () => {
  // An active project whose ethics approval expires on 5 July (Riyadh time).
  const project = sql(`INSERT INTO project (workspace_id, department_id, title, pi, study_type, study_category, stage)
    VALUES ('${riyadh}', '${riyadhDept.cardio}', 'Registry study', 'pi', 'observational', 'epidemiology', 'active') RETURNING id`);
  sql(`INSERT INTO governance_decision (workspace_id, project_id, kind, authority, decision, reference, effective_date, expiry_date, protocol_version, permitted_scope, recorder)
    VALUES ('${riyadh}', '${project}', 'ethics', 'REC', 'approved', 'REC-1', '2026-01-01', '2026-07-05', 1, 'Coded records', 'gov'),
           ('${riyadh}', '${project}', 'data', 'DPO', 'approved', 'DATA-1', '2026-01-01', NULL, 1, 'Coded records', 'gov')`);
  const stage = () => sql(`SELECT stage FROM project WHERE id = '${project}'`);
  assert.equal(job(riyadh, "expiry_check", "2026-07-03"), "done|1");
  await tick(h.pool, at("2026-07-03T20:59:00Z")); // 23:59 in Riyadh
  assert.equal(job(riyadh, "expiry_check", "2026-07-04"), "");
  await tick(h.pool, at("2026-07-03T21:30:00Z")); // 00:30 on the 4th in Riyadh
  assert.equal(job(riyadh, "expiry_check", "2026-07-04"), "done|1");
  assert.equal(sql(`SELECT result->>'expiring_within_60_days' FROM scheduled_job WHERE workspace_id = '${riyadh}' AND job_key = '2026-07-04'`), "1");
  assert.equal(stage(), "active");
  await tick(h.pool, at("2026-07-04T21:30:00Z")); // 5 July: the last valid day
  assert.equal(stage(), "active");
  await tick(h.pool, at("2026-07-05T21:30:00Z")); // 6 July: expired
  assert.equal(stage(), "on_hold");
  assert.equal(sql(`SELECT result->'held'->>0 FROM scheduled_job WHERE workspace_id = '${riyadh}' AND job_key = '2026-07-06'`), project);
  assert.equal(sql(`SELECT actor FROM audit_event WHERE workspace_id = '${riyadh}' AND action = 'project.hold'`), SCHEDULER_ACTOR);
});

test("a failing job is rolled back, retried with backoff, then marked failed and audited", async () => {
  const failing = { ...ACTIONS, report_draft: async (c: any, j: any) => { await ACTIONS.report_draft(c, j); throw new Error("PDF service down"); } };
  let now = at("2026-08-03T05:00:00Z");
  await tick(h.pool, now, failing);
  assert.equal(job(riyadh, "report_draft", "2026-07"), "pending|1");
  assert.equal(reports(riyadh, "2026-07"), "0", "the draft made before the error is rolled back");
  assert.equal(sql(`SELECT last_error FROM scheduled_job WHERE workspace_id = '${riyadh}' AND job_key = '2026-07'`), "PDF service down");
  // Not retried before its time.
  await tick(h.pool, new Date(now.getTime() + RETRY_BASE_MS - 1000), failing);
  assert.equal(job(riyadh, "report_draft", "2026-07"), "pending|1");
  // Retried after 5, 10, 20, 40 minutes, then given up.
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
    now = new Date(now.getTime() + RETRY_BASE_MS * 2 ** (attempt - 1));
    await tick(h.pool, now, failing);
  }
  assert.equal(job(riyadh, "report_draft", "2026-07"), `failed|${MAX_ATTEMPTS}`);
  assert.equal(sql(`SELECT count(*) FROM audit_event WHERE workspace_id = '${riyadh}' AND action = 'scheduler.job_failed'`), "1");
  // A failed job is not run again; it needs a person (who can draft the report themselves).
  await tick(h.pool, at("2026-08-20T00:00:00Z"));
  assert.equal(reports(riyadh, "2026-07"), "0");
});

test("workers running at the same moment draft a month once", async () => {
  const now = at("2026-09-02T00:00:00Z");
  const passes = await Promise.all([tick(h.pool, now), tick(h.pool, now), tick(h.pool, now)]);
  assert.equal(reports(cairo, "2026-08"), "1");
  const ran = passes.flatMap((p) => p.ran).filter((j) => j.workspace_id === cairo && j.kind === "report_draft" && j.job_key === "2026-08");
  assert.deepEqual(ran.map((j) => j.outcome), ["done"]);
});
