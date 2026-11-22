// Differencing control for hospital-wide indicator totals (src/reports/disclosure.ts):
// a total must not let a reader subtract the shown departments to recover a small count.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./helpers.ts";
import { disclosureProblems, pooledIndicator } from "../src/reports/disclosure.ts";
import type { DepartmentCell } from "../src/reports/disclosure.ts";

const T = 5;
const v = (numerator: number, denominator: number): DepartmentCell =>
  ({ status: numerator < T || denominator - numerator < T ? "suppressed" : denominator === 0 ? "not_applicable" : "verified", numerator, denominator });
const na: DepartmentCell = { status: "not_applicable", numerator: 0, denominator: 0 };
const target = { target_bp: 8000, direction: "higher_better" };

test("one hidden department: the total would give it away, so it is hidden too", () => {
  const p = pooledIndicator([v(20, 40), v(15, 35), v(3, 30)], T, target);
  assert.deepEqual(p, { status: "suppressed", departments: 3, suppression_reason: "differencing" });
});

test("two hidden departments whose combined counts are not small: the total is shown", () => {
  const p = pooledIndicator([v(20, 40), v(3, 30), v(4, 30)], T, target); // remainder 7 of 60: 7 events, 53 non-events
  assert.deepEqual(p, { status: "verified", departments: 3, numerator: 27, denominator: 100, percent: 27, target_percent: 80, meets_target: false });
});

test("hidden departments whose combined events or non-events are small: hidden", () => {
  assert.equal(pooledIndicator([v(20, 40), v(1, 30), v(2, 30)], T).suppression_reason, "differencing");   // 3 events
  assert.equal(pooledIndicator([v(20, 40), v(28, 30), v(29, 30)], T).suppression_reason, "differencing"); // 3 non-events
});

test("a small total, a total of nothing, and a total with departments still pending", () => {
  assert.deepEqual(pooledIndicator([v(1, 3), v(2, 3)], T), { status: "suppressed", departments: 2, suppression_reason: "small_total" });
  assert.deepEqual(pooledIndicator([na, na], T), { status: "not_applicable", departments: 2 });
  assert.deepEqual(pooledIndicator([v(20, 40), { status: "missing", numerator: null, denominator: null }, { status: "unverified", numerator: 9, denominator: 20 }], T),
    { status: "incomplete", departments: 3, departments_pending: 2 });
  // Zero-eligible departments add 0/0 and reveal nothing; all-verified totals are simply shown.
  assert.equal(pooledIndicator([v(20, 40), v(15, 35), na], T).status, "verified");
  assert.equal(pooledIndicator([v(32, 40), v(40, 50)], T, target).meets_target, true); // 72/90 = 80% exactly meets 80%
});

test("the independent re-check catches an unsafe snapshot", () => {
  const rows = [
    { code: "f", department: "A", status: "verified", numerator: 20, denominator: 40, definition_version: 1 },
    { code: "f", department: "B", status: "suppressed", definition_version: 1 },
  ];
  const leaky = { disclosure_threshold: T, indicators: rows, indicator_totals: [{ code: "f", status: "verified", numerator: 23, denominator: 70, definition_version: 1 }] };
  assert.deepEqual(disclosureProblems(leaky), ["f: the total minus the shown departments reveals a count below 5"]);
  const small = { disclosure_threshold: T, indicators: [{ code: "f", department: "A", status: "verified", numerator: 2, denominator: 40, definition_version: 1 }] };
  assert.deepEqual(disclosureProblems(small), ["f (A): a count below 5 is shown"]);
  const safe = { ...leaky, indicator_totals: [{ code: "f", status: "suppressed", definition_version: 1 }] };
  assert.deepEqual(disclosureProblems(safe), []);
  assert.deepEqual(disclosureProblems({ disclosure_threshold: T, indicators: rows }), [], "older snapshots without totals");
});

// ---- Through the API --------------------------------------------------------------------------
let h: Awaited<ReturnType<typeof harness>>;
let ws: string;
const P = (path: string) => `/v1/workspaces/${ws}${path}`;
const key = () => ({ "idempotency-key": `k-${Math.random().toString(36).slice(2)}` });

before(async () => {
  h = await harness("ih_test_disclosure");
  ({ ws } = await h.provision("disc", ["cardio", "icu", "onco"], {
    director: [["research_director", null]], steward: [["data_steward", null]], reviewer: [["innovastat_reviewer", null]], coordinator: [["coordinator", null]],
  }));
  assert.equal((await h.api("director", "POST", P("/indicator-definitions"), { code: "followup", name: "Follow-up completion", category: "Research operations",
    numerator_definition: "Completed follow-up", denominator_definition: "Due follow-up", direction: "higher_better", target_percent: 80 })).status, 201);
  for (const [d, n, den] of [["cardio", 20, 40], ["icu", 15, 35], ["onco", 3, 30]] as const) {
    assert.equal((await h.api("steward", "PUT", P(`/indicators/${d}/2026-10/followup`), { numerator: n, denominator: den, expected_version: 0 })).status, 200);
  }
  for (const o of (await h.api("reviewer", "GET", P("/indicators?period=2026-10"))).body.items) {
    assert.equal((await h.api("reviewer", "POST", P(`/indicators/${o.id}/verify`), { decision: "verified", expected_version: o.input_version })).status, 200);
  }
});
after(() => h.close());

test("a monthly report hides the hospital-wide total when one department is suppressed, and can be approved", async () => {
  const d = await h.api("coordinator", "POST", P("/report-runs"), { period: "2026-10" }, key());
  assert.equal(d.status, 201);
  const s = (await h.api("reviewer", "GET", P(`/reports/${d.body.id}`))).body.snapshot;
  assert.deepEqual(s.indicators.map((i: any) => `${i.department}:${i.status}`).sort(), ["CARDIO:verified", "ICU:verified", "ONCO:suppressed"]);
  assert.deepEqual(s.indicator_totals, [{ code: "followup", name: "Follow-up completion", definition_version: 1, status: "suppressed", departments: 3, suppression_reason: "differencing" }]);
  assert.deepEqual(disclosureProblems(s), []);
  assert.equal((await h.api("reviewer", "POST", P(`/reports/${d.body.id}/review`), { decision: "approve", digest: d.body.digest })).status, 200);
});

test("approval and release refuse a snapshot that would disclose by differencing", async () => {
  const d = await h.api("coordinator", "POST", P("/report-runs"), { period: "2026-10" }, key());
  // Simulate a builder bug: the stored snapshot shows the total (38/105), giving ONCO = 3/30.
  const leak = JSON.stringify({ code: "followup", name: "Follow-up completion", definition_version: 1, status: "verified", departments: 3, numerator: 38, denominator: 105, percent: 36.19 });
  h.ownerSql(`UPDATE report_revision SET snapshot = jsonb_set(snapshot, '{indicator_totals,0}', '${leak}'::jsonb) WHERE id = '${d.body.id}'`);
  const r = await h.api("reviewer", "POST", P(`/reports/${d.body.id}/review`), { decision: "approve", digest: d.body.digest });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "disclosure_risk");
  assert.deepEqual(r.body.error.details, ["followup: the total minus the shown departments reveals a count below 5"]);
  // Even if it had been approved, release checks again.
  h.ownerSql(`UPDATE report_revision SET status = 'approved', reviewer = 'someone' WHERE id = '${d.body.id}'`);
  const pub = await h.api("director", "POST", P(`/reports/${d.body.id}/publish`), { digest: d.body.digest }, key());
  assert.equal(pub.status, 409);
  assert.equal(pub.body.error.code, "disclosure_risk");
});
