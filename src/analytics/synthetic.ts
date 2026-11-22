// Deterministic synthetic hospital data for the demo, tests and training.
// SYNTHETIC: the numbers are generated, with planted signals so the engine has
// something to find (management differences, a staffing association, a rising
// condition, department variation, an unstudied high-burden condition).

export type SynthCase = { period: string; department: string; condition_code: string; condition_label: string; management: string;
  cases: number; deaths: number; readmissions_30d: number; complications: number; los_days_sum: number; cost_sum: number };
export type SynthParam = { period: string; department: string; parameter_code: string; parameter_label: string; value: number; unit: string };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function binomial(r: () => number, n: number, p: number) { let k = 0; for (let i = 0; i < n; i++) if (r() < p) k++; return k; }
function poisson(r: () => number, lambda: number) { const L = Math.exp(-lambda); let k = 0, p = 1; do { k++; p *= r(); } while (p > L); return k - 1; }

export const SYNTH_DEPARTMENTS = [
  { code: "cardio", name: "Cardiology" }, { code: "icu", name: "Intensive Care" },
  { code: "onco", name: "Oncology" }, { code: "gim", name: "Internal Medicine" },
];

type Arm = { management: string; weight: number; mort: number; readm: number; comp: number; los: number; cost: number };
type Cond = { code: string; label: string; depts: Record<string, number>; arms: Arm[]; growth?: number; deptMort?: Record<string, number> };

const CONDITIONS: Cond[] = [
  { code: "I21", label: "Acute myocardial infarction", depts: { cardio: 55 }, arms: [
    { management: "Primary PCI", weight: 0.6, mort: 0.05, readm: 0.08, comp: 0.07, los: 4, cost: 85000 },
    { management: "Thrombolysis", weight: 0.27, mort: 0.09, readm: 0.11, comp: 0.10, los: 6, cost: 30000 },
    { management: "Conservative", weight: 0.13, mort: 0.15, readm: 0.14, comp: 0.09, los: 7, cost: 18000 }] },
  { code: "I50", label: "Heart failure", depts: { cardio: 30, gim: 25 }, arms: [
    { management: "Guideline-directed therapy", weight: 0.55, mort: 0.06, readm: 0.17, comp: 0.08, los: 6, cost: 22000 },
    { management: "Standard care", weight: 0.45, mort: 0.08, readm: 0.27, comp: 0.09, los: 7, cost: 19500 }] },
  { code: "A41", label: "Sepsis", depts: { icu: 30, gim: 20 }, growth: 0.06, deptMort: { icu: 1.0, gim: 1.6 }, arms: [
    { management: "Sepsis bundle within 1 hour", weight: 0.6, mort: 0.2, readm: 0.1, comp: 0.25, los: 9, cost: 48000 },
    { management: "Delayed bundle", weight: 0.4, mort: 0.3, readm: 0.12, comp: 0.3, los: 11, cost: 52000 }] },
  { code: "J96", label: "Respiratory failure", depts: { icu: 22 }, arms: [
    { management: "Non-invasive ventilation", weight: 0.5, mort: 0.16, readm: 0.1, comp: 0.12, los: 7, cost: 40000 },
    { management: "Invasive ventilation", weight: 0.5, mort: 0.3, readm: 0.09, comp: 0.25, los: 12, cost: 90000 }] },
  { code: "C50", label: "Breast cancer", depts: { onco: 28 }, arms: [
    { management: "Breast-conserving surgery", weight: 0.45, mort: 0.003, readm: 0.05, comp: 0.08, los: 2, cost: 60000 },
    { management: "Mastectomy", weight: 0.55, mort: 0.004, readm: 0.07, comp: 0.14, los: 4, cost: 72000 }] },
  { code: "C18", label: "Colon cancer", depts: { onco: 16 }, arms: [
    { management: "Laparoscopic colectomy", weight: 0.5, mort: 0.02, readm: 0.08, comp: 0.12, los: 5, cost: 78000 },
    { management: "Open colectomy", weight: 0.5, mort: 0.04, readm: 0.12, comp: 0.22, los: 9, cost: 71000 }] },
  { code: "E11", label: "Type 2 diabetes with complications", depts: { gim: 45 }, arms: [
    { management: "Standard inpatient care", weight: 1, mort: 0.02, readm: 0.15, comp: 0.06, los: 5, cost: 14000 }] },
  { code: "N18", label: "Chronic kidney disease", depts: { gim: 10 }, arms: [
    { management: "Standard inpatient care", weight: 1, mort: 0.04, readm: 0.2, comp: 0.1, los: 6, cost: 26000 }] },
];

export function synthPeriods(end = "2026-10", months = 12): string[] {
  const [y, m] = end.split("-").map(Number);
  return Array.from({ length: months }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (months - 1 - i), 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

export function synthesize(periods = synthPeriods(), seed = 20261105) {
  const r = rng(seed);
  const cases: SynthCase[] = [];
  const params: SynthParam[] = [];
  const baseNurse: Record<string, number> = { cardio: 0.9, icu: 1.6, onco: 0.8, gim: 0.6 };
  periods.forEach((period, i) => {
    for (const d of SYNTH_DEPARTMENTS) {
      // Staffing varies month to month; more nurses per bed → lower mortality (planted signal).
      const nurse = Math.round((baseNurse[d.code] * (0.75 + 0.5 * r())) * 100) / 100;
      const staffEffect = Math.exp(-2.2 * (nurse / baseNurse[d.code] - 1));
      const occupancy = Math.round((78 + 18 * r()) * 10) / 10;
      params.push({ period, department: d.code, parameter_code: "nurse_to_bed_ratio", parameter_label: "Nurse-to-bed ratio", value: nurse, unit: "nurses per bed" });
      params.push({ period, department: d.code, parameter_code: "bed_occupancy", parameter_label: "Bed occupancy", value: occupancy, unit: "%" });
      for (const c of CONDITIONS) {
        const base = c.depts[d.code];
        if (!base) continue;
        const n = poisson(r, base * (1 + (c.growth ?? 0) * i));
        let left = n;
        c.arms.forEach((a, ai) => {
          const k = ai === c.arms.length - 1 ? left : Math.min(left, binomial(r, n, a.weight));
          left -= k;
          if (k === 0) return;
          const mort = Math.min(0.95, a.mort * staffEffect * (c.deptMort?.[d.code] ?? 1));
          const readm = Math.min(0.95, a.readm * (1 + (occupancy - 87) / 60));
          let los = 0, cost = 0;
          for (let j = 0; j < k; j++) { const f = 0.6 + 0.8 * r(); los += a.los * f; cost += a.cost * (0.7 + 0.6 * r()) * (0.85 + 0.3 * f); }
          cases.push({ period, department: d.code, condition_code: c.code, condition_label: c.label, management: a.management, cases: k,
            deaths: binomial(r, k, mort), readmissions_30d: binomial(r, k, readm), complications: binomial(r, k, a.comp),
            los_days_sum: Math.round(los * 10) / 10, cost_sum: Math.round(cost) });
        });
      }
    }
  });
  return { cases, params };
}
