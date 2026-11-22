// Acceptance checks from docs/Developer_Handoff.md §9, run against PostgreSQL
// with the real migrations, row-level security and the HTTP API.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./helpers.ts";
import { synthesize, synthPeriods } from "../src/analytics/synthetic.ts";

let h: Awaited<ReturnType<typeof harness>>;
let ws: string, dept: Record<string, string>, other: string;
const P = (path: string) => `/v1/workspaces/${ws}${path}`;
const key = () => ({ "idempotency-key": `k-${Math.random().toString(36).slice(2)}` });

before(async () => {
  h = await harness("ih_test_api");
  ({ ws, dept } = await h.provision("demo", ["cardio", "icu", "onco", "gim"], {
    admin: [["hospital_admin", null]],
    director: [["research_director", null]],
    coordinator: [["coordinator", null]],
    reviewer: [["innovastat_reviewer", null]],
    analyst: [["innovastat_analyst", null]],
    steward: [["data_steward", null]],
    cardio_steward: [["data_steward", "cardio"]],
    pi: [["investigator", "cardio"]],
    icu_pi: [["investigator", "icu"]],
    governance: [["governance_recorder", null]],
    exec: [["executive_reader", null]],
  }));
  ({ ws: other } = await h.provision("other", ["cardio"], { stranger: [["research_director", null]] }));
});
after(() => h.close());

test("tenant isolation: outsiders get 404 and see nothing", async () => {
  assert.equal((await h.api("stranger", "GET", P("/settings"))).status, 404);
  assert.equal((await h.api("stranger", "GET", P("/gaps"))).status, 404);
  assert.equal((await h.api(null, "GET", P("/settings"))).status, 401);
  assert.equal((await h.api("exec", "POST", P("/ideas"), {})).status, 403);
  const me = await h.api("coordinator", "GET", "/v1/me");
  assert.deepEqual(me.body.workspaces.map((w: any) => w.id), [ws]);
  assert.notEqual(other, ws);
});

let caseUpload: string, paramUpload: string;
test("uploads: department scope, independent verification", async () => {
  const { cases, params } = synthesize(synthPeriods("2026-10", 12));
  // A cardiology-only steward cannot upload ICU data.
  const denied = await h.api("cardio_steward", "POST", P("/uploads"), { kind: "case_aggregates", label: "x", source_method: "HIS export", attestation: true, rows: cases.slice(0, 50) });
  assert.equal(denied.status, 403);
  const bad = await h.api("steward", "POST", P("/uploads"), { kind: "case_aggregates", label: "x", source_method: "HIS", attestation: true,
    rows: [{ ...cases[0], deaths: cases[0].cases + 1 }] });
  assert.equal(bad.status, 422);
  const up = await h.api("steward", "POST", P("/uploads"), { kind: "case_aggregates", label: "Monthly aggregates FY26", source_method: "HIS aggregate export, coded ICD-10", attestation: true, rows: cases });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  caseUpload = up.body.id;
  const pu = await h.api("steward", "POST", P("/uploads"), { kind: "parameters", label: "Staffing", source_method: "Nursing roster", attestation: true, rows: params });
  assert.equal(pu.status, 201);
  paramUpload = pu.body.id;
  // Analysis without verified data fails.
  assert.equal((await h.api("analyst", "POST", P("/analyses"), { period_from: "2025-11", period_to: "2026-10" })).status, 422);
  // The hospital cannot run or read analyses: they are InnovaStat-internal until reported.
  assert.equal((await h.api("coordinator", "POST", P("/analyses"), { period_from: "2025-11", period_to: "2026-10" })).status, 403);
  // The submitter cannot verify their own upload.
  assert.equal((await h.api("steward", "POST", P(`/uploads/${caseUpload}/verify`), { decision: "verified", expected_version: 1 })).status, 403);
  assert.equal((await h.api("reviewer", "POST", P(`/uploads/${caseUpload}/verify`), { decision: "verified", expected_version: 2 })).status, 409);
  assert.equal((await h.api("reviewer", "POST", P(`/uploads/${caseUpload}/verify`), { decision: "verified", expected_version: 1 })).status, 200);
  assert.equal((await h.api("reviewer", "POST", P(`/uploads/${paramUpload}/verify`), { decision: "verified", expected_version: 1 })).status, 200);
});

let gapId: string, analysisId: string;
test("analysis finds research gaps; reviewer other than the analyst decides them", async () => {
  const a = await h.api("analyst", "POST", P("/analyses"), { period_from: "2025-11", period_to: "2026-10" });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  analysisId = a.body.id;
  assert.ok(a.body.gaps >= 10);
  assert.equal((await h.api("pi", "GET", P(`/analyses/${analysisId}`))).status, 403);
  assert.equal((await h.api("director", "GET", P("/gaps"))).status, 403);
  const full = await h.api("reviewer", "GET", P(`/analyses/${analysisId}`));
  assert.equal(full.body.results.summary.departments.length, 4);
  assert.match(full.body.sha256, /^[0-9a-f]{64}$/);
  const gaps = (await h.api("reviewer", "GET", P("/gaps"))).body.items;
  const types = new Set(gaps.map((g: any) => g.gap_type));
  assert.ok(types.has("cost_effectiveness") && types.has("management_outcome_variation") && types.has("high_burden_unstudied"));
  const econ = gaps.find((g: any) => g.gap_type === "cost_effectiveness");
  gapId = econ.id;
  // Ideas need a confirmed gap.
  assert.equal((await h.api("analyst", "POST", P(`/gaps/${gapId}/ideas`), { department_id: dept.cardio })).status, 409);
  // Only the statistician confirms gaps.
  assert.equal((await h.api("analyst", "POST", P(`/gaps/${gapId}/decision`), { status: "confirmed", reason: "ok", expected_version: 1 })).status, 403);
  const d = await h.api("reviewer", "POST", P(`/gaps/${gapId}/decision`), { status: "confirmed", reason: "Material cost difference; no local evaluation", expected_version: 1 });
  assert.equal(d.status, 200);
  assert.equal((await h.api("reviewer", "POST", P(`/gaps/${gapId}/decision`), { status: "rejected", reason: "x", expected_version: 1 })).status, 409);
});

let ideaId: string;
test("research idea: clinician intake, triage and atomic conversion", async () => {
  // Gap-based drafting is InnovaStat-internal; clinicians propose ideas through intake.
  assert.equal((await h.api("analyst", "POST", P(`/gaps/${gapId}/ideas`), { department_id: dept.cardio, mode: "claude" })).status, 503);
  const fromGap = await h.api("analyst", "POST", P(`/gaps/${gapId}/ideas`), { department_id: dept.cardio });
  assert.equal(fromGap.body.study_category, "health_economics");
  assert.equal((await h.api("pi", "POST", P(`/gaps/${gapId}/ideas`), { department_id: dept.cardio })).status, 403);
  assert.equal((await h.api("icu_pi", "POST", P("/ideas"), { department_id: dept.cardio, title: "x", research_question: "q", rationale: "r", design: "d", study_category: "health_economics", population: "p", data_sources: "s" })).status, 403);
  const i = await h.api("pi", "POST", P("/ideas"), { department_id: dept.cardio, title: "Cost-effectiveness of primary PCI", research_question: "Is PCI cost-effective?",
    rationale: "Large cost difference", design: "Cost-effectiveness analysis", study_category: "health_economics", population: "AMI patients", data_sources: "HIS", condition_codes: ["I21"] });
  assert.equal(i.status, 201, JSON.stringify(i.body));
  ideaId = i.body.id;
  assert.equal((await h.api("icu_pi", "GET", P(`/ideas/${ideaId}`))).status, 404);
  assert.equal((await h.api("pi", "POST", P(`/ideas/${ideaId}/transition`), { target: "submitted", expected_version: 1 })).status, 200);
  assert.equal((await h.api("pi", "POST", P(`/ideas/${ideaId}/transition`), { target: "feasibility", expected_version: 2, reason: "x" })).status, 403);
  assert.equal((await h.api("coordinator", "POST", P(`/ideas/${ideaId}/transition`), { target: "returned", expected_version: 2, reason: "Add costing source" })).status, 200);
  assert.equal((await h.api("pi", "PATCH", P(`/ideas/${ideaId}`), { expected_version: 3, data_sources: "HIS + finance costing ledger" })).status, 200);
  assert.equal((await h.api("pi", "PATCH", P(`/ideas/${ideaId}`), { expected_version: 3, data_sources: "stale" })).status, 409);
  for (const [target, v] of [["submitted", 4], ["feasibility", 5], ["accepted", 6]] as const) {
    const r = await h.api(target === "submitted" ? "pi" : "coordinator", "POST", P(`/ideas/${ideaId}/transition`), { target, expected_version: v, reason: "ok", priority: 1 });
    assert.equal(r.status, 200, `${target}: ${JSON.stringify(r.body)}`);
  }
  const hist = (await h.api("pi", "GET", P(`/ideas/${ideaId}`))).body.history;
  assert.ok(hist.some((x: any) => x.to_status === "returned")); // returns preserve history
  const k = key();
  const c1 = await h.api("coordinator", "POST", P(`/ideas/${ideaId}/convert`), { expected_version: 7 }, k);
  const c2 = await h.api("coordinator", "POST", P(`/ideas/${ideaId}/convert`), { expected_version: 7 }, k);
  assert.equal(c1.status, 201);
  assert.equal(c2.body.project_id, c1.body.project_id); // repeated conversion → one project
  assert.equal((await h.api("coordinator", "POST", P(`/ideas/${ideaId}/convert`), { expected_version: 7 }, key())).status, 409);
  projectId = c1.body.project_id;
});

let projectId: string;
test("governance gates: missing, mismatched, expired and revoked decisions", async () => {
  const move = (sub: string, target: string, v: number, reason?: string) => h.api(sub, "POST", P(`/projects/${projectId}/transition`), { target, expected_version: v, reason });
  assert.equal((await move("pi", "submitted", 1)).status, 200);
  assert.equal((await move("pi", "feasibility", 2)).status, 403);
  assert.equal((await move("coordinator", "feasibility", 2)).status, 200);
  assert.equal((await move("coordinator", "governance", 3)).status, 200);
  const blocked = await move("coordinator", "active", 4);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, "gate_failed");
  const decide = (kind: string, extra: Record<string, unknown> = {}) => h.api("governance", "POST", P(`/projects/${projectId}/decisions`), {
    kind, authority: "Hospital REC", decision: "approved", reference: `REC-${kind}`, effective_date: "2026-01-01", expiry_date: "2030-01-01",
    protocol_version: 1, permitted_scope: "Retrospective use of aggregate and coded records", ...extra });
  assert.equal((await h.api("coordinator", "POST", P(`/projects/${projectId}/decisions`), {})).status, 403);
  assert.equal((await decide("ethics", { expiry_date: "2026-02-01" })).status, 201); // already expired
  assert.equal((await decide("data")).status, 201);
  assert.equal((await move("coordinator", "active", 4)).body.error.code, "gate_failed");
  assert.equal((await decide("ethics", { protocol_version: 2 })).status, 201); // wrong protocol version
  assert.equal((await move("coordinator", "active", 4)).body.error.code, "gate_failed");
  assert.equal((await decide("ethics")).status, 201);
  assert.equal((await move("coordinator", "active", 4)).status, 200);
  // Revocation puts an active project on hold.
  const rev = await decide("data", { decision: "revoked", reference: "DATA-REVOKE" });
  assert.equal(rev.body.project_on_hold, true);
  let p = (await h.api("pi", "GET", P(`/projects/${projectId}`))).body;
  assert.equal(p.stage, "on_hold");
  assert.equal((await move("coordinator", "active", p.version)).status, 409);
  await decide("data");
  p = (await h.api("pi", "GET", P(`/projects/${projectId}`))).body;
  assert.equal((await move("coordinator", "active", p.version)).status, 200);
  // An amendment requires approvals for the new protocol version.
  p = (await h.api("pi", "GET", P(`/projects/${projectId}`))).body;
  assert.equal((await h.api("pi", "POST", P(`/projects/${projectId}/amend`), { expected_version: p.version, reason: "Add QALY outcome" })).status, 200);
  p = (await h.api("pi", "GET", P(`/projects/${projectId}`))).body;
  assert.equal(p.stage, "on_hold");
  assert.equal(p.protocol_version, 2);
  assert.ok(p.gate_problems.length === 2);
});

test("indicators: missing, zero, unverified, suppressed and verified stay distinct", async () => {
  const def = await h.api("director", "POST", P("/indicator-definitions"), { code: "followup", name: "Follow-up completion", category: "Research operations",
    numerator_definition: "Participants with completed follow-up", denominator_definition: "Participants due follow-up", direction: "higher_better", target_percent: 80 });
  assert.equal(def.status, 201);
  const put = (sub: string, d: string, n: number, den: number, v = 0) => h.api(sub, "PUT", P(`/indicators/${d}/2026-10/followup`), { numerator: n, denominator: den, expected_version: v });
  assert.equal((await put("cardio_steward", "icu", 1, 2)).status, 403);
  assert.equal((await put("cardio_steward", "cardio", 32, 40)).status, 200);
  assert.equal((await put("steward", "onco", 2, 12)).status, 200);   // small cell
  assert.equal((await put("steward", "gim", 0, 0)).status, 200);     // zero eligible
  assert.equal((await put("steward", "gim", 0, 0)).status, 409);     // stale write
  const rows = (await h.api("reviewer", "GET", P("/indicators?period=2026-10"))).body.items;
  for (const o of rows.filter((x: any) => x.code === "followup")) {
    assert.equal((await h.api("reviewer", "POST", P(`/indicators/${o.id}/verify`), { decision: "verified", expected_version: o.input_version })).status, 200);
  }
});

let reportId: string, digest: string;
test("monthly report: snapshot, separation of duties, freshness, release, download", async () => {
  const d = await h.api("coordinator", "POST", P("/report-runs"), { period: "2026-10" }, key());
  assert.equal(d.status, 201, JSON.stringify(d.body));
  ({ id: reportId, digest } = d.body);
  const rep = (await h.api("director", "GET", P(`/reports/${reportId}`))).body;
  const ind = Object.fromEntries(rep.snapshot.indicators.map((i: any) => [i.department, i]));
  assert.equal(ind.CARDIO.status, "verified");
  assert.equal(ind.CARDIO.meets_target, true);
  assert.equal(ind.ONCO.status, "suppressed");
  assert.equal(ind.ONCO.numerator, undefined);
  assert.equal(ind.GIM.status, "not_applicable");
  assert.equal(ind.ICU.status, "missing");
  assert.equal(rep.snapshot.research_intelligence, null); // nothing released by InnovaStat yet, so nothing internal shows
  assert.ok(rep.snapshot.actions.some((a: any) => /ICU/.test(a.action)));
  assert.ok(rep.snapshot.risks.on_hold.length === 1);
  // Executive readers cannot see drafts.
  assert.equal((await h.api("exec", "GET", P(`/reports/${reportId}`))).status, 404);
  assert.equal((await h.api("exec", "GET", P(`/reports/${reportId}/pdf`))).status, 404);
  // Publishing before approval, wrong digest and self-review all fail.
  assert.equal((await h.api("director", "POST", P(`/reports/${reportId}/publish`), { digest }, key())).status, 409);
  assert.equal((await h.api("reviewer", "POST", P(`/reports/${reportId}/review`), { decision: "approve", digest: "0".repeat(64) })).status, 409);
  // An input edit after drafting makes the draft stale.
  await h.api("steward", "PUT", P("/indicators/icu/2026-10/followup"), { numerator: 20, denominator: 30 });
  assert.equal((await h.api("reviewer", "POST", P(`/reports/${reportId}/review`), { decision: "approve", digest })).body.error.code, "inputs_changed");
  const d2 = await h.api("coordinator", "POST", P("/report-runs"), { period: "2026-10" }, key());
  assert.equal(d2.body.revision, 2);
  assert.equal((await h.api("reviewer", "POST", P(`/reports/${d2.body.id}/review`), { decision: "approve", digest: d2.body.digest })).status, 200);
  assert.equal((await h.api("reviewer", "POST", P(`/reports/${d2.body.id}/publish`), { digest: d2.body.digest }, key())).status, 403);
  const k = key();
  const pub = await h.api("director", "POST", P(`/reports/${d2.body.id}/publish`), { digest: d2.body.digest }, k);
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  assert.deepEqual((await h.api("director", "POST", P(`/reports/${d2.body.id}/publish`), { digest: d2.body.digest }, k)).body, pub.body);
  const pdf = await h.api("exec", "GET", P(`/reports/${d2.body.id}/pdf`));
  assert.equal(pdf.status, 200);
  assert.equal(pdf.bytes!.subarray(0, 5).toString(), "%PDF-");
  assert.equal((await h.api("stranger", "GET", P(`/reports/${d2.body.id}/pdf`))).status, 404);
  const list = (await h.api("exec", "GET", P("/reports"))).body.items;
  assert.deepEqual(list.map((x: any) => x.status), ["published"]);
  // Audit trail is append-only.
  assert.throws(() => h.ownerSql("SET row_security = off; DELETE FROM audit_event"));
  const audit = (await h.api("director", "GET", P("/audit"))).body.items;
  assert.ok(audit.some((e: any) => e.action === "report.publish"));
});

test("row-level security blocks direct cross-tenant reads", async () => {
  const count = (as: string) => h.ownerSql(`SET ROLE ih_web; SELECT set_config('app.workspace_id', '${as}', false); SELECT count(*) FROM case_aggregate;`).trim().split("\n").at(-1);
  assert.ok(Number(count(ws)) > 100);
  assert.equal(count(other), "0");
  // No tenant context at all: nothing is visible.
  assert.equal(h.ownerSql("SET ROLE ih_web; SELECT count(*) FROM research_gap;").trim(), "0");
});
