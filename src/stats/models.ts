// Patient-level statistical models for study analyses. Pure TypeScript, no
// dependencies; validated against statsmodels in test/models.test.ts.
//   - weighted least squares (classical or HC0 robust SEs, t-based p values)
//   - logistic regression by IRLS (model-based or HC0 robust SEs)
//   - Cox proportional hazards (Breslow ties, Newton-Raphson)
//   - Kaplan-Meier medians and the log-rank test
//   - propensity scores and stabilised inverse-probability weights
//   - Welch t test, standardised mean differences
import { Z95 } from "../analytics/stats.ts";

export type Matrix = number[][];

// ---- Linear algebra (small dense matrices) --------------------------------------
export function invert(a: Matrix): Matrix {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-12) throw new SingularError();
    [m[c], m[piv]] = [m[piv], m[c]];
    const d = m[c][c];
    for (let j = 0; j < 2 * n; j++) m[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c && m[r][c] !== 0) {
      const f = m[r][c];
      for (let j = 0; j < 2 * n; j++) m[r][j] -= f * m[c][j];
    }
  }
  return m.map((row) => row.slice(n));
}
export class SingularError extends Error { constructor() { super("Model matrix is singular (collinear covariates or a level with no variation)"); } }

const matVec = (a: Matrix, v: number[]) => a.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
/** X' diag(w) X */
function xtwx(X: Matrix, w: number[]): Matrix {
  const p = X[0].length, out: Matrix = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < X.length; i++) {
    const xi = X[i], wi = w[i];
    if (wi === 0) continue;
    for (let a = 0; a < p; a++) { const v = wi * xi[a]; if (v === 0) continue; for (let b = a; b < p; b++) out[a][b] += v * xi[b]; }
  }
  for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) out[a][b] = out[b][a];
  return out;
}
const sandwich = (bread: Matrix, meat: Matrix) => { const t = bread.map((row) => meat[0].map((_, j) => row.reduce((s, x, k) => s + x * meat[k][j], 0))); return t.map((row) => bread[0].map((_, j) => row.reduce((s, x, k) => s + x * bread[k][j], 0))); };

// ---- Distributions ----------------------------------------------------------------
function lnGamma(x: number): number {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1; let a = 0.99999999999980993; const t = x + 7.5;
  g.forEach((c, i) => { a += c / (x + i + 1); });
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function betacf(a: number, b: number, x: number): number {
  let c = 1, d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < 1e-300) d = 1e-300;
  d = 1 / d; let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300; c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300; c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return h;
}
/** Regularised incomplete beta I_x(a, b). */
export function ibeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** Two-sided p value of Student's t. */
export const tPValue = (t: number, df: number) => (Number.isFinite(df) && df > 0 ? ibeta(df / (df + t * t), df / 2, 0.5) : 1 - gammaP(0.5, (t * t) / 2));
/** Quantile of Student's t (bisection on the CDF). */
export function tQuantile(p: number, df: number): number {
  if (!Number.isFinite(df) || df > 1e6) return Z95;
  let lo = 0, hi = 50;
  for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; (tPValue(mid, df) / 2 > 1 - p) ? (lo = mid) : (hi = mid); }
  return (lo + hi) / 2;
}
export const chiSquareP = (x: number, df: number) => 1 - gammaP(df / 2, x / 2);
function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) { let sum = 1 / a, del = sum, ap = a; for (let i = 0; i < 500; i++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-15) break; } return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a)); }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) { const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300; c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-15) break; }
  return 1 - Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

// ---- Model results ------------------------------------------------------------------
export type Coef = { term: string; estimate: number; se: number; low: number; high: number; p_value: number; statistic: number };
export type Fit = { coefficients: Coef[]; n: number; df_resid: number; converged: boolean; iterations: number; extra: Record<string, number> };

function coefTable(names: string[], beta: number[], cov: Matrix, df: number): Coef[] {
  const q = tQuantile(0.975, df);
  return names.map((term, j) => {
    const se = Math.sqrt(Math.max(cov[j][j], 0));
    const stat = beta[j] / se;
    return { term, estimate: beta[j], se, statistic: stat, low: beta[j] - q * se, high: beta[j] + q * se, p_value: tPValue(stat, df) };
  });
}

/** Weighted least squares. `robust` gives HC0 standard errors (with normal reference, as statsmodels does). */
export function linear(X: Matrix, y: number[], names: string[], opts: { weights?: number[]; robust?: boolean } = {}): Fit {
  const n = X.length, p = X[0].length, w = opts.weights ?? new Array(n).fill(1);
  const inv = invert(xtwx(X, w));
  const xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) for (let a = 0; a < p; a++) xty[a] += w[i] * X[i][a] * y[i];
  const beta = matVec(inv, xty);
  const resid = X.map((x, i) => y[i] - x.reduce((s, v, j) => s + v * beta[j], 0));
  const df = n - p;
  let cov: Matrix;
  if (opts.robust) cov = sandwich(inv, xtwx(X, resid.map((e, i) => w[i] * w[i] * e * e)));
  else { const s2 = resid.reduce((s, e, i) => s + w[i] * e * e, 0) / df; cov = inv.map((r) => r.map((v) => v * s2)); }
  const ybar = y.reduce((s, v, i) => s + w[i] * v, 0) / w.reduce((s, v) => s + v, 0);
  const sst = y.reduce((s, v, i) => s + w[i] * (v - ybar) ** 2, 0), sse = resid.reduce((s, e, i) => s + w[i] * e * e, 0);
  return { coefficients: coefTable(names, beta, cov, opts.robust ? Infinity : df), n, df_resid: df, converged: true, iterations: 1, extra: { r_squared: 1 - sse / sst } };
}

/** Logistic regression by IRLS. Weights act as variance weights; `robust` gives HC0 SEs (normal reference). */
export function logistic(X: Matrix, y: number[], names: string[], opts: { weights?: number[]; robust?: boolean; maxIter?: number } = {}): Fit {
  const n = X.length, p = X[0].length, w = opts.weights ?? new Array(n).fill(1);
  let beta = new Array(p).fill(0), it = 0, converged = false, mu: number[] = [];
  for (; it < (opts.maxIter ?? 50); it++) {
    const eta = X.map((x) => x.reduce((s, v, j) => s + v * beta[j], 0));
    mu = eta.map((e) => 1 / (1 + Math.exp(-e)));
    const W = mu.map((m, i) => Math.max(w[i] * m * (1 - m), 1e-12));
    const z = eta.map((e, i) => e + (y[i] - mu[i]) / Math.max(mu[i] * (1 - mu[i]), 1e-12));
    const inv = invert(xtwx(X, W));
    const xtwz = new Array(p).fill(0);
    for (let i = 0; i < n; i++) for (let a = 0; a < p; a++) xtwz[a] += W[i] * X[i][a] * z[i];
    const next = matVec(inv, xtwz);
    const change = Math.max(...next.map((b, j) => Math.abs(b - beta[j])));
    beta = next;
    if (change < 1e-10) { converged = true; it++; break; }
  }
  const eta = X.map((x) => x.reduce((s, v, j) => s + v * beta[j], 0));
  mu = eta.map((e) => 1 / (1 + Math.exp(-e)));
  const bread = invert(xtwx(X, mu.map((m, i) => w[i] * m * (1 - m))));
  const cov = opts.robust ? sandwich(bread, xtwx(X, mu.map((m, i) => (w[i] * (y[i] - m)) ** 2))) : bread;
  const ll = y.reduce((s, yi, i) => s + w[i] * (yi * Math.log(Math.max(mu[i], 1e-300)) + (1 - yi) * Math.log(Math.max(1 - mu[i], 1e-300))), 0);
  return { coefficients: coefTable(names, beta, cov, Infinity), n, df_resid: n - p, converged, iterations: it, extra: { log_likelihood: ll } };
}
export const predictLogistic = (X: Matrix, fit: Fit) => X.map((x) => 1 / (1 + Math.exp(-x.reduce((s, v, j) => s + v * fit.coefficients[j].estimate, 0))));

/** Cox proportional hazards, Breslow ties, no intercept column in X. */
export function cox(X: Matrix, time: number[], event: number[], names: string[]): Fit {
  const n = X.length, p = X[0].length;
  const order = time.map((_, i) => i).sort((a, b) => time[b] - time[a]); // descending time
  let beta = new Array(p).fill(0), it = 0, converged = false, info: Matrix = [], ll = 0;
  for (; it < 50; it++) {
    const grad = new Array(p).fill(0); info = Array.from({ length: p }, () => new Array(p).fill(0)); ll = 0;
    let s0 = 0; const s1 = new Array(p).fill(0); const s2: Matrix = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let k = 0; k < n;) {
      // Add everyone with this time to the risk set, then process their events.
      let j = k; const t = time[order[k]];
      while (j < n && time[order[j]] === t) {
        const i = order[j], xi = X[i], r = Math.exp(xi.reduce((s, v, q) => s + v * beta[q], 0));
        s0 += r; for (let a = 0; a < p; a++) { s1[a] += r * xi[a]; for (let b = 0; b < p; b++) s2[a][b] += r * xi[a] * xi[b]; }
        j++;
      }
      for (let m = k; m < j; m++) {
        const i = order[m]; if (!event[i]) continue;
        const xi = X[i];
        ll += xi.reduce((s, v, q) => s + v * beta[q], 0) - Math.log(s0);
        for (let a = 0; a < p; a++) { grad[a] += xi[a] - s1[a] / s0; for (let b = 0; b < p; b++) info[a][b] += s2[a][b] / s0 - (s1[a] * s1[b]) / (s0 * s0); }
      }
      k = j;
    }
    const step = matVec(invert(info), grad);
    beta = beta.map((b, q) => b + step[q]);
    if (Math.max(...step.map(Math.abs)) < 1e-10) { converged = true; it++; break; }
  }
  // Information at the final beta.
  const fin = cox0(X, time, event, beta, order);
  return { coefficients: coefTable(names, beta, invert(fin.info), Infinity), n, df_resid: n - p, converged, iterations: it, extra: { log_likelihood: fin.ll, events: event.reduce((s, e) => s + e, 0) } };
}
function cox0(X: Matrix, time: number[], event: number[], beta: number[], order: number[]) {
  const n = X.length, p = X[0].length, info: Matrix = Array.from({ length: p }, () => new Array(p).fill(0));
  let s0 = 0, ll = 0; const s1 = new Array(p).fill(0); const s2: Matrix = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let k = 0; k < n;) {
    let j = k; const t = time[order[k]];
    while (j < n && time[order[j]] === t) { const xi = X[order[j]], r = Math.exp(xi.reduce((s, v, q) => s + v * beta[q], 0)); s0 += r; for (let a = 0; a < p; a++) { s1[a] += r * xi[a]; for (let b = 0; b < p; b++) s2[a][b] += r * xi[a] * xi[b]; } j++; }
    for (let m = k; m < j; m++) { const i = order[m]; if (!event[i]) continue; ll += X[i].reduce((s, v, q) => s + v * beta[q], 0) - Math.log(s0); for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) info[a][b] += s2[a][b] / s0 - (s1[a] * s1[b]) / (s0 * s0); }
    k = j;
  }
  return { info, ll };
}

/** Kaplan-Meier median survival (null if not reached). */
export function kmMedian(time: number[], event: number[]): number | null {
  const idx = time.map((_, i) => i).sort((a, b) => time[a] - time[b]);
  let atRisk = time.length, s = 1;
  for (let k = 0; k < idx.length;) {
    let j = k, d = 0; const t = time[idx[k]];
    while (j < idx.length && time[idx[j]] === t) { d += event[idx[j]]; j++; }
    if (d) { s *= 1 - d / atRisk; if (s <= 0.5) return t; }
    atRisk -= j - k; k = j;
  }
  return null;
}
/** Two-group log-rank test. */
export function logRank(time: number[], event: number[], group: number[]): { chi2: number; p_value: number } {
  const ts = [...new Set(time.filter((_, i) => event[i]))].sort((a, b) => a - b);
  let o = 0, e = 0, v = 0;
  for (const t of ts) {
    let n = 0, n1 = 0, d = 0, d1 = 0;
    for (let i = 0; i < time.length; i++) if (time[i] >= t) { n++; if (group[i]) n1++; if (time[i] === t && event[i]) { d++; if (group[i]) d1++; } }
    o += d1; e += (d * n1) / n; if (n > 1) v += (d * (n1 / n) * (1 - n1 / n) * (n - d)) / (n - 1);
  }
  const chi2 = v > 0 ? (o - e) ** 2 / v : 0;
  return { chi2, p_value: chiSquareP(chi2, 1) };
}

/** Welch two-sample t test of mean(a) - mean(b). */
export function welch(a: number[], b: number[]) {
  const m = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const vr = (v: number[], mu: number) => v.reduce((s, x) => s + (x - mu) ** 2, 0) / (v.length - 1);
  const ma = m(a), mb = m(b), va = vr(a, ma) / a.length, vb = vr(b, mb) / b.length;
  const se = Math.sqrt(va + vb), df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
  const q = tQuantile(0.975, df), diff = ma - mb;
  return { difference: diff, low: diff - q * se, high: diff + q * se, p_value: tPValue(diff / se, df), df };
}

/** Weighted mean and variance. */
export function wstats(v: number[], w?: number[]) {
  const ww = w ?? v.map(() => 1), sw = ww.reduce((s, x) => s + x, 0);
  const mean = v.reduce((s, x, i) => s + ww[i] * x, 0) / sw;
  const variance = v.reduce((s, x, i) => s + ww[i] * (x - mean) ** 2, 0) / sw;
  return { mean, sd: Math.sqrt(variance), sum_weights: sw };
}
/** Standardised mean difference (pooled SD), optionally weighted. Works for 0/1 indicators too. */
export function smd(a: number[], b: number[], wa?: number[], wb?: number[]): number {
  const x = wstats(a, wa), y = wstats(b, wb);
  const pooled = Math.sqrt((x.sd ** 2 + y.sd ** 2) / 2);
  return pooled === 0 ? 0 : (x.mean - y.mean) / pooled;
}

/** Stabilised inverse-probability-of-treatment weights, truncated at the 1st and 99th percentiles. */
export function iptw(ps: number[], treated: number[]): number[] {
  const pt = treated.reduce((s, t) => s + t, 0) / treated.length;
  const w = ps.map((p, i) => (treated[i] ? pt / p : (1 - pt) / (1 - p)));
  const sorted = [...w].sort((a, b) => a - b);
  const lo = sorted[Math.floor(0.01 * (sorted.length - 1))], hi = sorted[Math.ceil(0.99 * (sorted.length - 1))];
  return w.map((v) => Math.min(hi, Math.max(lo, v)));
}

/** Deterministic PRNG (mulberry32) for reproducible bootstraps and splits. */
export function prng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
