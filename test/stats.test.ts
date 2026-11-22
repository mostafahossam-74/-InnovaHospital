import { test } from "node:test";
import assert from "node:assert/strict";
import { benjaminiHochberg, compareProportions, gammaQ, heterogeneity, normalCdf, spearman, wilson } from "../src/analytics/stats.ts";

const close = (a: number, b: number, tol = 1e-3) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);

test("normal CDF and Wilson interval match reference values", () => {
  close(normalCdf(1.959964), 0.975, 1e-6);
  const [lo, hi] = wilson(32, 40); // reference: 0.6524 to 0.8953
  close(lo, 0.6524); close(hi, 0.8953);
});

test("two-proportion comparison", () => {
  const c = compareProportions(19, 98, 21, 388);
  close(c.rd, 19 / 98 - 21 / 388, 1e-9);
  assert.ok(c.rd_low > 0 && c.rd_high > c.rd);
  assert.ok(c.p_value < 0.001);
  close(compareProportions(10, 100, 10, 100).p_value, 1);
});

test("chi-square survival and heterogeneity", () => {
  close(gammaQ(0.5, 3.841459 / 2), 0.05, 1e-5); // chi2(1) critical value
  close(gammaQ(1, 5.991465 / 2), 0.05, 1e-5);   // chi2(2)
  const h = heterogeneity([{ k: 10, n: 100 }, { k: 10, n: 100 }]);
  close(h.chi2, 0); close(h.p_value, 1);
});

test("Benjamini-Hochberg q values", () => {
  assert.deepEqual(benjaminiHochberg([0.01, 0.04, 0.03, 0.2]).map((q) => Math.round(q * 1e4) / 1e4), [0.04, 0.0533, 0.0533, 0.2]);
});

test("Spearman correlation", () => {
  const s = spearman([1, 2, 3, 4, 5, 6, 7, 8], [2, 4, 6, 8, 10, 12, 14, 16]);
  close(s.rho, 1, 1e-5);
  assert.ok(s.p_value < 0.01);
});
