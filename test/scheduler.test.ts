// The scheduler (src/scheduler.ts): the daily expiry sweep in each workspace's timezone,
// once-only runs, retries, concurrent workers, and no automatic report drafts.
// Times are fixed; each workspace's created_at is set back.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./helpers.ts";
import { ACTIONS, MAX_ATTEMPTS, RETRY_BASE_MS, SCHEDULER_ACTOR, tick } from "../src/scheduler.ts";
import type { JobAction } from "../src/scheduler.ts";
import { localDate } from "../src/period.ts";

let h: Awaited<ReturnType<typeof harness>>;
let cairo: string, riyadh: string, riyadhDept: Record<string, string>;
const sql = (q: string) => h.ownerSql(q).trim();
const at = (iso: string) => new Date(iso);

before(async () => {
  h = await harness("ih_test_scheduler");
  const people = { coordinator: [["coordinator", null]], reviewer: [["innovastat_reviewer", null]] } as Record<string, [string, string | null][]>;
  ({ ws: cairo } = await h.provision("cairo", ["cardio"], people));
  ({ ws: riyadh, dept: riyadhDept } = await h.provision("riyadh", ["cardio"], people));
  // Cairo keeps the default timezone (Africa/Cairo); Riyadh is UTC+3 with no daylight saving.
  sql(`UPDATE workspace SET created_at = '2026-01-01' WHERE id IN ('${cairo}', '${riyadh}');
       UPDATE workspace SET timezone = 'Asia/Riyadh' WHERE id = '${riyadh}'`);
});
after(() => h.close());

const job = (ws: string, kind: string, k: string) =>
  sql(`SELECT status || '|' || attempts FROM scheduled_job WHERE workspace_id = '${ws}' AND kind = '${kind}' AND job_key = '${k}'`);
const reports = (ws: string) => sql(`SELECT count(*) FROM report_revision WHERE workspace_id = '${ws}'`);

test("local dates follow each workspace's timezone", () => {
  assert.equal(localDate(at("2026-07-03T20:59:00Z"), "Asia/Riyadh").date, "2026-07-03");
  assert.equal(localDate(at("2026-07-03T21:00:00Z"), "Asia/Riyadh").date, "2026-07-04");
  assert.equal(localDate(at("2026-07-03T21:00:00Z"), "Asia/Riyadh").midnight.toISOString(), "2026-07-03T21:00:00.000Z");
});

test("reports are not drafted automatically: only the daily sweep is queued", async () => {
  const r = await tick(h.pool, at("2026-07-03T12:00:00Z"));
  assert.equal(r.queued, 2, "one expiry sweep per workspace");
  assert.deepEqual(sql(`SELECT DISTINCT kind FROM scheduled_job`), "expiry_check");
  assert.equal(reports(cairo), "0");
  assert.equal(reports(riyadh), "0");
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
  await tick(h.pool, at("2026-07-04T21:30:00Z")); // 5 July: the last valid day
  assert.equal(stage(), "active");
  await tick(h.pool, at("2026-07-05T21:30:00Z")); // 6 July: expired
  assert.equal(stage(), "on_hold");
  assert.equal(sql(`SELECT result->'held'->>0 FROM scheduled_job WHERE workspace_id = '${riyadh}' AND job_key = '2026-07-06'`), project);
  assert.equal(sql(`SELECT actor FROM audit_event WHERE workspace_id = '${riyadh}' AND action = 'project.hold'`), SCHEDULER_ACTOR);
  // Later ticks the same day change nothing.
  await tick(h.pool, at("2026-07-05T22:00:00Z"));
  assert.equal(sql(`SELECT count(*) FROM audit_event WHERE workspace_id = '${riyadh}' AND action = 'project.hold'`), "1");
});

test("a failing job is rolled back, retried with backoff, then marked failed and audited", async () => {
  const failing: JobAction = async (c, j) => {
    await c.query("UPDATE project SET title = 'changed by a failed run' WHERE stage = 'on_hold'");
    void j; throw new Error("database maintenance");
  };
  const actions = { ...ACTIONS, expiry_check: failing };
  let now = at("2026-08-03T12:00:00Z");
  await tick(h.pool, now, { actions });
  assert.equal(job(riyadh, "expiry_check", "2026-08-03"), "pending|1");
  assert.equal(sql(`SELECT count(*) FROM project WHERE title = 'changed by a failed run'`), "0", "the failed run's changes are rolled back");
  assert.equal(sql(`SELECT last_error FROM scheduled_job WHERE workspace_id = '${riyadh}' AND job_key = '2026-08-03'`), "database maintenance");
  await tick(h.pool, new Date(now.getTime() + RETRY_BASE_MS - 1000), { actions });
  assert.equal(job(riyadh, "expiry_check", "2026-08-03"), "pending|1", "not before its retry time");
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
    now = new Date(now.getTime() + RETRY_BASE_MS * 2 ** (attempt - 1));
    await tick(h.pool, now, { actions });
  }
  assert.equal(job(riyadh, "expiry_check", "2026-08-03"), `failed|${MAX_ATTEMPTS}`);
  assert.equal(sql(`SELECT count(*) FROM audit_event WHERE workspace_id = '${riyadh}' AND action = 'scheduler.job_failed'`), "1");
});

test("workers running at the same moment run each job once", async () => {
  const now = at("2026-09-02T12:00:00Z");
  const passes = await Promise.all([tick(h.pool, now), tick(h.pool, now), tick(h.pool, now)]);
  const ran = passes.flatMap((p) => p.ran).filter((j) => j.kind === "expiry_check" && j.job_key === "2026-09-02");
  assert.equal(ran.length, 2, "one sweep per workspace, not three");
  assert.deepEqual(ran.map((j) => j.outcome), ["done", "done"]);
});

test("a monthly draft job left from an earlier version is closed without drafting", async () => {
  sql(`INSERT INTO scheduled_job (workspace_id, kind, job_key, scheduled_at, next_attempt_at) VALUES ('${cairo}', 'report_draft', '2026-08', '2026-09-01', '2026-09-01')`);
  await tick(h.pool, at("2026-09-02T13:00:00Z"));
  assert.equal(job(cairo, "report_draft", "2026-08"), "done|0");
  assert.equal(sql(`SELECT result->>'skipped' FROM scheduled_job WHERE workspace_id = '${cairo}' AND kind = 'report_draft'`), "no_longer_scheduled");
  assert.equal(reports(cairo), "0");
});
