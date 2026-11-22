// Hospital side of the research cycle: send study data, read InnovaStat
// reports, approve or decline each suggested idea, approve results, receive manuscripts.
import { useState } from "react";
import { Download, Upload } from "lucide-react";
import { useWs } from "@/app/context";
import { useAction, useLoad } from "@/lib/hooks";
import { openBlob } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Empty, Feedback, Field, Loading, Notice, Panel, Status, fmtDateTime, label } from "@/components/common";

export function HospitalResearch({ reportId }: { reportId: string | null }) {
  const { api, wp, has, go, departments } = useWs();
  const canUpload = has("data_steward", "coordinator", "research_director", "hospital_admin");
  const decider = has("research_director", "hospital_admin");
  const uploads = useLoad(() => (canUpload ? api.get(`${wp}/studies/datasets`) : Promise.resolve({ items: [] })), [wp]);
  const reports = useLoad(() => api.get(`${wp}/client-reports`), [wp]);
  const rep = useLoad(() => (reportId ? api.get(`${wp}/client-reports/${reportId}`) : Promise.resolve(null)), [wp, reportId]);
  const manuscripts = useLoad(() => api.get(`${wp}/manuscripts`), [wp]);
  const act = useAction();
  const [file, setFile] = useState<File | null>(null); const [title, setTitle] = useState(""); const [dept, setDept] = useState("");
  const [choice, setChoice] = useState<Record<string, { department_id: string; reason: string }>>({});
  const [ms, setMs] = useState<any | null>(null);
  const r = rep.data;
  return (
    <div className="ie-stack">
      <Feedback error={act.error} message={act.message} />
      {canUpload && (
        <Panel title={<><Upload size={16} /> Send study data to InnovaStat</>}>
          <Notice>Upload Excel (.xlsx) or CSV with one row per patient or admission. Names, phone numbers and national ID numbers are removed automatically on upload, but please send de-identified sheets where you can. InnovaStat's statisticians analyse the data and send you a Gaps & Research Ideas report.</Notice>
          <form className="ie-form" onSubmit={(e) => { e.preventDefault(); if (file) act.run(async () => { const res = await api.upload(`${wp}/studies/datasets?title=${encodeURIComponent(title || file.name)}&file_name=${encodeURIComponent(file.name)}${dept ? `&department_id=${dept}` : ""}`, file); setFile(null); setTitle(""); uploads.reload(); return res; }, "Received. InnovaStat will analyse it."); }}>
            <div className="ie-form-grid">
              <Field label="Title"><input className="ie-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="ICU admissions 2025" /></Field>
              <Field label="Department"><select className="ie-input" value={dept} onChange={(e) => setDept(e.target.value)}><option value="">Several / hospital-wide</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
              <Field label="File"><input type="file" accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
            </div>
            <Button type="submit" size="sm" disabled={!file || act.busy}>{act.busy ? "Uploading…" : "Upload"}</Button>
          </form>
          {uploads.data?.items.length > 0 && <table className="ie-table compact"><tbody>{uploads.data.items.map((u: any) => <tr key={u.id}><td>{u.title}<div className="muted small">{u.file_name} · {u.row_count} rows · {fmtDateTime(u.created_at)}</div></td><td><Status value={u.status ?? "submitted"} /> <span className="small">{u.status ?? "received"}</span></td></tr>)}</tbody></table>}
        </Panel>)}

      <div className="ie-split">
        <Panel title="Reports from InnovaStat">
          {reports.loading ? <Loading /> : !reports.data?.items.length ? <Empty>No reports yet.</Empty> : (
            <table className="ie-table compact"><tbody>{reports.data.items.map((x: any) => (
              <tr key={x.id} className="clickable" onClick={() => go("research", x.id)}><td><b>{x.title}</b><div className="muted small">{x.kind === "gaps_ideas" ? "Research gaps & suggested studies" : "Study results"} · {fmtDateTime(x.released_at)}</div></td><td><Status value={x.status} /></td></tr>))}</tbody></table>)}
        </Panel>
        <Panel title={r?.title ?? "Report"} actions={r && <Button size="sm" variant="outline" onClick={() => act.run(async () => openBlob(await api.blob(`${wp}/client-reports/${r.id}/pdf`)))}><Download size={14} /> PDF</Button>}>
          {!reportId ? <Empty>Select a report.</Empty> : rep.loading || !r ? <Loading /> : r.kind === "gaps_ideas" ? (<>
            {r.snapshot.methods.map((m: string) => <p key={m} className="small muted">{m}</p>)}
            {r.snapshot.ideas.map((i: any) => { const p = r.proposals.find((x: any) => x.id === i.proposal_id); const c = choice[i.proposal_id] ?? { department_id: "", reason: "" };
              return (
                <div key={i.proposal_id} className="ie-form">
                  <h3>{i.number}. {i.title} <Status value={p?.status === "released" ? "proposed" : p?.status} /></h3>
                  <p className="small muted">{label(i.study_category)} · priority {i.priority}</p>
                  <p className="ih-statement">{i.evidence.statement}{i.evidence.result && <><br /><br /><b>Tested on held-out data:</b> {i.evidence.result}</>}</p>
                  <dl className="ie-stack" style={{ gap: 6 }}>{["research_question", "design", "population", "primary_outcome", "comparator", "economic_method", "expected_output"].filter((k) => i.concept[k]).map((k) => <div key={k}><dt className="ie-h3">{label(k)}</dt><dd className="small">{i.concept[k]}</dd></div>)}</dl>
                  {p?.status === "released" && decider && (
                    <div className="ie-inline wrap">
                      <select className="ie-input sm" value={c.department_id} onChange={(e) => setChoice({ ...choice, [i.proposal_id]: { ...c, department_id: e.target.value } })}><option value="">Department to run it…</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
                      <input className="ie-input sm" placeholder="Reason / comment" value={c.reason} onChange={(e) => setChoice({ ...choice, [i.proposal_id]: { ...c, reason: e.target.value } })} />
                      <Button size="sm" disabled={!c.department_id || act.busy} onClick={() => act.run(async () => { const res = await api.post(`${wp}/proposals/${p.id}/hospital-decision`, { decision: "approved", department_id: c.department_id, reason: c.reason || undefined, expected_version: p.version }); rep.reload(); return res; }, "Approved: the study is now in Projects.")}>Approve study</Button>
                      <Button size="sm" variant="outline" disabled={!c.reason || act.busy} onClick={() => act.run(async () => { await api.post(`${wp}/proposals/${p.id}/hospital-decision`, { decision: "declined", reason: c.reason, expected_version: p.version }); rep.reload(); }, "Declined.")}>Decline</Button>
                    </div>)}
                  {p?.project_id && <a className="ie-link small" onClick={() => go("projects", p.project_id)}>Open the study →</a>}
                </div>); })}
          </>) : (<>
            <p className="small">Study: <b>{r.snapshot.project.title}</b> ({r.snapshot.project.department})</p>
            {r.snapshot.analyses.map((a: any) => (
              <div key={a.result_id} className="ie-form">
                <h3>{a.plan_title}</h3>
                <p className="ih-statement">{a.interpretation}</p>
                {a.economics && <p className="small">Cost-effectiveness: incremental cost {a.economics.incremental_cost} {a.economics.currency} (95% CI {a.economics.incremental_cost_low} to {a.economics.incremental_cost_high}); {label(a.economics.dominance)}{a.economics.icer !== null ? `; ICER ${a.economics.icer}` : ""}.</p>}
              </div>))}
            {r.status === "released" && decider && (
              <div className="ie-inline wrap">
                <input className="ie-input sm" style={{ minWidth: 260 }} placeholder="Comments (required to return)" value={choice.results?.reason ?? ""} onChange={(e) => setChoice({ ...choice, results: { department_id: "", reason: e.target.value } })} />
                <Button size="sm" disabled={act.busy} onClick={() => act.run(async () => { await api.post(`${wp}/client-reports/${r.id}/hospital-decision`, { decision: "approved", note: choice.results?.reason || undefined }); rep.reload(); reports.reload(); }, "Results approved. InnovaStat will now write the manuscript.")}>Approve results</Button>
                <Button size="sm" variant="outline" disabled={act.busy || !choice.results?.reason} onClick={() => act.run(async () => { await api.post(`${wp}/client-reports/${r.id}/hospital-decision`, { decision: "returned", note: choice.results?.reason }); rep.reload(); reports.reload(); })}>Return</Button>
              </div>)}
          </>)}
        </Panel>
      </div>

      <Panel title="Manuscripts from InnovaStat">
        {!manuscripts.data?.items.length ? <Empty>Manuscripts arrive after you approve a study's results.</Empty> : (
          <table className="ie-table compact"><tbody>{manuscripts.data.items.map((m: any) => (
            <tr key={m.id} className="clickable" onClick={() => act.run(async () => setMs(await api.get(`${wp}/manuscripts/${m.id}`)))}><td><b>{m.project_title}</b><div className="muted small">version {m.version} · sent {fmtDateTime(m.sent_at)}</div></td><td><Status value={m.status} /></td></tr>))}</tbody></table>)}
        {ms && (<div className="ie-form">
          {["title", "abstract", "introduction", "methods", "results", "discussion", "conclusion"].map((k) => <div key={k}><h3 className="ie-h3">{label(k)}</h3><p className="ie-prose small">{ms.sections[k]}</p></div>)}
          {ms.status === "sent" && has("research_director", "hospital_admin", "investigator") && (
            <div className="ie-inline"><Button size="sm" onClick={() => act.run(async () => { await api.post(`${wp}/manuscripts/${ms.id}/hospital-decision`, { decision: "accepted" }); setMs(null); manuscripts.reload(); }, "Accepted. Track journal submission under the study's outputs.")}>Accept manuscript</Button>
              <Button size="sm" variant="outline" onClick={() => { const note = prompt("What should change?"); if (note) act.run(async () => { await api.post(`${wp}/manuscripts/${ms.id}/hospital-decision`, { decision: "returned", note }); setMs(null); manuscripts.reload(); }); }}>Request changes</Button></div>)}
        </div>)}
      </Panel>
    </div>
  );
}
