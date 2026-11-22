// InnovaStat study workbench: one dataset through the confirmed steps.
import { useEffect, useState } from "react";
import { CheckCircle2, Circle, Lock, Play, Sparkles, Upload } from "lucide-react";
import { useWs } from "@/app/context";
import { useAction, useLoad } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { Empty, Feedback, Field, Loading, Notice, Panel, Status, fmtDateTime, label, measure, shortSub } from "@/components/common";

const ROLES = ["patient_id", "identifier", "age", "sex", "admission_date", "discharge_date", "event_date", "diagnosis", "exposure", "outcome", "time_to_event", "cost", "los", "covariate", "ignore"];
const TYPES = ["number", "category", "binary", "date", "text"];
const STEPS = [["dictionary", "1 · Data dictionary"], ["cleaning", "2 · Cleaning & split"], ["hypotheses", "3 · Hypotheses"], ["analysis", "4 · Plans & results"]] as const;
const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);

export function Workbench({ datasetId }: { datasetId: string | null }) {
  const { api, wp, go, has } = useWs();
  const sets = useLoad(() => api.get(`${wp}/studies/datasets`), [wp]);
  const act = useAction();
  const [title, setTitle] = useState(""); const [file, setFile] = useState<File | null>(null);
  return (
    <div className="ie-stack">
      <Notice>Everything on this page is internal to InnovaStat. The hospital sees only its upload receipts until a report is released. The analyst (or the agent) proposes each step; the assigned statistician confirms it.</Notice>
      <div className="ie-split">
        <Panel title="Datasets">
          {has("innovastat_analyst", "innovastat_reviewer") && (
            <form className="ie-form" onSubmit={(e) => { e.preventDefault(); if (file) act.run(async () => { const r = await api.upload(`${wp}/studies/datasets?title=${encodeURIComponent(title || file.name)}&file_name=${encodeURIComponent(file.name)}`, file); sets.reload(); go("workbench", r.id); }); }}>
              <Field label="Upload a dataset (.xlsx or .csv)"><input type="file" accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
              <div className="ie-inline"><input className="ie-input sm" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
                <Button size="sm" disabled={!file || act.busy}><Upload size={14} /> Upload</Button></div>
            </form>)}
          <Feedback error={act.error} />
          {sets.loading ? <Loading /> : !sets.data?.items.length ? <Empty>No datasets yet. Hospitals upload Excel sheets from their workspace.</Empty> : (
            <table className="ie-table compact"><tbody>{sets.data.items.map((d: any) => (
              <tr key={d.id} className="clickable" onClick={() => go("workbench", d.id)}>
                <td><b>{d.title}</b><div className="muted small">{d.row_count} rows · {d.hypotheses} hypotheses · {d.results} results · {fmtDateTime(d.created_at)}</div></td>
                <td><Status value={d.stage} /></td></tr>))}</tbody></table>)}
        </Panel>
        {datasetId ? <Dataset id={datasetId} /> : <Panel title="Dataset"><Empty>Select a dataset.</Empty></Panel>}
      </div>
    </div>
  );
}

function Dataset({ id }: { id: string }) {
  const { api, wp, has, actor } = useWs();
  const d = useLoad(() => api.get(`${wp}/studies/datasets/${id}`), [wp, id]);
  const act = useAction();
  const [step, setStep] = useState<string>("dictionary");
  const [dict, setDict] = useState<any[] | null>(null);
  const x = d.data;
  useEffect(() => { if (x) { setDict(x.dictionary); setStep(x.stage === "uploaded" ? "dictionary" : x.stage); } }, [x?.id, x?.version]);
  if (d.loading || !x) return <Panel title="Dataset"><Loading /></Panel>;
  const stat = has("innovastat_reviewer") && (!x.statistician || x.statistician === actor);
  const done = { dictionary: x.dictionary_status === "confirmed", cleaning: x.cleaning_status === "confirmed", hypotheses: x.hypotheses.some((h: any) => h.status === "confirmed"), analysis: x.results.some((r: any) => r.status === "accepted") } as Record<string, boolean>;
  const call = (fn: () => Promise<unknown>, msg?: string) => act.run(async () => { await fn(); d.reload(); }, msg);
  return (
    <Panel title={x.title} eyebrow={`${x.file_name} · sheet ${x.sheet_name} · ${x.row_count} rows`}>
      <div className="ie-inline wrap small">
        <span>Statistician: <b>{x.statistician ? shortSub(x.statistician) : "any statistician"}</b></span>
        {has("innovastat_analyst", "innovastat_reviewer") && <Button size="sm" variant="outline" onClick={() => call(() => api.patch(`${wp}/studies/datasets/${id}`, { expected_version: x.version, statistician: actor }))}>Assign me</Button>}
        <span className="muted">Agent {x.agent_available ? "available" : "not configured: rule-based steps"}</span>
      </div>
      {x.deid_report?.dropped_columns?.length > 0 && <Notice kind="success">Removed on upload: {x.deid_report.dropped_columns.map((c: any) => `${c.column} (${c.reason})`).join("; ")}. {x.deid_report.pseudonymised_column ? `${x.deid_report.pseudonymised_column} replaced by pseudonyms.` : ""}</Notice>}
      <div className="ih-tabs" role="tablist">{STEPS.map(([k, l]) => <button key={k} role="tab" aria-selected={step === k} onClick={() => setStep(k)}>{done[k] ? <CheckCircle2 size={13} style={{ display: "inline", verticalAlign: -2 }} /> : <Circle size={13} style={{ display: "inline", verticalAlign: -2 }} />} {l}</button>)}</div>
      <Feedback error={act.error} message={act.message} />

      {step === "dictionary" && (<>
        <div className="ie-inline wrap">
          <Button size="sm" variant="outline" disabled={act.busy || done.dictionary} onClick={() => call(() => api.post(`${wp}/studies/datasets/${id}/dictionary/propose`, { mode: "rules" }))}>Propose with rules</Button>
          <Button size="sm" variant="outline" disabled={act.busy || done.dictionary || !x.agent_available} onClick={() => act.run(async () => { const r = await api.post(`${wp}/studies/datasets/${id}/dictionary/propose`, { mode: "claude" }); if (r.fallback_reasons.length) alert(`Agent output not used: ${r.fallback_reasons.join("; ")}`); d.reload(); })}><Sparkles size={14} /> Propose with Claude</Button>
          {dict && !done.dictionary && <Button size="sm" variant="outline" disabled={act.busy} onClick={() => call(() => api.put(`${wp}/studies/datasets/${id}/dictionary`, { expected_version: x.version, entries: dict }), "Saved.")}>Save edits</Button>}
          {dict && !done.dictionary && stat && <Button size="sm" disabled={act.busy} onClick={() => call(() => api.post(`${wp}/studies/datasets/${id}/dictionary/confirm`, { expected_version: x.version }), "Dictionary confirmed.")}>Confirm dictionary</Button>}
          {done.dictionary && <span className="small">Confirmed by {shortSub(x.dictionary_confirmed_by)} · {fmtDateTime(x.dictionary_confirmed_at)}</span>}
        </div>
        {!dict ? <Empty>Propose a dictionary from the column profiles. The agent sees profiles only, never rows.</Empty> : (
          <div style={{ overflowX: "auto" }}><table className="ie-table compact"><thead><tr><th>Column</th><th>Profile</th><th>Role</th><th>Type</th><th>Label</th><th>Yes values</th><th>No values</th><th>Missing codes</th></tr></thead>
            <tbody>{dict.map((e, i) => { const p = x.profile.find((q: any) => q.source === e.source) ?? {}; const set = (k: string, v: unknown) => setDict(dict.map((z, j) => (j === i ? { ...z, [k]: v } : z)));
              return (<tr key={e.source}><td><b>{e.source}</b><div className="mono">{e.name}</div></td>
                <td className="small">{p.inferred} · {p.missing} missing · {p.distinct} distinct{p.min !== undefined ? ` · ${p.min}–${p.max}` : ""}{p.top?.length ? <div className="muted">{p.top.slice(0, 4).map((t: any) => `${t.value} (${t.count})`).join(", ")}</div> : null}{p.identifier_reason && <div style={{ color: "#a8283a" }}>{p.identifier_reason}</div>}</td>
                <td><select className="ie-input sm" disabled={done.dictionary} value={e.role} onChange={(ev) => set("role", ev.target.value)}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></td>
                <td><select className="ie-input sm" disabled={done.dictionary} value={e.type} onChange={(ev) => set("type", ev.target.value)}>{TYPES.map((r) => <option key={r}>{r}</option>)}</select></td>
                <td><input className="ie-input sm" disabled={done.dictionary} value={e.label} onChange={(ev) => set("label", ev.target.value)} /></td>
                <td><input className="ie-input sm" disabled={done.dictionary || e.type !== "binary"} value={e.positive_values.join(", ")} onChange={(ev) => set("positive_values", list(ev.target.value))} /></td>
                <td><input className="ie-input sm" disabled={done.dictionary || e.type !== "binary"} value={(e.negative_values ?? []).join(", ")} onChange={(ev) => set("negative_values", list(ev.target.value))} /></td>
                <td><input className="ie-input sm" disabled={done.dictionary} value={e.missing_codes.join(", ")} onChange={(ev) => set("missing_codes", list(ev.target.value))} /></td></tr>); })}</tbody></table></div>)}
      </>)}

      {step === "cleaning" && (<>
        <div className="ie-inline wrap">
          <Button size="sm" variant="outline" disabled={act.busy || !done.dictionary || done.cleaning} onClick={() => call(() => api.post(`${wp}/studies/datasets/${id}/clean`, {}))}>Run cleaning</Button>
          {x.cleaning_status === "proposed" && stat && <Button size="sm" disabled={act.busy} onClick={() => call(() => api.post(`${wp}/studies/datasets/${id}/cleaning/confirm`, { expected_version: x.version }), "Cleaning confirmed.")}>Confirm cleaning</Button>}
          {done.cleaning && <span className="small">Confirmed by {shortSub(x.cleaning_confirmed_by)}</span>}
        </div>
        {!x.cleaning_report ? <Empty>{done.dictionary ? "Run the cleaning." : "Confirm the dictionary first."}</Empty> : (<>
          <p className="small">{x.cleaning_report.rows_in} rows in → {x.cleaning_report.rows_out} out; {x.cleaning_report.duplicates_removed} duplicates removed; derived: {x.cleaning_report.derived.join(", ") || "none"}. Split (seed {x.cleaning_report.split.seed}): <b>{x.cleaning_report.split.discovery}</b> discovery (hypothesis generation) / <b>{x.cleaning_report.split.validation}</b> validation (testing).</p>
          <table className="ie-table compact"><thead><tr><th>Variable</th><th>Role</th><th className="ih-num">Missing</th><th className="ih-num">Invalid</th><th>Summary</th></tr></thead>
            <tbody>{x.cleaning_report.variables.map((v: any) => <tr key={v.variable}><td>{v.label}<div className="mono">{v.variable}</div></td><td className="small">{v.role} · {v.type}</td><td className="ih-num">{v.missing}</td>
              <td className="ih-num">{v.invalid}{v.examples_invalid.length ? <div className="muted small">{v.examples_invalid.join(", ")}</div> : null}</td>
              <td className="small">{v.summary.mean !== undefined ? `mean ${v.summary.mean} (${v.summary.min}–${v.summary.max})` : v.summary.yes_percent !== undefined ? `${v.summary.yes_percent}% yes` : v.summary.top ? v.summary.top.map((t: any) => `${t.value} ${t.count}`).join(", ") : ""}</td></tr>)}</tbody></table>
        </>)}
      </>)}

      {step === "hypotheses" && <Hypotheses x={x} stat={stat} call={call} busy={act.busy} />}
      {step === "analysis" && <Plans x={x} stat={stat} reload={d.reload} />}
    </Panel>
  );
}

function Hypotheses({ x, stat, call, busy }: { x: any; stat: boolean; call: (fn: () => Promise<unknown>, m?: string) => void; busy: boolean }) {
  const { api, wp } = useWs();
  const [reason, setReason] = useState("Clinically important and testable with these data.");
  return (<>
    <div className="ie-inline wrap">
      <Button size="sm" variant="outline" disabled={busy || x.cleaning_status !== "confirmed"} onClick={() => call(() => api.post(`${wp}/studies/datasets/${x.id}/hypotheses/generate`, { mode: "rules" }))}>Screen discovery half</Button>
      <Button size="sm" variant="outline" disabled={busy || x.cleaning_status !== "confirmed" || !x.agent_available} onClick={() => call(() => api.post(`${wp}/studies/datasets/${x.id}/hypotheses/generate`, { mode: "claude" }))}><Sparkles size={14} /> Screen + Claude</Button>
      {stat && <input className="ie-input sm" style={{ minWidth: 320 }} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Decision reason" />}
    </div>
    {!x.hypotheses.length ? <Empty>No hypotheses yet.</Empty> : (
      <table className="ie-table compact"><tbody>{x.hypotheses.map((h: any) => (
        <tr key={h.id}><td><span className="ih-score">{Number(h.priority).toFixed(0)}</span></td>
          <td><b>{h.title}</b><div className="small">{h.statement}</div><div className="muted small">{h.kind} · {label(h.study_category)} · {h.origin}{h.screening.q_value !== undefined ? ` · q ${h.screening.q_value}` : ""}</div></td>
          <td><Status value={h.status} /></td>
          <td className="ie-inline">{stat && h.status === "proposed" && <>
            <Button size="sm" disabled={busy} onClick={() => call(() => api.post(`${wp}/studies/hypotheses/${h.id}/decision`, { status: "confirmed", reason, expected_version: h.version }))}>Confirm</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => call(() => api.post(`${wp}/studies/hypotheses/${h.id}/decision`, { status: "rejected", reason, expected_version: h.version }))}>Reject</Button></>}
            {h.status === "confirmed" && h.kind === "burden" && <Button size="sm" variant="outline" disabled={busy} onClick={() => call(() => api.post(`${wp}/proposals`, { hypothesis_id: h.id }), "Proposal drafted (see Deliverables).")}>Propose study</Button>}
            {h.status === "confirmed" && h.kind !== "burden" && <Button size="sm" variant="outline" disabled={busy} onClick={() => call(() => api.post(`${wp}/studies/hypotheses/${h.id}/plans`, {}), "Plan drafted (see Plans & results).")}>Draft plan</Button>}
          </td></tr>))}</tbody></table>)}
  </>);
}

function Plans({ x, stat, reload }: { x: any; stat: boolean; reload: () => void }) {
  const { api, wp, actor } = useWs();
  const act = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const plan = useLoad(() => (open ? api.get(`${wp}/studies/plans/${open}`) : Promise.resolve(null)), [open]);
  const [text, setText] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const res = useLoad(() => (result ? api.get(`${wp}/studies/results/${result}`) : Promise.resolve(null)), [result]);
  useEffect(() => { if (plan.data) setText(JSON.stringify(plan.data.plan, null, 2)); }, [plan.data?.id, plan.data?.version]);
  const done = (msg?: string) => () => { reload(); plan.reload(); res.reload(); return msg; };
  const hypo = (id: string) => x.hypotheses.find((h: any) => h.id === id)?.title ?? "";
  return (<>
    <Feedback error={act.error} message={act.message} />
    {!x.plans.length ? <Empty>Draft a plan from a confirmed hypothesis.</Empty> : (
      <table className="ie-table compact"><tbody>{x.plans.map((p: any) => (
        <tr key={p.id} className="clickable" onClick={() => setOpen(p.id)}><td><b>{p.title}</b><div className="muted small">{p.origin} · v{p.version}{p.sha256 ? ` · locked ${p.sha256.slice(0, 10)}` : ""}</div></td><td><Status value={p.status} /></td></tr>))}</tbody></table>)}
    {plan.data && (
      <div className="ie-form">
        <h3>{plan.data.plan.title}</h3>
        <p className="small muted">Hypothesis: {hypo(plan.data.hypothesis_id)}. The plan is fixed before any result is seen and runs on the validation half.</p>
        <Field wide label="Analysis plan (exposure, outcome, covariates, method, economics)"><textarea className="ie-input mono" rows={16} disabled={plan.data.status !== "draft"} value={text} onChange={(e) => setText(e.target.value)} /></Field>
        <div className="ie-inline wrap">
          {plan.data.status === "draft" && <Button size="sm" variant="outline" disabled={act.busy} onClick={() => act.run(async () => { const r = await api.patch(`${wp}/studies/plans/${open}`, { expected_version: plan.data.version, plan: JSON.parse(text) }); done()(); if (r.problems_to_resolve.length) throw new Error(r.problems_to_resolve.join("; ")); }, "Saved.")}>Save</Button>}
          {plan.data.status === "draft" && stat && <Button size="sm" disabled={act.busy} onClick={() => act.run(async () => { await api.post(`${wp}/studies/plans/${open}/lock`, { expected_version: plan.data.version }); done()(); }, "Plan locked.")}><Lock size={14} /> Lock plan</Button>}
          {plan.data.status === "locked" && <Button size="sm" disabled={act.busy} onClick={() => act.run(async () => { const r = await api.post(`${wp}/studies/plans/${open}/run`, { interpret: x.agent_available ? "claude" : "template" }); done()(); setResult(r.id); })}><Play size={14} /> Run on validation data</Button>}
        </div>
      </div>)}
    <h3 className="ie-h3">Results</h3>
    {!x.results.length ? <Empty>No results yet.</Empty> : (
      <table className="ie-table compact"><tbody>{x.results.map((r: any) => (
        <tr key={r.id} className="clickable" onClick={() => setResult(r.id)}><td>{hypo(r.hypothesis_id)}<div className="muted small">{measure(r.primary.measure)} {r.primary.estimate} ({r.primary.low}–{r.primary.high}), p {r.primary.p_value < 0.001 ? "<0.001" : r.primary.p_value}</div></td>
          <td><Status value={r.significant ? "significant" : "not_significant"} /></td><td><Status value={r.status} /></td></tr>))}</tbody></table>)}
    {res.data && <Result r={res.data} stat={stat} me={actor} onChange={() => { reload(); res.reload(); }} />}
  </>);
}

function Result({ r, stat, me, onChange }: { r: any; stat: boolean; me: string; onChange: () => void }) {
  const { api, wp } = useWs();
  const act = useAction();
  const [note, setNote] = useState("");
  const R = r.results;
  return (
    <div className="ie-form">
      <h3>{r.hypothesis_title}</h3>
      <p className="ih-statement">{r.interpretation}</p>
      <p className="small muted">Run by {shortSub(r.run_by)} · plan {r.plan_sha256.slice(0, 10)} · {R.population.included} patients · excluded: {Object.entries(R.population.excluded).map(([k, v]) => `${k} (${v})`).join("; ") || "none"}</p>
      <table className="ie-table compact"><thead><tr><th>Characteristic</th><th>{R.population.treated_label}</th><th>{R.population.reference_label}</th><th className="ih-num">SMD</th></tr></thead>
        <tbody>{R.table1.map((t: any, i: number) => <tr key={i}><td>{t.variable}{t.level ? ` · ${t.level}` : ""}</td><td>{t.treated}</td><td>{t.reference}</td><td className="ih-num">{t.smd}</td></tr>)}</tbody></table>
      <table className="ie-table compact"><thead><tr><th>Term</th><th className="ih-num">Estimate</th><th className="ih-num">95% CI</th><th className="ih-num">p</th></tr></thead>
        <tbody>{R.coefficients.map((c: any) => <tr key={c.term}><td>{c.term}</td><td className="ih-num">{c.estimate}</td><td className="ih-num">{c.low} to {c.high}</td><td className="ih-num">{c.p_value}</td></tr>)}</tbody></table>
      {R.balance && <p className="small">Balance after weighting: {R.balance.map((b: any) => `${b.term} ${b.smd_before}→${b.smd_after}`).join("; ")}. Effective sample size {R.propensity.effective_sample_size}.</p>}
      {R.economics && <table className="ie-table compact"><tbody>
        <tr><td>Mean cost</td><td>{R.economics.mean_cost_treated} vs {R.economics.mean_cost_reference} {R.economics.currency}</td></tr>
        <tr><td>Incremental cost (95% CI)</td><td>{R.economics.incremental_cost} ({R.economics.incremental_cost_low} to {R.economics.incremental_cost_high})</td></tr>
        <tr><td>Incremental effect (95% CI)</td><td>{R.economics.incremental_effect} ({R.economics.incremental_effect_low} to {R.economics.incremental_effect_high}) · {R.economics.effect_label}</td></tr>
        <tr><td>ICER / dominance</td><td>{R.economics.icer ?? "—"} · <Status value={R.economics.dominance} /></td></tr>
        <tr><td>Probability cost-effective</td><td>{R.economics.ceac.map((c: any) => `${c.wtp.toLocaleString()}: ${(c.probability_cost_effective * 100).toFixed(0)}%`).join(" · ")}</td></tr></tbody></table>}
      {R.warnings.length > 0 && <Notice kind="warning">{R.warnings.join("; ")}</Notice>}
      {r.status === "pending_review" && stat && r.run_by !== me && (
        <div className="ie-inline wrap"><input className="ie-input sm" style={{ minWidth: 280 }} placeholder="Note (required to return)" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button size="sm" disabled={act.busy} onClick={() => act.run(async () => { await api.post(`${wp}/studies/results/${r.id}/review`, { decision: "accepted", note: note || undefined }); onChange(); }, "Accepted.")}>Accept result</Button>
          <Button size="sm" variant="outline" disabled={act.busy || !note} onClick={() => act.run(async () => { await api.post(`${wp}/studies/results/${r.id}/review`, { decision: "returned", note }); onChange(); })}>Return</Button></div>)}
      {r.status === "pending_review" && r.run_by === me && <Notice>Another statistician reviews results you ran.</Notice>}
      {r.status === "accepted" && <Button size="sm" variant="outline" disabled={act.busy} onClick={() => act.run(async () => { await api.post(`${wp}/proposals`, { result_id: r.id }); }, "Proposal drafted (see Deliverables).")}>Turn into a research idea</Button>}
      <Feedback error={act.error} message={act.message} />
    </div>
  );
}
