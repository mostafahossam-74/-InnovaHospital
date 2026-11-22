// The study workbench and the hospital report cycle, end to end:
// hospital uploads Excel → de-identification → (agent/rules propose, statistician confirms)
// dictionary → cleaning → hypotheses → locked plan → validated result → proposal →
// Gaps & Ideas report → hospital approves an idea (project) → results report →
// hospital approves → manuscript drafted, approved, sent.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./helpers.ts";
import { syntheticWorkbook } from "../src/studies/synthetic-workbook.ts";
import type { AgentTask, StudyAgent } from "../src/studies/agent.ts";

/** Fake agent: returns whatever the test queues, to exercise validation and fallback. */
const queue: Partial<Record<AgentTask, unknown>> = {};
const fakeAgent: StudyAgent = { async run(task) { const out = queue[task] ?? null; delete queue[task]; return { output: out, problems: out ? [] : ["no_output"], model: "fake-model" }; } };

let h: Awaited<ReturnType<typeof harness>>;
let ws: string, dept: Record<string, string>;
const P = (p: string) => `/v1/workspaces/${ws}${p}`;
const key = () => ({ "idempotency-key": `k-${Math.random().toString(36).slice(2)}` });

before(async () => {
  h = await harness("ih_test_studies", { agent: fakeAgent });
  ({ ws, dept } = await h.provision("nile", ["cardio", "icu"], {
    steward: [["data_steward", null]], director: [["research_director", null]], coordinator: [["coordinator", null]], pi: [["investigator", "icu"]],
    analyst: [["innovastat_analyst", null]], stat: [["innovastat_reviewer", null]], stat2: [["innovastat_reviewer", null]],
  }));
});
after(() => h.close());

let ds: string;
test("hospital uploads Excel; identifiers never reach storage; the analysis is invisible to the hospital", async () => {
  const xlsx = await syntheticWorkbook(2400, 7);
  const up = await h.api("steward", "POST", P(`/studies/datasets?title=${encodeURIComponent("Inpatient admissions 2025-2026")}&file_name=admissions.xlsx`), xlsx,
    { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  ds = up.body.id;
  assert.equal(up.body.rows, 2400);
  assert.deepEqual(up.body.deidentification.dropped_columns.map((d: any) => d.column).sort(), ["Mobile", "National ID", "Patient Name"]);
  assert.equal(up.body.deidentification.pseudonymised_column, "MRN");
  const stored = h.ownerSql(`SELECT raw::text FROM dataset_row WHERE dataset_id = '${ds}' LIMIT 50`);
  assert.ok(!/MRN-1|Ahmed|Fatma|"29\d{12}"/.test(stored), "identifiers must not be stored");
  // The hospital sees a receipt only.
  const list = await h.api("steward", "GET", P("/studies/datasets"));
  assert.deepEqual(Object.keys(list.body.items[0]).sort(), ["created_at", "department", "file_name", "id", "row_count", "status", "title"]);
  assert.equal((await h.api("director", "GET", P(`/studies/datasets/${ds}`))).status, 403);
  assert.equal((await h.api("steward", "POST", P(`/studies/datasets/${ds}/dictionary/propose`), {})).status, 403);
});

test("dictionary: invalid agent output falls back to rules; only the statistician confirms", async () => {
  queue.dictionary = { entries: [{ source: "Not a column", name: "x", label: "x", role: "age", type: "number", missing_codes: [], positive_values: [], negative_values: [], unit: null, note: null }] };
  const p = await h.api("analyst", "POST", P(`/studies/datasets/${ds}/dictionary/propose`), { mode: "claude" });
  assert.equal(p.status, 200);
  assert.equal(p.body.origin, "rules");
  assert.ok(p.body.fallback_reasons.some((x: string) => /Unknown column/.test(x)));
  assert.deepEqual(p.body.problems_to_resolve, []);
  const roles = Object.fromEntries(p.body.entries.map((e: any) => [e.name, e.role]));
  assert.equal(roles.treatment, "exposure"); assert.equal(roles.died, "outcome"); assert.equal(roles.total_cost_egp, "cost");
  const calls = h.ownerSql(`SELECT accepted FROM agent_call WHERE task = 'dictionary'`).trim();
  assert.equal(calls, "f");
  assert.equal((await h.api("analyst", "POST", P(`/studies/datasets/${ds}/clean`), {})).status, 409);
  let d = (await h.api("analyst", "GET", P(`/studies/datasets/${ds}`))).body;
  assert.equal((await h.api("analyst", "POST", P(`/studies/datasets/${ds}/dictionary/confirm`), { expected_version: d.version })).status, 403);
  // Assigning a statistician restricts confirmation to them.
  assert.equal((await h.api("analyst", "PATCH", P(`/studies/datasets/${ds}`), { expected_version: d.version, statistician: h.actor("stat") })).status, 200);
  d = (await h.api("analyst", "GET", P(`/studies/datasets/${ds}`))).body;
  assert.equal((await h.api("stat2", "POST", P(`/studies/datasets/${ds}/dictionary/confirm`), { expected_version: d.version })).status, 403);
  assert.equal((await h.api("stat", "POST", P(`/studies/datasets/${ds}/dictionary/confirm`), { expected_version: d.version })).status, 200);
});

test("cleaning derives length of stay, splits discovery/validation, and is confirmed", async () => {
  const c = await h.api("analyst", "POST", P(`/studies/datasets/${ds}/clean`), {});
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.rows_out, 2400);
  assert.ok(c.body.derived[0].startsWith("los_days"));
  assert.ok(Math.abs(c.body.split.discovery - 1200) < 120);
  assert.equal((await h.api("analyst", "POST", P(`/studies/datasets/${ds}/hypotheses/generate`), {})).status, 409);
  const d = (await h.api("analyst", "GET", P(`/studies/datasets/${ds}`))).body;
  assert.equal((await h.api("stat", "POST", P(`/studies/datasets/${ds}/cleaning/confirm`), { expected_version: d.version })).status, 200);
});

let hyp: any, econ: any;
test("hypotheses from the discovery half; agent hypotheses with invented numbers are rejected", async () => {
  queue.hypotheses = { hypotheses: [{ kind: "comparative", study_category: "clinical_effectiveness", title: "Made up", statement: "Mortality fell by 73.21%.", exposure: "treatment", treated: "A", reference: "B",
    outcome: "died", outcome_type: "binary", cost: null, diagnosis: null, diagnosis_value: null, rationale: "none" }] };
  const g = await h.api("analyst", "POST", P(`/studies/datasets/${ds}/hypotheses/generate`), { mode: "claude" });
  assert.equal(g.status, 200);
  assert.ok(g.body.fallback_reasons.some((x: string) => /73\.21/.test(x)));
  const all = (await h.api("analyst", "GET", P(`/studies/datasets/${ds}`))).body.hypotheses;
  assert.ok(!all.some((x: any) => x.origin === "claude"));
  hyp = all.find((x: any) => x.kind === "comparative" && /Sepsis/.test(x.title) && x.variables.outcome === "died");
  econ = all.find((x: any) => x.kind === "economic" && /Sepsis/.test(x.title));
  assert.ok(hyp && econ && all.some((x: any) => x.kind === "burden"));
  for (const x of [hyp, econ]) assert.equal((await h.api("stat", "POST", P(`/studies/hypotheses/${x.id}/decision`), { status: "confirmed", reason: "Clinically important and testable", expected_version: 1 })).status, 200);
});

let result: string;
test("plans are locked before running; post-exposure covariates are refused; results run on held-out data", async () => {
  const draft = await h.api("analyst", "POST", P(`/studies/hypotheses/${hyp.id}/plans`), {});
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const plan = draft.body.plan;
  assert.equal(plan.split, "validation");
  assert.equal((await h.api("analyst", "POST", P(`/studies/plans/${draft.body.id}/run`), {})).status, 409);
  const bad = await h.api("analyst", "PATCH", P(`/studies/plans/${draft.body.id}`), { expected_version: 1, plan: { ...plan, covariates: [...plan.covariates, "los_days"] } });
  assert.deepEqual(bad.body.problems_to_resolve, ["los_days is measured after the exposure and must not be a covariate"]);
  assert.equal((await h.api("stat", "POST", P(`/studies/plans/${draft.body.id}/lock`), { expected_version: 2 })).status, 422);
  assert.equal((await h.api("analyst", "PATCH", P(`/studies/plans/${draft.body.id}`), { expected_version: 2, plan })).status, 200);
  const lock = await h.api("stat", "POST", P(`/studies/plans/${draft.body.id}/lock`), { expected_version: 3 });
  assert.equal(lock.status, 200);
  assert.equal((await h.api("analyst", "PATCH", P(`/studies/plans/${draft.body.id}`), { expected_version: 4, plan })).status, 409);
  // An interpretation with a number not in the result is refused; the template is used.
  queue.interpret = { interpretation: "Mortality was halved (OR 0.4321)." };
  const run = await h.api("analyst", "POST", P(`/studies/plans/${draft.body.id}/run`), { interpret: "claude" });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  assert.equal(run.body.interpretation_origin, "template");
  // Direction is fixed by the synthetic data; significance in the held-out half depends on the split, and is reported either way.
  assert.ok(run.body.primary.estimate > 1, "delayed bundle increases mortality in the synthetic data");
  assert.equal(typeof run.body.significant, "boolean");
  assert.match(run.body.interpretation, run.body.significant ? /is statistically significant/ : /not statistically significant/);
  result = run.body.id;
  const r = (await h.api("stat", "GET", P(`/studies/results/${result}`))).body;
  assert.equal(r.plan_sha256, lock.body.sha256);
  assert.equal(r.results.split, "validation");
  // The statistician cannot add numbers that are not in the result.
  assert.equal((await h.api("stat", "POST", P(`/studies/results/${result}/review`), { decision: "accepted", interpretation: "OR 9.99" })).status, 422);
  assert.equal((await h.api("stat", "POST", P(`/studies/results/${result}/review`), { decision: "accepted" })).status, 200);
});

test("economic plan: propensity weighting and bootstrapped cost-effectiveness", async () => {
  const d = await h.api("analyst", "POST", P(`/studies/hypotheses/${econ.id}/plans`), {});
  assert.equal(d.body.plan.method, "iptw");
  assert.ok(d.body.plan.economics);
  await h.api("stat", "POST", P(`/studies/plans/${d.body.id}/lock`), { expected_version: 1 });
  const run = await h.api("stat", "POST", P(`/studies/plans/${d.body.id}/run`), {});
  assert.equal(run.status, 201, JSON.stringify(run.body));
  const r = (await h.api("stat", "GET", P(`/studies/results/${run.body.id}`))).body.results;
  assert.equal(r.economics.bootstrap_replicates, 1000);
  assert.ok(r.balance.every((b: any) => Math.abs(b.smd_after) < 0.1), JSON.stringify(r.balance));
  // The statistician who ran it cannot accept it.
  assert.equal((await h.api("stat", "POST", P(`/studies/results/${run.body.id}/review`), { decision: "accepted" })).status, 403);
});

let proposal: string, report: string, project: string;
test("Gaps & Ideas report: confirmed proposals only, approved by another statistician, then released to the hospital", async () => {
  const pr = await h.api("analyst", "POST", P("/proposals"), { result_id: result, department_id: dept.icu });
  assert.equal(pr.status, 201, JSON.stringify(pr.body));
  proposal = pr.body.id;
  assert.equal((await h.api("director", "GET", P("/proposals"))).body.items.length, 0);
  assert.equal((await h.api("analyst", "POST", P("/client-reports"), { kind: "gaps_ideas", proposal_ids: [proposal] })).status, 409);
  assert.equal((await h.api("stat", "POST", P(`/proposals/${proposal}/confirm`), { expected_version: 1 })).status, 200);
  const r = await h.api("analyst", "POST", P("/client-reports"), { kind: "gaps_ideas", proposal_ids: [proposal] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  report = r.body.id;
  assert.equal((await h.api("director", "GET", P(`/client-reports/${report}`))).status, 404);
  assert.equal((await h.api("analyst", "POST", P(`/client-reports/${report}/release`), { digest: r.body.digest }, key())).status, 409);
  assert.equal((await h.api("stat", "POST", P(`/client-reports/${report}/approve`), { digest: r.body.digest })).status, 200);
  const rel = await h.api("analyst", "POST", P(`/client-reports/${report}/release`), { digest: r.body.digest }, key());
  assert.equal(rel.status, 200, JSON.stringify(rel.body));
  const seen = await h.api("director", "GET", P(`/client-reports/${report}`));
  assert.equal(seen.status, 200);
  assert.equal(typeof seen.body.snapshot.ideas[0].evidence.significant, "boolean");
  const pdf = await h.api("director", "GET", P(`/client-reports/${report}/pdf`));
  assert.equal(pdf.bytes!.subarray(0, 5).toString(), "%PDF-");
});

test("the research director approves an idea, which becomes an ongoing study", async () => {
  const p = (await h.api("director", "GET", P("/proposals"))).body.items[0];
  assert.equal(p.status, "released");
  assert.equal((await h.api("coordinator", "POST", P(`/proposals/${p.id}/hospital-decision`), { decision: "approved", department_id: dept.icu, expected_version: p.version })).status, 403);
  assert.equal((await h.api("director", "POST", P(`/proposals/${p.id}/hospital-decision`), { decision: "approved", expected_version: p.version })).status, 422);
  const ok = await h.api("director", "POST", P(`/proposals/${p.id}/hospital-decision`), { decision: "approved", department_id: dept.icu, pi: h.actor("pi"), expected_version: p.version });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  project = ok.body.project_id;
  const proj = await h.api("pi", "GET", P(`/projects/${project}`));
  assert.equal(proj.body.stage, "draft");
  assert.equal(proj.body.pi, h.actor("pi"));
  assert.equal((await h.api("director", "POST", P(`/proposals/${p.id}/hospital-decision`), { decision: "declined", reason: "x", expected_version: p.version + 1 })).status, 409);
});

test("results report → hospital approval → manuscript drafted, approved by another person, sent", async () => {
  assert.equal((await h.api("analyst", "POST", P(`/projects/${project}/manuscripts`), {})).status, 409);
  const r = await h.api("analyst", "POST", P("/client-reports"), { kind: "results", project_id: project, result_ids: [result] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await h.api("stat", "POST", P(`/client-reports/${r.body.id}/approve`), { digest: r.body.digest });
  await h.api("analyst", "POST", P(`/client-reports/${r.body.id}/release`), { digest: r.body.digest }, key());
  assert.equal((await h.api("director", "POST", P(`/client-reports/${r.body.id}/hospital-decision`), { decision: "returned" })).status, 422);
  assert.equal((await h.api("director", "POST", P(`/client-reports/${r.body.id}/hospital-decision`), { decision: "approved" })).status, 200);
  const m = await h.api("analyst", "POST", P(`/projects/${project}/manuscripts`), {});
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.match(m.body.sections.methods, /validation/);
  assert.equal((await h.api("director", "GET", P(`/manuscripts/${m.body.id}`))).status, 404);
  assert.equal((await h.api("stat", "POST", P(`/manuscripts/${m.body.id}/approve`), {})).status, 200);
  assert.equal((await h.api("analyst", "POST", P(`/manuscripts/${m.body.id}/send`), {})).status, 200);
  const seen = await h.api("director", "GET", P(`/manuscripts/${m.body.id}`));
  assert.equal(seen.status, 200);
  const outputs = (await h.api("pi", "GET", P("/outputs"))).body.items;
  assert.ok(outputs.some((o: any) => o.output_type === "manuscript" && o.project_id === project));
  assert.equal((await h.api("director", "POST", P(`/manuscripts/${m.body.id}/hospital-decision`), { decision: "accepted" })).status, 200);
});
