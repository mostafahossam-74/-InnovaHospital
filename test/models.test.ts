// The statistics are checked against statsmodels 0.15 and lifelines 0.30 on a
// fixed dataset (test/fixtures/model-validation.json, made by
// scripts/make-model-fixture.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cox, linear, logistic, logRank, welch } from "../src/stats/models.ts";

const F = JSON.parse(readFileSync(new URL("./fixtures/model-validation.json", import.meta.url), "utf8"));
const d = F.data;
const X = d.treat.map((_: number, i: number) => [1, d.treat[i], d.age[i], d.sex[i]]);
const names = ["const", "treat", "age", "sex"];
function same(fit: { coefficients: { estimate: number; se: number; p_value: number }[] }, ref: { params: number[]; bse: number[]; pvalues: number[] }, tol = 1e-6) {
  fit.coefficients.forEach((c, j) => {
    assert.ok(Math.abs(c.estimate - ref.params[j]) < tol * Math.max(1, Math.abs(ref.params[j])), `estimate ${j}: ${c.estimate} vs ${ref.params[j]}`);
    assert.ok(Math.abs(c.se - ref.bse[j]) < tol * Math.max(1, ref.bse[j]), `se ${j}: ${c.se} vs ${ref.bse[j]}`);
    assert.ok(Math.abs(c.p_value - ref.pvalues[j]) < 1e-5, `p ${j}: ${c.p_value} vs ${ref.pvalues[j]}`);
  });
}

test("logistic regression matches statsmodels Logit", () => same(logistic(X, d.death, names), F.logit));
test("weighted logistic with HC0 SEs matches statsmodels GLM", () => same(logistic(X, d.death, names, { weights: d.w, robust: true }), F.logit_w_hc0));
test("OLS matches statsmodels (t-based p values)", () => same(linear(X, d.cost, names), F.ols));
test("WLS with HC0 SEs matches statsmodels", () => same(linear(X, d.cost, names, { weights: d.w, robust: true }), F.wls_hc0));
test("Cox regression (Breslow ties) matches statsmodels PHReg", () =>
  same(cox(d.treat.map((t: number, i: number) => [t, d.age[i]]), d.time, d.event, ["treat", "age"]), F.cox, 1e-5));
test("Welch t test matches scipy", () => {
  const a = d.cost.filter((_: number, i: number) => d.treat[i] === 1), b = d.cost.filter((_: number, i: number) => d.treat[i] === 0);
  assert.ok(Math.abs(welch(a, b).p_value - F.welch.pvalue) < 1e-8);
});
test("log-rank matches lifelines", () => {
  const r = logRank(d.time, d.event, d.treat);
  assert.ok(Math.abs(r.chi2 - F.logrank.chi2) < 1e-6, `${r.chi2} vs ${F.logrank.chi2}`);
  assert.ok(Math.abs(r.p_value - F.logrank.p) < 1e-9);
});
