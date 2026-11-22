// Per-person training records (src/api-training.ts): cohort rules, enrollment, attendance and
// score, completion decisions, the training manager's department scope, and the report KPI.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./helpers.ts";
import { meetsCompletionRule } from "../src/api-training.ts";

let h: Awaited<ReturnType<typeof harness>>;
let ws: string, dept: Record<string, string>, cohort: string;
const P = (path: string) => `/v1/workspaces/${ws}${path}`;
const key = () => ({ "idempotency-key": `k-${Math.random().toString(36).slice(2)}` });
const sql = (q: string) => h.ownerSql(q).trim();
const people: Record<string, string> = {};
const get = async () => (await h.api("coordinator", "GET", P(`/training/${cohort}`))).body;
const enrollment = async (name: string) => (await get()).enrollments.find((e: any) => e.participant_name === name);
const record = async (name: string, body: Record<string, unknown>, who = "coordinator") =>
  h.api(who, "PATCH", P(`/training/enrollments/${people[name]}`), { expected_version: (await enrollment(name)).version, ...body });

before(async () => {
  h = await harness("ih_test_training");
  ({ ws, dept } = await h.provision("train", ["cardio", "icu"], {
    coordinator: [["coordinator", null]], trainer: [["training_manager", "cardio"]], exec: [["executive_reader", null]], reviewer: [["innovastat_reviewer", null]],
  }));
});
after(() => h.close());

test("the completion rule: attendance share and, when required, the pass score", () => {
  const c = { sessions: 4, min_attendance_percent: 75, assessment_required: true, pass_score: 70, completion_rule_version: 1 };
  assert.deepEqual(meetsCompletionRule(c, { attended_sessions: [1, 2, 3], score: 70 }), { meets: true, attendance_percent: 75, reasons: [] });
  assert.deepEqual(meetsCompletionRule(c, { attended_sessions: [1, 2], score: 90 }).reasons, ["attended 50% of sessions, below 75%"]);
  assert.deepEqual(meetsCompletionRule(c, { attended_sessions: [1, 2, 3, 4], score: null }).reasons, ["no assessment score"]);
  assert.deepEqual(meetsCompletionRule(c, { attended_sessions: [1, 1, 2, 3], score: 69 }).reasons, ["score 69 below the pass score 70"], "a session counted twice counts once");
  // Exact: 2 of 3 sessions is 66.67%, below a 67% minimum.
  assert.equal(meetsCompletionRule({ ...c, sessions: 3, min_attendance_percent: 67, assessment_required: false }, { attended_sessions: [1, 2], score: null }).meets, false);
});

test("cohorts state their rule; a training manager works within their department", async () => {
  const base = { title: "Research methods", facilitator: "InnovaStat", start_date: "2026-10-01", end_date: "2026-10-15", sessions: 4,
    min_attendance_percent: 75, assessment_required: true, pass_score: 70, capacity: 4 };
  assert.equal((await h.api("coordinator", "POST", P("/training"), { ...base, pass_score: null })).status, 422, "a required assessment needs a pass score");
  assert.equal((await h.api("trainer", "POST", P("/training"), base)).status, 403, "a cardiology training manager cannot run a hospital-wide cohort");
  assert.equal((await h.api("trainer", "POST", P("/training"), { ...base, department_id: dept.icu })).status, 403);
  const r = await h.api("trainer", "POST", P("/training"), { ...base, department_id: dept.cardio });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  cohort = r.body.id;
  assert.equal((await h.api("exec", "GET", P("/training"))).status, 403);
});

test("enrollment, attendance and score follow enrolled → attended → assessed", async () => {
  for (const [name, email] of [["Amal", "amal@h.invalid"], ["Basel", "basel@h.invalid"], ["Dina", "dina@h.invalid"], ["Omar", null]] as const) {
    const r = await h.api("trainer", "POST", P(`/training/${cohort}/enrollments`), { participant_name: name, participant_email: email, department_id: dept.cardio });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    people[name] = r.body.id;
  }
  assert.equal((await h.api("trainer", "POST", P(`/training/${cohort}/enrollments`), { participant_name: "Amal again", participant_email: "AMAL@h.invalid" })).body.error.code, "cohort_full");
  sql(`UPDATE training_cohort SET capacity = 10 WHERE id = '${cohort}'`);
  assert.equal((await h.api("trainer", "POST", P(`/training/${cohort}/enrollments`), { participant_name: "Amal again", participant_email: "AMAL@h.invalid" })).body.error.code, "already_enrolled");
  assert.equal((await record("Amal", { attended_sessions: [1, 2, 3] })).body.state, "attended");
  assert.equal((await record("Amal", { score: 70 })).body.state, "assessed");
  assert.equal((await record("Basel", { attended_sessions: [1, 2], score: 90 })).body.state, "assessed");
  assert.equal((await record("Dina", { attended_sessions: [1, 2, 3, 4], score: 95 }, "trainer")).body.state, "assessed");
  assert.equal((await record("Omar", { attended_sessions: [5] })).status, 422, "the cohort has 4 sessions");
  assert.equal((await record("Omar", { withdraw: true })).body.state, "withdrawn");
  assert.equal((await h.api("coordinator", "PATCH", P(`/training/enrollments/${people.Amal}`), { expected_version: 1, score: 80 })).status, 409, "stale version");
  // Every attendance and score change is in the audit log.
  assert.equal(sql(`SELECT count(*) FROM audit_event WHERE workspace_id = '${ws}' AND action = 'training.record'`), "4");
  assert.equal(sql(`SELECT count(*) FROM audit_event WHERE workspace_id = '${ws}' AND action = 'training.withdraw'`), "1");
});

test("completion is decided by the rule once the cohort has ended", async () => {
  const future = await h.api("coordinator", "POST", P("/training"), { title: "Next year", facilitator: "F", start_date: "2099-01-01", end_date: "2099-02-01" });
  const f = (await h.api("coordinator", "POST", P(`/training/${future.body.id}/enrollments`), { participant_name: "Early" })).body.id;
  assert.equal((await h.api("coordinator", "POST", P(`/training/enrollments/${f}/decide`), { expected_version: 1 })).body.error.code, "cohort_not_ended");

  const decide = async (name: string) => h.api("coordinator", "POST", P(`/training/enrollments/${people[name]}/decide`), { expected_version: (await enrollment(name)).version });
  const amal = await decide("Amal");
  assert.equal(amal.body.state, "completed");
  const basel = await decide("Basel");
  assert.equal(basel.body.state, "incomplete");
  assert.deepEqual(basel.body.reasons, ["attended 50% of sessions, below 75%"]);
  assert.equal((await decide("Omar")).body.error.code, "decided", "withdrawn people are not decided");
  const a = await enrollment("Amal");
  assert.equal(a.reviewer, h.actor("coordinator"));
  assert.equal(a.rule_version, 1);
  assert.match(a.completion_date, /^\d{4}-\d{2}-\d{2}$/);
  // Decided records are final; a certificate only goes on a completed one.
  assert.equal((await record("Amal", { attended_sessions: [1] })).body.error.code, "decided");
  assert.equal((await record("Basel", { certificate_reference: "CERT-1" })).body.error.code, "not_completed");
  assert.equal((await record("Amal", { certificate_reference: "CERT-0042" })).status, 200);
  assert.equal((await enrollment("Amal")).certificate_reference, "CERT-0042");
  assert.match(sql(`SELECT details->>'reasons' FROM audit_event WHERE workspace_id = '${ws}' AND action = 'training.decide' AND entity_id = '${people.Basel}'`), /below 75%/);
});

test("hand-entered counts only for cohorts without person records", async () => {
  const c = await get();
  assert.equal((await h.api("coordinator", "PATCH", P(`/training/${cohort}`), { expected_version: c.version, enrolled: 9, completed: 9 })).body.error.code, "has_enrollments");
  const old = await h.api("coordinator", "POST", P("/training"), { title: "Older course", facilitator: "F", start_date: "2026-10-01", end_date: "2026-10-20" });
  assert.equal((await h.api("coordinator", "PATCH", P(`/training/${old.body.id}`), { expected_version: 1, enrolled: 10, completed: 7 })).status, 200);
});

test("the report counts people meeting the rule in cohorts that ended in its months", async () => {
  const d = await h.api("coordinator", "POST", P("/report-runs"), { period: "2026-10" }, key());
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const s = (await h.api("reviewer", "GET", P(`/reports/${d.body.id}`))).body.snapshot;
  // Research methods: Amal, Basel, Dina eligible (Omar withdrew); Amal and Dina meet the rule; Dina awaits a decision.
  // Older course: 7 of 10 entered as counts. Next year's cohort has not ended in October.
  assert.deepEqual(s.training.cohorts.map((c: any) => [c.title, c.source, c.eligible, c.completed, c.awaiting_decision]),
    [["Research methods", "records", 3, 2, 1], ["Older course", "counts", 10, 7, null]]);
  assert.deepEqual([s.training.eligible, s.training.completed, s.training.completion_percent, s.training.awaiting_decision], [13, 9, 69.23, 1]);
  assert.ok(s.actions.some((a: any) => a.action === 'Record completion decisions for 1 person in "Research methods"' && a.owner === "Training manager"));
  // November: no cohort ended.
  const nov = await h.api("coordinator", "POST", P("/report-runs"), { period: "2026-11" }, key());
  const sn = (await h.api("reviewer", "GET", P(`/reports/${nov.body.id}`))).body.snapshot;
  assert.deepEqual([sn.training.cohorts_ended, sn.training.completion_percent], [0, null]);
});
