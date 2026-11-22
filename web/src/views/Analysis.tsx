import { useState } from "react";
import { PlayCircle } from "lucide-react";
import { useWs } from "@/app/context";
import { useAction, useLoad } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { Bar, Empty, Feedback, Field, Loading, Notice, Panel, Status, fmtDateTime, label, num, pct } from "@/components/common";

const TABS = [["burden", "Disease burden"], ["management", "Management & outcomes"], ["comparisons", "Comparative outcomes"], ["economics", "Health economics"],
  ["variation", "Department variation"], ["parameters", "Hospital parameters"], ["completeness", "Data completeness"]] as const;
const sig = (q: number | null) => (q === null ? "—" : q < 0.001 ? "<0.001" : q.toFixed(3));
const ci = (lo: number, hi: number, f = (v: number) => (v * 100).toFixed(1)) => `${f(lo)} to ${f(hi)}`;

export function Analysis({ analysisId }: { analysisId: string | null }) {
  const { api, wp, has, go, ws } = useWs();
  const list = useLoad(() => api.get(`${wp}/analyses`), [wp]);
  const id = analysisId ?? list.data?.items[0]?.id ?? null;
  const a = useLoad(() => (id ? api.get(`${wp}/analyses/${id}`) : Promise.resolve(null)), [wp, id]);
  const act = useAction();
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("burden");
  const [cond, setCond] = useState<string>("");
  const now = new Date(); const end = `${now.getFullYear()}-${String(now.getMonth() || 12).padStart(2, "0")}`;
  const [f, setF] = useState({ period_from: "", period_to: end, min_cases: 30 });
  const R = a.data?.results;
  const cur = ws.currency;

  return (
    <div className="ie-stack">
      {has("coordinator", "innovastat_reviewer", "research_director") && (
        <Panel title={<><PlayCircle size={16} /> Run an analysis</>}>
          <form className="ie-form" onSubmit={(e) => { e.preventDefault(); act.run(async () => { const r = await api.post(`${wp}/analyses`, { ...f, min_cases: Number(f.min_cases) }); list.reload(); go("analysis", r.id); }, "Analysis complete; research gaps were proposed for review."); }}>
            <div className="ie-form-grid">
              <Field label="From (YYYY-MM)"><input className="ie-input" required pattern="\d{4}-\d{2}" value={f.period_from} onChange={(e) => setF({ ...f, period_from: e.target.value })} placeholder="2025-11" /></Field>
              <Field label="To (YYYY-MM)"><input className="ie-input" required pattern="\d{4}-\d{2}" value={f.period_to} onChange={(e) => setF({ ...f, period_to: e.target.value })} /></Field>
              <Field label="Minimum patients per arm" hint="Smaller groups are described but not compared."><input className="ie-input" type="number" min={5} value={f.min_cases} onChange={(e) => setF({ ...f, min_cases: Number(e.target.value) })} /></Field>
            </div>
            <Button type="submit" disabled={act.busy}>{act.busy ? "Analysing…" : "Run on verified data"}</Button>
            <Feedback error={act.error} message={act.message} />
          </form>
        </Panel>)}
      {list.loading ? <Loading /> : !list.data?.items.length ? <Empty>No analyses yet. Verified uploads are analysed here.</Empty> : (
        <Panel title="Analysis" actions={
          <select className="ie-input sm" value={id ?? ""} onChange={(e) => go("analysis", e.target.value)}>
            {list.data.items.map((x: any) => <option key={x.id} value={x.id}>{x.period_from} to {x.period_to} · {fmtDateTime(x.created_at)} · {x.gaps} gaps</option>)}
          </select>}>
          {a.loading || !R ? <Loading /> : (
            <>
              <p className="muted small">{num(R.summary.total_cases)} cases · {R.summary.conditions} conditions · {R.summary.departments.length} departments · {R.summary.periods.length} months · {R.summary.tests} statistical tests with Benjamini–Hochberg false-discovery control (q). Engine {R.engine_version}; digest <span className="mono">{a.data.sha256.slice(0, 12)}</span>. Unadjusted aggregate associations: they point to questions, not answers.</p>
              <div className="ih-tabs" role="tablist">{TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
              {tab === "burden" && (
                <table className="ie-table compact"><thead><tr><th>Condition</th><th>Share of all cases (95% CI)</th><th className="ih-num">Cases</th><th className="ih-num">Mortality</th><th className="ih-num">Readmission</th><th className="ih-num">Mean stay</th><th className="ih-num">Mean cost</th><th>Trend (later vs earlier half)</th><th>Departments</th></tr></thead>
                  <tbody>{R.conditions.map((c: any) => (
                    <tr key={c.condition_code}><td><b>{c.condition_label}</b> <span className="muted small">{c.condition_code}</span></td>
                      <td style={{ minWidth: 200 }}><Bar value={c.share} max={R.conditions[0].share} text={`${pct(c.share)} (${pct(c.share_low)}–${pct(c.share_high)})`} /></td>
                      <td className="ih-num">{num(c.cases)}</td><td className="ih-num">{pct(c.mortality?.rate)}</td><td className="ih-num">{pct(c.readmission?.rate)}</td>
                      <td className="ih-num">{c.mean_los_days ?? "—"} d</td><td className="ih-num">{c.mean_cost ? `${cur} ${num(c.mean_cost)}` : "—"}</td>
                      <td className="small">{c.trend ? <>{c.trend.share_ratio}× (q {sig(c.trend.q_value)})</> : "—"}</td>
                      <td className="small">{c.departments.map((d: any) => d.department).join(", ")}</td></tr>))}</tbody></table>)}
              {tab === "management" && (
                <>
                  <Field label="Condition"><select className="ie-input sm" value={cond} onChange={(e) => setCond(e.target.value)}><option value="">All conditions</option>{R.conditions.map((c: any) => <option key={c.condition_code} value={c.condition_code}>{c.condition_label}</option>)}</select></Field>
                  <table className="ie-table compact"><thead><tr><th>Condition</th><th>Management</th><th>Share of condition</th><th className="ih-num">Patients</th><th className="ih-num">Mortality (95% CI)</th><th className="ih-num">Readmission</th><th className="ih-num">Complications</th><th className="ih-num">Mean stay</th><th className="ih-num">Mean cost</th></tr></thead>
                    <tbody>{R.management_outcomes.filter((m: any) => !cond || m.condition_code === cond).map((m: any) => (
                      <tr key={m.condition_code + m.management}><td className="small">{m.condition_label}</td><td><b>{m.management}</b></td>
                        <td style={{ minWidth: 140 }}><Bar value={m.share_of_condition} /></td><td className="ih-num">{num(m.cases)}</td>
                        <td className="ih-num">{m.mortality ? `${pct(m.mortality.rate)} (${pct(m.mortality.low)}–${pct(m.mortality.high)})` : "—"}</td>
                        <td className="ih-num">{pct(m.readmission?.rate)}</td><td className="ih-num">{pct(m.complication?.rate)}</td>
                        <td className="ih-num">{m.mean_los_days ?? "—"} d</td><td className="ih-num">{m.mean_cost ? `${cur} ${num(m.mean_cost)}` : "—"}</td></tr>))}</tbody></table>
                </>)}
              {tab === "comparisons" && (
                <table className="ie-table compact"><thead><tr><th>Condition</th><th>Outcome</th><th>Management vs reference</th><th className="ih-num">Rate</th><th className="ih-num">Reference</th><th className="ih-num">Risk difference, pp (95% CI)</th><th className="ih-num">Risk ratio (95% CI)</th><th className="ih-num">q</th></tr></thead>
                  <tbody>{R.comparisons.map((c: any, i: number) => (
                    <tr key={i} style={{ fontWeight: c.q_value < R.config.alpha ? 600 : 400 }}><td className="small">{c.condition_label}</td><td className="small">{c.outcome_label}</td>
                      <td>{c.management} <span className="muted">vs</span> {c.reference}</td><td className="ih-num">{pct(c.rate)} <span className="muted small">({c.events}/{c.n})</span></td>
                      <td className="ih-num">{pct(c.rate_ref)} <span className="muted small">({c.events_ref}/{c.n_ref})</span></td>
                      <td className="ih-num">{(c.risk_difference * 100).toFixed(1)} ({ci(c.rd_low, c.rd_high)})</td>
                      <td className="ih-num">{c.risk_ratio} ({c.rr_low}–{c.rr_high})</td><td className="ih-num">{sig(c.q_value)}</td></tr>))}</tbody></table>)}
              {tab === "economics" && (
                <>
                  <Notice>Hospital-perspective comparison of mean cost and in-hospital mortality per management. ICER = incremental cost per death averted (in the less-costly, less-effective quadrant it is the saving per additional death). Aggregate sums give no cost variance or case-mix adjustment, so these are signals for a formal economic evaluation.</Notice>
                  <table className="ie-table compact"><thead><tr><th>Condition</th><th>Management vs reference</th><th className="ih-num">Mean cost</th><th className="ih-num">Reference</th><th className="ih-num">Incremental cost</th><th className="ih-num">Deaths averted /100</th><th className="ih-num">ICER per death averted</th><th>Dominance</th><th className="ih-num">Bed-days /patient</th><th className="ih-num">Annual budget impact</th></tr></thead>
                    <tbody>{R.economics.map((e: any, i: number) => (
                      <tr key={i}><td className="small">{e.condition_label}</td><td style={{ minWidth: 200 }}>{e.management} <span className="muted">vs</span> {e.reference}</td>
                        <td className="ih-num">{num(e.mean_cost)}</td><td className="ih-num">{num(e.mean_cost_ref)}</td>
                        <td className="ih-num">{num(e.incremental_cost)} <span className="muted small">({pct(e.relative_cost_difference, 0)})</span></td>
                        <td className="ih-num">{e.deaths_averted_per_100 ?? "—"}</td><td className="ih-num">{e.icer_per_death_averted === null ? "—" : num(e.icer_per_death_averted)}</td>
                        <td><Status value={e.dominance} /></td><td className="ih-num">{e.bed_days_difference_per_patient ?? "—"}</td><td className="ih-num">{num(e.annual_budget_impact)}</td></tr>))}</tbody></table>
                  <p className="muted small">Amounts in {cur}. Budget impact: annual cost change if the reference group's patients were managed the other way.</p>
                </>)}
              {tab === "variation" && (
                <table className="ie-table compact"><thead><tr><th>Condition</th><th>Outcome</th><th>By department</th><th className="ih-num">Range, pp</th><th className="ih-num">χ² (df)</th><th className="ih-num">q</th></tr></thead>
                  <tbody>{R.variation.map((v: any, i: number) => (
                    <tr key={i} style={{ fontWeight: v.q_value < R.config.alpha ? 600 : 400 }}><td className="small">{v.condition_label}</td><td className="small">{v.outcome_label}</td>
                      <td className="small">{v.departments.map((d: any) => `${d.department} ${pct(d.rate)} (n=${d.n})`).join(" · ")}</td>
                      <td className="ih-num">{(v.range * 100).toFixed(1)}</td><td className="ih-num">{v.chi2} ({v.df})</td><td className="ih-num">{sig(v.q_value)}</td></tr>))}</tbody></table>)}
              {tab === "parameters" && (
                <>
                  <table className="ie-table compact"><thead><tr><th>Parameter</th><th className="ih-num">Mean</th><th className="ih-num">Range</th><th className="ih-num">Points</th><th>Departments</th></tr></thead>
                    <tbody>{R.parameters.map((p: any) => <tr key={p.parameter_code}><td><b>{p.parameter_label}</b> <span className="muted small">{p.unit}</span></td><td className="ih-num">{p.mean}</td><td className="ih-num">{p.min}–{p.max}</td><td className="ih-num">{p.points}</td><td className="small">{p.departments.join(", ")}</td></tr>)}</tbody></table>
                  <h3 className="ie-h3">Associations with outcomes (within department, Spearman)</h3>
                  <table className="ie-table compact"><thead><tr><th>Parameter</th><th>Outcome</th><th className="ih-num">rho (95% CI)</th><th className="ih-num">Department-months</th><th className="ih-num">q</th></tr></thead>
                    <tbody>{R.associations.map((s: any, i: number) => (
                      <tr key={i} style={{ fontWeight: s.q_value < R.config.alpha ? 600 : 400 }}><td>{s.parameter_label}</td><td>{s.outcome_label}</td>
                        <td className="ih-num">{s.rho} ({s.low} to {s.high})</td><td className="ih-num">{s.points}</td><td className="ih-num">{sig(s.q_value)}</td></tr>))}</tbody></table>
                </>)}
              {tab === "completeness" && (
                <>
                  <p>{R.completeness.observed_department_months} of {R.completeness.expected_department_months} department-months reported case data.</p>
                  <table className="ie-table compact"><thead><tr><th>Field</th><th>Recorded in cells</th></tr></thead>
                    <tbody>{Object.entries(R.completeness.field_completeness).map(([k, v]: any) => <tr key={k}><td>{label(k)}</td><td style={{ minWidth: 200 }}><Bar value={v} /></td></tr>)}</tbody></table>
                  {R.completeness.missing_months.length > 0 && <Notice kind="warning">Missing: {R.completeness.missing_months.map((m: any) => `${m.department} ${m.period}`).join(", ")}</Notice>}
                  <h3 className="ie-h3">Portfolio coverage of conditions</h3>
                  <table className="ie-table compact"><tbody>{R.coverage.map((c: any) => (
                    <tr key={c.condition_code}><td>{c.condition_label}</td><td className="ih-num">{pct(c.share)}</td><td>{c.high_burden ? <Status value={c.portfolio.length ? "approved" : "missing"} /> : <span className="muted small">below threshold</span>}</td>
                      <td className="small">{c.portfolio.map((p: any) => p.title).join("; ") || "—"}</td></tr>))}</tbody></table>
                </>)}
              <div><Button variant="outline" onClick={() => go("gaps")}>Review the research gaps from this analysis →</Button></div>
            </>)}
        </Panel>)}
    </div>
  );
}
