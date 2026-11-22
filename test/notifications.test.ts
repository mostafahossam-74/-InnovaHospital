// The notification outbox (src/notifications.ts): who is told about what, what the email
// says, once-only delivery, revoked or address-less recipients, and send failures.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./helpers.ts";
import { tick } from "../src/scheduler.ts";
import { deliverDue, LogMailer, MAX_SEND_ATTEMPTS, SEND_RETRY_BASE_MS } from "../src/notifications.ts";
import type { Email, Mailer } from "../src/notifications.ts";

let h: Awaited<ReturnType<typeof harness>>;
let ws: string, dept: Record<string, string>;
const BASE = "https://research.example.invalid";
const P = (path: string) => `/v1/workspaces/${ws}${path}`;
const key = () => ({ "idempotency-key": `k-${Math.random().toString(36).slice(2)}` });
const sql = (q: string) => h.ownerSql(q).trim();

class Outbox implements Mailer {
  sent: Email[] = [];
  async send(e: Email) { this.sent.push(e); return { id: `m${this.sent.length}` }; }
  to(addr: string) { return this.sent.filter((e) => e.to === addr); }
  take() { const s = this.sent; this.sent = []; return s; }
}
const mail = new Outbox();
const deliver = (m: Mailer = mail, now = new Date()) => deliverDue(h.pool, now, m, BASE);
const addr = (sub: string) => `${sub}@hospital.example.invalid`;
const recipients = (sent: Email[]) => sent.map((e) => e.to).sort();

before(async () => {
  h = await harness("ih_test_notifications");
  ({ ws, dept } = await h.provision("notify", ["cardio", "icu"], {
    coordinator: [["coordinator", null]], cardio_coord: [["coordinator", "cardio"]], icu_coord: [["coordinator", "icu"]],
    reviewer: [["innovastat_reviewer", null]], reviewer2: [["innovastat_reviewer", null]], noemail: [["innovastat_reviewer", null]],
    director: [["research_director", null]], pi: [["investigator", "cardio"]],
  }));
  sql(`UPDATE membership SET email = subject || '@hospital.example.invalid' WHERE workspace_id = '${ws}' AND subject <> 'noemail';
       UPDATE workspace SET created_at = '2026-01-01' WHERE id = '${ws}'`);
});
after(() => h.close());

test("a coordinator's draft for a range of months tells the reviewers, once", async () => {
  const d = await h.api("coordinator", "POST", P("/report-runs"), { period_start: "2026-01", period_end: "2026-02" }, key());
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.equal(d.body.period, "2026-01_2026-02");
  await deliver();
  assert.deepEqual(recipients(mail.take()), [addr("reviewer"), addr("reviewer2")].sort(), "not the director, the coordinators or the author");
  const rows = sql(`SELECT recipient || ':' || status FROM notification WHERE workspace_id = '${ws}' AND kind = 'report_review_needed' ORDER BY 1`);
  assert.match(rows, /\|noemail:skipped/, "a reviewer with no email address is skipped, not retried");
  assert.equal(sql(`SELECT sent_to FROM notification WHERE workspace_id = '${ws}' AND recipient LIKE '%|reviewer2'`), addr("reviewer2"));
  // Nothing is sent twice: not by another delivery pass, nor by a scheduler tick.
  await tick(h.pool, new Date());
  await deliver();
  assert.equal(mail.take().filter((e) => /ready for review/.test(e.subject)).length, 0);
});

test("message wording: what to do and a link, nothing from the report", async () => {
  const out = new Outbox();
  sql(`UPDATE notification SET status = 'pending', attempts = 0 WHERE workspace_id = '${ws}' AND kind = 'report_review_needed' AND recipient LIKE '%|reviewer'`);
  await deliverDue(h.pool, new Date(), out, BASE);
  const report = sql(`SELECT id FROM report_revision WHERE workspace_id = '${ws}' AND period = '2026-01_2026-02'`);
  assert.equal(out.sent.length, 1);
  assert.equal(out.sent[0].subject, "[notify Hospital] Report for January–February 2026 is ready for review");
  assert.equal(out.sent[0].text, `The report for January–February 2026 has been drafted and is waiting for review.\n\nSign in to review it:\n` +
    `${BASE}/#/w/${ws}/reports/${report}\n\nThis message does not include any report or project details. Sign in to see them.\n`);
});

test("approval tells the research director; a return goes back to the author", async () => {
  // Returning a person's draft goes back to that person only.
  const report = sql(`SELECT id FROM report_revision WHERE workspace_id = '${ws}' AND period = '2026-01_2026-02'`);
  const digest = (await h.api("reviewer", "GET", P(`/reports/${report}`))).body.digest;
  assert.equal((await h.api("reviewer", "POST", P(`/reports/${report}/review`), { decision: "return", digest, note: "Check totals" })).status, 200);
  await deliver();
  assert.deepEqual(recipients(mail.take()), [addr("coordinator")]);
  // On approval, the director.
  const d = await h.api("coordinator", "POST", P("/report-runs"), { period: "2026-02" }, key());
  await deliver();
  assert.deepEqual(recipients(mail.take()), [addr("reviewer"), addr("reviewer2")].sort());
  assert.equal((await h.api("reviewer2", "POST", P(`/reports/${d.body.id}/review`), { decision: "approve", digest: d.body.digest })).status, 200);
  await deliver();
  const sent = mail.take();
  assert.deepEqual(recipients(sent), [addr("director")]);
  assert.match(sent[0].subject, /Report for February 2026 is ready for release/);
  // A draft written by an earlier version's automatic scheduler goes to the coordinators when returned.
  const d2 = await h.api("coordinator", "POST", P("/report-runs"), { period: "2026-03" }, key());
  await deliver(); mail.take();
  sql(`UPDATE report_revision SET author = 'service:scheduler' WHERE id = '${d2.body.id}'`);
  assert.equal((await h.api("reviewer", "POST", P(`/reports/${d2.body.id}/review`), { decision: "return", digest: d2.body.digest, note: "Add ICU" })).status, 200);
  await deliver();
  assert.deepEqual(recipients(mail.take()), [addr("cardio_coord"), addr("coordinator"), addr("icu_coord")]);
});

test("a project put on hold tells its PI and that department's coordinators", async () => {
  const pi = h.actor("pi");
  const project = sql(`INSERT INTO project (workspace_id, department_id, title, pi, study_type, study_category, stage)
    VALUES ('${ws}', '${dept.cardio}', 'Registry', '${pi}', 'observational', 'epidemiology', 'active') RETURNING id`);
  sql(`INSERT INTO governance_decision (workspace_id, project_id, kind, authority, decision, reference, effective_date, expiry_date, protocol_version, permitted_scope, recorder)
    VALUES ('${ws}', '${project}', 'ethics', 'REC', 'approved', 'REC-1', '2026-01-01', '2026-04-10', 1, 'Coded records', 'gov'),
           ('${ws}', '${project}', 'data', 'DPO', 'approved', 'DATA-1', '2026-01-01', NULL, 1, 'Coded records', 'gov')`);
  await tick(h.pool, new Date("2026-04-11T12:00:00Z")); // the sweep on 11 April holds it
  assert.equal(sql(`SELECT stage FROM project WHERE id = '${project}'`), "on_hold");
  await deliver();
  const sent = mail.take().filter((e) => /on hold/.test(e.subject));
  assert.deepEqual(recipients(sent), [addr("cardio_coord"), addr("coordinator"), addr("pi")], "not the ICU coordinator");
  assert.ok(sent.every((e) => e.text.includes(`${BASE}/#/w/${ws}/projects/${project}`) && !/expired|REC-1|ethics/.test(e.text)));
});

test("an edit refused for lapsed approvals still holds the project, audits it and tells the PI", async () => {
  const project = sql(`INSERT INTO project (workspace_id, department_id, title, pi, study_type, study_category, stage)
    VALUES ('${ws}', '${dept.icu}', 'ICU registry', '${h.actor("pi")}', 'observational', 'epidemiology', 'active') RETURNING id`);
  sql(`INSERT INTO governance_decision (workspace_id, project_id, kind, authority, decision, reference, effective_date, expiry_date, protocol_version, permitted_scope, recorder)
    VALUES ('${ws}', '${project}', 'ethics', 'REC', 'approved', 'REC-2', '2026-01-01', '2026-02-01', 1, 'Coded records', 'gov'),
           ('${ws}', '${project}', 'data', 'DPO', 'approved', 'DATA-2', '2026-01-01', NULL, 1, 'Coded records', 'gov')`);
  const milestone = sql(`INSERT INTO milestone (workspace_id, project_id, title, owner, due_date) VALUES ('${ws}', '${project}', 'Data lock', 'pi', '2026-12-01') RETURNING id`);
  const r = await h.api("coordinator", "PATCH", P(`/milestones/${milestone}`), { expected_version: 1, state: "in_progress" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "approval_invalid");
  assert.equal(sql(`SELECT stage FROM project WHERE id = '${project}'`), "on_hold", "the hold is kept although the edit is refused");
  assert.equal(sql(`SELECT count(*) FROM audit_event WHERE workspace_id = '${ws}' AND action = 'project.hold' AND entity_id = '${project}'`), "1");
  assert.equal(sql(`SELECT state || '|' || version FROM milestone WHERE id = '${milestone}'`), "planned|1", "the refused edit itself is not saved");
  await deliver();
  assert.deepEqual(recipients(mail.take()), [addr("icu_coord"), addr("pi")], "the PI and ICU's coordinator; not the coordinator who made the edit, who saw the refusal");
});

test("revoked access stops mail that was already queued", async () => {
  const d = await h.api("coordinator", "POST", P("/report-runs"), { period: "2026-04" }, key());
  assert.equal(d.status, 201);
  sql(`UPDATE membership SET active = false, revoked_at = now() WHERE workspace_id = '${ws}' AND subject = 'reviewer2'`);
  await deliver();
  assert.deepEqual(recipients(mail.take()), [addr("reviewer")]);
  assert.equal(sql(`SELECT status FROM notification WHERE workspace_id = '${ws}' AND entity_id = '${d.body.id}' AND recipient LIKE '%|reviewer2'`), "skipped");
});

test("a failing send is retried with backoff, then marked failed", async () => {
  const down: Mailer = { send: async () => { throw new Error("SMTP 421 try later"); } };
  const d = await h.api("coordinator", "POST", P("/report-runs"), { period: "2026-05" }, key());
  const status = () => sql(`SELECT status || '|' || attempts FROM notification WHERE workspace_id = '${ws}' AND entity_id = '${d.body.id}' AND recipient LIKE '%|reviewer'`);
  let now = new Date(Date.now() + 1000);
  await deliver(down, now);
  assert.equal(status(), "pending|1");
  await deliver(down, new Date(now.getTime() + SEND_RETRY_BASE_MS - 1000));
  assert.equal(status(), "pending|1", "not before its retry time");
  for (let attempt = 1; attempt < MAX_SEND_ATTEMPTS; attempt++) {
    now = new Date(now.getTime() + SEND_RETRY_BASE_MS * 2 ** (attempt - 1));
    await deliver(down, now);
  }
  assert.equal(status(), `failed|${MAX_SEND_ATTEMPTS}`);
  assert.equal(sql(`SELECT last_error FROM notification WHERE workspace_id = '${ws}' AND entity_id = '${d.body.id}' AND recipient LIKE '%|reviewer'`), "SMTP 421 try later");
  await deliver(mail, new Date(now.getTime() + 86_400_000));
  assert.equal(mail.take().length, 0, "a failed notice is not sent later");
});

test("a scheduled job that fails for good tells the coordinators", async () => {
  const broken = { expiry_check: async () => { throw new Error("boom"); } };
  let now = new Date("2026-07-01T06:00:00Z"); // 1 July in Cairo; retries fit within the day
  for (let i = 0; i < 5; i++) { await tick(h.pool, now, { actions: broken }); now = new Date(now.getTime() + 3 * 3_600_000); }
  assert.equal(sql(`SELECT status FROM scheduled_job WHERE workspace_id = '${ws}' AND kind = 'expiry_check' AND job_key = '2026-07-01'`), "failed");
  await deliver();
  const sent = mail.take().filter((e) => /scheduled task/.test(e.subject));
  assert.deepEqual(recipients(sent), [addr("cardio_coord"), addr("coordinator"), addr("icu_coord")]);
  assert.match(sent[0].text, /scheduled governance expiry check for 2026-07-01 failed after 5 attempts/);
  assert.ok(sent[0].text.includes(`${BASE}/#/w/${ws}/projects`));
});

test("the log transport writes the email to the log instead of sending it", async () => {
  const lines: string[] = [];
  const r = await new LogMailer((l) => lines.push(l)).send({ to: "a@b.invalid", subject: "S", text: "T" });
  assert.match(r.id, /^log-/);
  assert.deepEqual(JSON.parse(lines[0]), { level: "info", msg: "email (log transport, not sent)", id: r.id, to: "a@b.invalid", subject: "S", text: "T" });
});
