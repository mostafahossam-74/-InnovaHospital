import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/analytics/engine.ts";
import { detectGaps } from "../src/analytics/gaps.ts";
import { templateIdea, unsupportedNumbers } from "../src/analytics/ideas.ts";
import { synthesize, SYNTH_DEPARTMENTS } from "../src/analytics/synthetic.ts";

const name = (c: string) => SYNTH_DEPARTMENTS.find((d) => d.code === c)!.name;
const { cases, params } = synthesize();
const caseRows = cases.map((c) => ({ ...c, department_id: c.department, department: name(c.department) }));
const paramRows = params.map((p) => ({ ...p, department_id: p.department, department: name(p.department) }));
const portfolio = [{ kind: "project" as const, title: "AMI registry", condition_codes: ["I21.4"], status: "active" }];

test("analysis is deterministic", () => {
  assert.equal(JSON.stringify(analyze(caseRows, paramRows, portfolio)), JSON.stringify(analyze([...caseRows].reverse(), paramRows, portfolio)));
});

test("disease burden shares sum to one and match the counts", () => {
  const a = analyze(caseRows, paramRows, portfolio);
  const total = cases.reduce((s, c) => s + c.cases, 0);
  assert.equal(a.summary.total_cases, total);
  const sum = a.conditions.reduce((s, c) => s + c.cases, 0);
  assert.equal(sum, total);
  const ami = a.conditions.find((c) => c.condition_code === "I21")!;
  assert.equal(ami.cases, cases.filter((c) => c.condition_code === "I21").reduce((s, c) => s + c.cases, 0));
});

test("planted signals become research gaps of every type", () => {
  const gaps = detectGaps(analyze(caseRows, paramRows, portfolio));
  const types = new Set(gaps.map((g) => g.gap_type));
  for (const t of ["management_outcome_variation", "cost_effectiveness", "department_outcome_variation", "parameter_outcome_association", "rising_burden", "high_burden_unstudied"]) {
    assert.ok(types.has(t as never), `missing ${t}`);
  }
  // A condition covered by the portfolio (I21 via I21.4) is not reported as unstudied.
  assert.ok(!gaps.some((g) => g.gap_key === "unstudied:I21"));
  assert.ok(gaps.some((g) => g.gap_key === "param:nurse_to_bed_ratio:deaths"));
  assert.ok(gaps.every((g) => g.priority_score >= 0 && g.priority_score <= 100));
});

test("department confounding does not create a staffing signal", () => {
  // Departments differ in staffing and severity, but within each department staffing is unrelated to outcome.
  const rows = [], prm = [];
  for (const [d, nurses, mort] of [["a", 0.5, 0.05], ["b", 1.5, 0.3]] as const) for (let m = 1; m <= 12; m++) {
    const period = `2026-${String(m).padStart(2, "0")}`;
    rows.push({ period, department_id: d, department: d, condition_code: "A41", condition_label: "Sepsis", management: "x", cases: 100, deaths: Math.round(100 * mort) + (m % 3), readmissions_30d: null, complications: null, los_days_sum: null, cost_sum: null });
    prm.push({ period, department_id: d, department: d, parameter_code: "nurse_to_bed_ratio", parameter_label: "Nurses", value: nurses + (m % 4) / 100, unit: null });
  }
  const a = analyze(rows, prm, []);
  const s = (a.associations as any[]).find((x) => x.outcome === "deaths");
  assert.ok(Math.abs(s.rho) < 0.5, `rho ${s.rho}`);
});

test("template ideas state only the gap's numbers", () => {
  const gaps = detectGaps(analyze(caseRows, paramRows, portfolio));
  for (const g of gaps) {
    const idea = templateIdea({ ...g, id: "x", hospital: "Demo Hospital", currency: "EGP" });
    assert.ok(idea.title && idea.research_question && idea.design);
    assert.deepEqual(unsupportedNumbers(idea, { ...g, id: "x", hospital: "Demo Hospital", currency: "EGP" }), [], g.gap_key);
  }
  const econ = gaps.find((g) => g.gap_type === "cost_effectiveness")!;
  assert.equal(templateIdea({ ...econ, id: "x", hospital: "H", currency: "EGP" }).study_category, "health_economics");
  const bad = { ...templateIdea({ ...econ, id: "x", hospital: "H", currency: "EGP" }), rationale: "Mortality fell by 37.25%." };
  assert.deepEqual(unsupportedNumbers(bad, { ...econ, id: "x", hospital: "H", currency: "EGP" }), [37.25]);
});
