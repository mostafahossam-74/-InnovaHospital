// LOCAL DEVELOPMENT ONLY: builds a synthetic demo hospital through the API
// (start the API with `npm run dev:api` first, after `npm run dev:db`).
// Users (dev sign-in subjects): admin, director, coordinator, reviewer,
// steward, pi (Cardiology), icu_pi (Intensive Care), governance, exec.
import { execFileSync } from "node:child_process";
import { synthesize, SYNTH_DEPARTMENTS, synthPeriods } from "../src/analytics/synthetic.ts";

const BASE = process.env.API_BASE ?? "http://127.0.0.1:8080";
const ISSUER = process.env.OIDC_ISSUER ?? "https://dev.innovahospital.invalid/";
const tokens = new Map<string, string>();
const token = (sub: string) => {
  if (!tokens.has(sub)) tokens.set(sub, execFileSync("node", [new URL("./dev-token.ts", import.meta.url).pathname, sub], { encoding: "utf8" }).trim());
  return tokens.get(sub)!;
};
async function api(sub: string, method: string, path: string, body?: unknown, key?: string) {
  const res = await fetch(BASE + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { authorization: `Bearer ${token(sub)}`, ...(body !== undefined && { "content-type": "application/json" }), ...(key && { "idempotency-key": key }) } });
  const json = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json as any;
}

const end = process.env.SEED_END ?? "2026-10";
const ws = (await api("platform-admin", "POST", "/v1/admin/workspaces", { name: "Nile Demo Hospital (synthetic)", slug: `nile-demo-${Date.now().toString(36)}`, country: "EG", currency: "EGP" })).id;
const W = `/v1/workspaces/${ws}`;
const dept: Record<string, string> = {};
for (const d of SYNTH_DEPARTMENTS) dept[d.code] = (await api("platform-admin", "POST", `/v1/admin/workspaces/${ws}/departments`, d)).id;
const grants: [string, string, string | null][] = [["admin", "hospital_admin", null], ["director", "research_director", null], ["coordinator", "coordinator", null],
  ["reviewer", "innovastat_reviewer", null], ["steward", "data_steward", null], ["pi", "investigator", "cardio"], ["icu_pi", "investigator", "icu"],
  ["governance", "governance_recorder", null], ["exec", "executive_reader", null], ["platform-admin", "hospital_admin", null]];
for (const [sub, role, d] of grants) await api("platform-admin", "POST", `/v1/admin/workspaces/${ws}/memberships`, { issuer: ISSUER, subject: sub, role, department_id: d ? dept[d] : null, display_name: sub });

// Hospital data: 12 months of aggregates and parameters, verified by a second person.
const { cases, params } = synthesize(synthPeriods(end, 12));
const up1 = await api("steward", "POST", `${W}/uploads`, { kind: "case_aggregates", label: `Inpatient aggregates to ${end}`, source_method: "SYNTHETIC: HIS aggregate export by ICD-10, management pathway, department and month", attestation: true, rows: cases });
const up2 = await api("steward", "POST", `${W}/uploads`, { kind: "parameters", label: `Staffing and occupancy to ${end}`, source_method: "SYNTHETIC: nursing roster and bed census", attestation: true, rows: params });
for (const u of [up1, up2]) await api("reviewer", "POST", `${W}/uploads/${u.id}/verify`, { decision: "verified", expected_version: 1 });

// An existing cardiology project so AMI counts as studied.
const p = await api("pi", "POST", `${W}/projects`, { department_id: dept.cardio, title: "Acute MI registry: door-to-balloon and outcomes", study_type: "Prospective registry", study_category: "clinical_effectiveness", condition_codes: ["I21"] });
for (const [t, v] of [["submitted", 1], ["feasibility", 2], ["governance", 3]] as const) await api(t === "submitted" ? "pi" : "coordinator", "POST", `${W}/projects/${p.id}/transition`, { target: t, expected_version: v });
for (const kind of ["ethics", "data"]) await api("governance", "POST", `${W}/projects/${p.id}/decisions`, { kind, authority: kind === "ethics" ? "Hospital Research Ethics Committee" : "Data Protection Office", decision: "approved", reference: `SYN-${kind.toUpperCase()}-2026-014`, effective_date: "2026-01-15", expiry_date: "2027-01-14", protocol_version: 1, permitted_scope: "Cardiology department; registry data; 2026-2027" });
await api("coordinator", "POST", `${W}/projects/${p.id}/transition`, { target: "active", expected_version: 4 });
await api("pi", "POST", `${W}/projects/${p.id}/milestones`, { title: "Statistical analysis plan approved", owner: "pi", due_date: `${end}-20` });
await api("pi", "POST", `${W}/projects/${p.id}/outputs`, { output_type: "protocol", title: "AMI registry protocol v1", lead: "pi" });

// Analysis → gaps; reviewer confirms the top economic, effectiveness and burden gaps.
const [y, m] = end.split("-").map(Number); const start = new Date(Date.UTC(y, m - 12, 1));
const a = await api("coordinator", "POST", `${W}/analyses`, { period_from: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`, period_to: end });
const gaps = (await api("reviewer", "GET", `${W}/gaps?analysis_id=${a.id}`)).items;
const pick = ["cost_effectiveness", "management_outcome_variation", "high_burden_unstudied", "parameter_outcome_association", "department_outcome_variation"]
  .map((t) => gaps.find((g: any) => g.gap_type === t)).filter(Boolean);
for (const g of pick) await api("reviewer", "POST", `${W}/gaps/${g.id}/decision`, { status: "confirmed", reason: "Clinically important, measurable with local data and not addressed by the current portfolio.", expected_version: 1 });
const idea = await api("pi", "POST", `${W}/gaps/${pick[0].id}/ideas`, { department_id: dept[pick[0].condition_code === "J96" || pick[0].condition_code === "A41" ? "icu" : "cardio"] ?? dept.cardio });
await api(idea && pick[0].condition_code === "I21" ? "pi" : "coordinator", "POST", `${W}/ideas/${idea.id}/transition`, { target: "submitted", expected_version: 1 });

// Quality indicators for the report month.
await api("director", "POST", `${W}/indicator-definitions`, { code: "followup", name: "Registry follow-up completion", category: "Research operations", numerator_definition: "Participants with 30-day follow-up completed", denominator_definition: "Participants due 30-day follow-up", direction: "higher_better", target_percent: 80 });
await api("steward", "PUT", `${W}/indicators/cardio/${end}/followup`, { numerator: 32, denominator: 40 });
await api("steward", "PUT", `${W}/indicators/onco/${end}/followup`, { numerator: 3, denominator: 11 });
for (const o of (await api("reviewer", "GET", `${W}/indicators?period=${end}`)).items) await api("reviewer", "POST", `${W}/indicators/${o.id}/verify`, { decision: "verified", expected_version: o.input_version });
await api("coordinator", "POST", `${W}/training`, { title: "Health economics for clinicians", competencies: ["Costing", "Cost-effectiveness", "Budget impact"], facilitator: "InnovaStat", start_date: "2026-09-01", end_date: "2026-10-15" });
await api("coordinator", "POST", `${W}/partnerships`, { organization: "Synthetic Research Foundation", opportunity_type: "grant", owner: "Research office", purpose: "Sepsis bundle cost-effectiveness study", amount: 750000, currency: "EGP" });

// Monthly report: drafted, reviewed, released.
const r = await api("coordinator", "POST", `${W}/report-runs`, { period: end }, crypto.randomUUID());
await api("reviewer", "POST", `${W}/reports/${r.id}/review`, { decision: "approve", digest: r.digest });
await api("director", "POST", `${W}/reports/${r.id}/publish`, { digest: r.digest }, crypto.randomUUID());
console.log(JSON.stringify({ workspace: ws, analysis: a.id, gaps: gaps.length, confirmed: pick.length, report: r.id }, null, 2));
