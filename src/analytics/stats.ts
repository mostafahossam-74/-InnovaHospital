// Statistics for aggregate hospital data. Pure functions, no dependencies.
// Inputs are counts (events out of patients), so binomial and Poisson
// methods apply; patient-level variance is not available from aggregates and
// the engine says so where it matters (costs, length of stay).

export const Z95 = 1.959963984540054;

/** Standard normal CDF (Abramowitz & Stegun 26.2.17, |error| < 7.5e-8). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

export const twoSidedP = (z: number): number => Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));

/** Wilson score interval for k events out of n. */
export function wilson(k: number, n: number, z = Z95): [number, number] {
  if (n <= 0) return [0, 1];
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export type Comparison = {
  p1: number; p2: number;
  /** Risk difference p1 - p2 with Newcombe's hybrid score interval. */
  rd: number; rd_low: number; rd_high: number;
  /** Risk ratio p1 / p2 (0.5 added to every cell when one is zero). */
  rr: number; rr_low: number; rr_high: number;
  /** Two-sided p from the pooled two-proportion z test. */
  p_value: number;
};

export function compareProportions(k1: number, n1: number, k2: number, n2: number): Comparison {
  const p1 = k1 / n1, p2 = k2 / n2;
  const [l1, u1] = wilson(k1, n1), [l2, u2] = wilson(k2, n2);
  const rd = p1 - p2;
  const rd_low = rd - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2);
  const rd_high = rd + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2);
  const pooled = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const p_value = se === 0 ? 1 : twoSidedP(rd / se);
  const zero = k1 === 0 || k2 === 0 || k1 === n1 || k2 === n2;
  const a = zero ? k1 + 0.5 : k1, b = zero ? n1 + 1 : n1, c = zero ? k2 + 0.5 : k2, d = zero ? n2 + 1 : n2;
  const rr = (a / b) / (c / d);
  const seLog = Math.sqrt(1 / a - 1 / b + 1 / c - 1 / d);
  return { p1, p2, rd, rd_low, rd_high, rr, rr_low: rr * Math.exp(-Z95 * seLog), rr_high: rr * Math.exp(Z95 * seLog), p_value };
}

/** Regularized upper incomplete gamma Q(a, x) (Numerical Recipes gser/gcf). */
export function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const lnGammaA = lnGamma(a);
  if (x < a + 1) {
    let sum = 1 / a, del = sum, ap = a;
    for (let i = 0; i < 500; i++) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-14) break; }
    return Math.max(0, 1 - sum * Math.exp(-x + a * Math.log(x) - lnGammaA));
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.min(1, Math.exp(-x + a * Math.log(x) - lnGammaA) * h);
}

export function lnGamma(x: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Chi-square test of homogeneity of k proportions (k x 2 table). */
export function heterogeneity(groups: { k: number; n: number }[]): { chi2: number; df: number; p_value: number } {
  const K = groups.reduce((s, g) => s + g.k, 0), N = groups.reduce((s, g) => s + g.n, 0);
  const p = K / N;
  let chi2 = 0;
  for (const g of groups) {
    const e1 = g.n * p, e0 = g.n * (1 - p);
    if (e1 > 0) chi2 += (g.k - e1) ** 2 / e1;
    if (e0 > 0) chi2 += (g.n - g.k - e0) ** 2 / e0;
  }
  const df = groups.length - 1;
  return { chi2, df, p_value: df > 0 ? gammaQ(df / 2, chi2 / 2) : 1 };
}

function ranks(v: number[]): number[] {
  const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(v.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

export function pearson(x: number[], y: number[]): number {
  const n = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx === 0 || syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
}

export type Correlation = { rho: number; n: number; low: number; high: number; p_value: number };

/** Spearman rank correlation with Fisher-z interval and p value (normal approximation). */
export function spearman(x: number[], y: number[]): Correlation {
  const n = x.length;
  const rho = Math.max(-0.999999, Math.min(0.999999, pearson(ranks(x), ranks(y))));
  if (n < 4) return { rho, n, low: -1, high: 1, p_value: 1 };
  const z = Math.atanh(rho), se = 1.06 / Math.sqrt(n - 3); // Fieller et al. variance for Spearman
  return { rho, n, low: Math.tanh(z - Z95 * se), high: Math.tanh(z + Z95 * se), p_value: twoSidedP(z / se) };
}

/** Benjamini-Hochberg adjusted p values (q values), in input order. */
export function benjaminiHochberg(p: number[]): number[] {
  const m = p.length;
  const order = p.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const q = new Array<number>(m);
  let min = 1;
  for (let r = m - 1; r >= 0; r--) {
    min = Math.min(min, (order[r][0] * m) / (r + 1));
    q[order[r][1]] = min;
  }
  return q;
}

/** Ratio of two Poisson rates (events per unit exposure) with log-normal interval. */
export function rateRatio(e1: number, t1: number, e2: number, t2: number) {
  const a = e1 === 0 || e2 === 0 ? e1 + 0.5 : e1, b = e1 === 0 || e2 === 0 ? e2 + 0.5 : e2;
  const rr = (a / t1) / (b / t2);
  const se = Math.sqrt(1 / a + 1 / b);
  return { rr, low: rr * Math.exp(-Z95 * se), high: rr * Math.exp(Z95 * se), p_value: twoSidedP(Math.log(rr) / se) };
}

export const round = (v: number, d = 4): number => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};
