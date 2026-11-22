// InnovaStat deliverables: proposals → Gaps & Ideas report; results reports; manuscripts.
import { useState } from "react";
import { Download, Send } from "lucide-react";
import { useWs } from "@/app/context";
import { useAction, useLoad } from "@/lib/hooks";
import { openBlob } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Empty, Feedback, Field, Loading, Panel, Status, fmtDateTime, label, measure, newKey, shortSub } from "@/components/common";

const SECTIONS = ["title", "abstract", "introduction", "methods", "results", "discussion", "conclusion"];

export function Deliverables() {
  const { api, wp, actor, departments } = useWs();
  const proposals = useLoad(() => api.get(`${wp}/proposals`), [wp]);
  const reports = useLoad(() => api.get(`${wp}/client-reports`), [wp]);
  const manuscripts = useLoad(() => api.get(`${wp}/manuscripts`), [wp]);
  const projects = useLoad(() => api.get(`${wp}/projects`), [wp]);
  const sets = useLoad(() => api.get(`${wp}/studies/datasets`), [wp]);
  const act = useAction();
  const [pick, setPick] = useState<string[]>([]);
  const [open, setOpen] = useState<any | null>(null);
  const [rp, setRp] = useState({ project_id: "", result_ids: [] as string[] });
  const accepted = useLoad(async () => {
    const out: any[] = [];
    for (const d of sets.data?.items ?? []) { const x = await api.get(`${wp}/studies/datasets/${d.id}`); for (const r of x.results.filter((r: any) => r.status === "accepted")) out.push({ ...r, title: x.hypotheses.find((h: any) => h.id === r.hypothesis_id)?.title }); }
    return out;
  }, [sets.data]);
  const [ms, setMs] = useState<any | null>(null);
  const reloadAll = () => { proposals.reload(); reports.reload(); manuscripts.reload(); projects.reload(); };
  const pdf = (id: string) => act.run(async () => openBlob(await api.blob(`${wp}/client-reports/${id}/pdf`)));
  return (
    <div className="ie-stack">
      <Feedback error={act.error} message={act.message} />
      <div className="ie-split">
        <Panel title="Research idea proposals" actions={<Button size="sm" disabled={!pick.length || act.busy} onClick={() => act.run(async () => { await api.post(`${wp}/client-reports`, { kind: "gaps_ideas", proposal_ids: pick }); setPick([]); reloadAll(); }, "Gaps & Ideas report drafted.")}>Draft Gaps & Ideas report ({pick.length})</Button>}>
          {proposals.loading ? <Loading /> : !proposals.data?.items.length ? <Empty>No proposals yet. Turn accepted results or confirmed hypotheses into research ideas in the workbench.</Empty> : (
            <table className="ie-table compact"><tbody>{proposals.data.items.map((p: any) => (
              <tr key={p.id}><td>{p.status === "confirmed" && <input type="checkbox" aria-label="Include in report" checked={pick.includes(p.id)} onChange={(e) => setPick(e.target.checked ? [...pick, p.id] : pick.filter((x) => x !== p.id))} />}</td>
                <td className="clickable" onClick={() => setOpen(p)}><b>{p.title}</b><div className="muted small">{label(p.study_category)} · {p.department ?? "department not set"} · {p.origin}{p.hospital_reason ? ` · hospital: ${p.hospital_reason}` : ""}</div></td>
                <td><Status value={p.status} /></td>
                <td>{p.status === "draft" && <Button size="sm" disabled={act.busy} onClick={() => act.run(async () => { await api.post(`${wp}/proposals/${p.id}/confirm`, { expected_version: p.version }); reloadAll(); }, "Confirmed.")}>Confirm</Button>}</td></tr>))}</tbody></table>)}
        </Panel>
        <Panel title={open?.title ?? "Proposal"}>
          {!open ? <Empty>Select a proposal to read and edit its concept.</Empty> : (
            <form className="ie-form" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget);
              act.run(async () => { await api.patch(`${wp}/proposals/${open.id}`, { expected_version: open.version, department_id: (f.get("department_id") as string) || null,
                concept: Object.fromEntries(["title", "research_question", "design", "population", "primary_outcome", "comparator", "analysis_plan", "economic_method", "expected_output"].map((k) => [k, f.get(k)])) }); setOpen(null); reloadAll(); }, "Saved; it needs confirmation again."); }}>
              <p className="ih-statement">{open.evidence.statement}{open.evidence.result ? <><br /><br /><b>Tested:</b> {open.evidence.result}</> : null}</p>
              <Field label="Department"><select className="ie-input" name="department_id" defaultValue={open.department_id ?? ""}><option value="">—</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
              {["title", "research_question", "design", "population", "primary_outcome", "comparator", "analysis_plan", "economic_method", "expected_output"].map((k) => (
                <Field key={k} wide label={label(k)}><textarea className="ie-input" rows={k === "analysis_plan" ? 4 : 2} name={k} defaultValue={open.concept[k] ?? ""} disabled={!["draft", "confirmed"].includes(open.status)} /></Field>))}
              {["draft", "confirmed"].includes(open.status) && <Button type="submit" size="sm" disabled={act.busy}>Save</Button>}
            </form>)}
        </Panel>
      </div>

      <Panel title="Reports to the hospital">
        <form className="ie-form" onSubmit={(e) => { e.preventDefault(); act.run(async () => { await api.post(`${wp}/client-reports`, { kind: "results", ...rp }); reloadAll(); }, "Results report drafted."); }}>
          <h3>New results report</h3>
          <div className="ie-form-grid">
            <Field label="Study (project)"><select className="ie-input" required value={rp.project_id} onChange={(e) => setRp({ ...rp, project_id: e.target.value })}><option value="">Choose…</option>{projects.data?.items.map((p: any) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></Field>
            <Field wide label="Accepted results to include">
              <div className="ie-checks col">{accepted.data?.map((r: any) => <label key={r.id}><input type="checkbox" checked={rp.result_ids.includes(r.id)} onChange={(e) => setRp({ ...rp, result_ids: e.target.checked ? [...rp.result_ids, r.id] : rp.result_ids.filter((x) => x !== r.id) })} /> {r.title} — {measure(r.primary.measure)} {r.primary.estimate}</label>)}</div>
            </Field>
          </div>
          <Button size="sm" type="submit" disabled={!rp.project_id || !rp.result_ids.length || act.busy}>Draft results report</Button>
        </form>
        {reports.loading ? <Loading /> : !reports.data?.items.length ? <Empty>No reports yet.</Empty> : (
          <table className="ie-table compact"><tbody>{reports.data.items.map((r: any) => (
            <tr key={r.id}><td><b>{r.title}</b><div className="muted small">{r.kind === "gaps_ideas" ? "Gaps & Ideas" : "Results"} · r{r.revision} · author {shortSub(r.author)}{r.approver ? ` · approved by ${shortSub(r.approver)}` : ""}{r.hospital_note ? ` · hospital: ${r.hospital_note}` : ""}</div></td>
              <td><Status value={r.status} /></td>
              <td className="ie-inline">
                <Button size="sm" variant="outline" onClick={() => pdf(r.id)}><Download size={13} /> PDF</Button>
                {r.status === "draft" && r.author !== actor && <Button size="sm" disabled={act.busy} onClick={() => act.run(async () => { await api.post(`${wp}/client-reports/${r.id}/approve`, { digest: r.digest }); reloadAll(); }, "Approved.")}>Approve</Button>}
                {r.status === "approved" && <Button size="sm" disabled={act.busy} onClick={() => act.run(async () => { await api.post(`${wp}/client-reports/${r.id}/release`, { digest: r.digest }, { idempotencyKey: newKey() }); reloadAll(); }, "Released to the hospital.")}><Send size={13} /> Release</Button>}
                {r.kind === "results" && r.status === "hospital_approved" && !manuscripts.data?.items.some((m: any) => m.project_id === r.project_id) && <Button size="sm" disabled={act.busy} onClick={() => act.run(async () => { await api.post(`${wp}/projects/${r.project_id}/manuscripts`, { mode: "template" }); reloadAll(); }, "Manuscript drafted.")}>Draft manuscript</Button>}
              </td></tr>))}</tbody></table>)}
      </Panel>

      <Panel title="Manuscripts">
        {!manuscripts.data?.items.length ? <Empty>Manuscripts are drafted after the hospital approves a results report.</Empty> : (
          <table className="ie-table compact"><tbody>{manuscripts.data.items.map((m: any) => (
            <tr key={m.id} className="clickable" onClick={() => act.run(async () => setMs(await api.get(`${wp}/manuscripts/${m.id}`)))}><td><b>{m.project_title}</b><div className="muted small">v{m.version} · {m.origin} · {fmtDateTime(m.updated_at)}{m.hospital_note ? ` · hospital: ${m.hospital_note}` : ""}</div></td><td><Status value={m.status} /></td></tr>))}</tbody></table>)}
        {ms && (
          <form className="ie-form" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); act.run(async () => { await api.patch(`${wp}/manuscripts/${ms.id}`, { updated_at: ms.updated_at, sections: Object.fromEntries(SECTIONS.map((k) => [k, String(f.get(k) ?? "")])) }); setMs(await api.get(`${wp}/manuscripts/${ms.id}`)); reloadAll(); }, "Saved."); }}>
            {SECTIONS.map((k) => <Field key={k} wide label={label(k)}><textarea className="ie-input" name={k} rows={k === "title" ? 1 : 6} defaultValue={ms.sections[k] ?? ""} disabled={!["draft", "hospital_returned"].includes(ms.status)} /></Field>)}
            <div className="ie-inline">
              {["draft", "hospital_returned"].includes(ms.status) && <Button size="sm" type="submit" variant="outline" disabled={act.busy}>Save</Button>}
              {ms.status === "draft" && ms.author !== actor && <Button size="sm" type="button" disabled={act.busy} onClick={() => act.run(async () => { await api.post(`${wp}/manuscripts/${ms.id}/approve`, {}); setMs(await api.get(`${wp}/manuscripts/${ms.id}`)); reloadAll(); }, "Approved.")}>Approve</Button>}
              {ms.status === "approved" && <Button size="sm" type="button" disabled={act.busy} onClick={() => act.run(async () => { await api.post(`${wp}/manuscripts/${ms.id}/send`, {}); setMs(null); reloadAll(); }, "Sent to the hospital.")}><Send size={13} /> Send to hospital</Button>}
            </div>
          </form>)}
      </Panel>
    </div>
  );
}
