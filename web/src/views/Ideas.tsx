import { useState } from "react";
import { Plus } from "lucide-react";
import { useWs } from "@/app/context";
import { useAction, useLoad } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { Empty, Feedback, Field, Loading, Notice, Panel, Status, fmtDateTime, label, newKey, shortSub } from "@/components/common";

const CATS = ["clinical_effectiveness", "health_economics", "epidemiology", "quality_improvement", "operational", "other"];
const FIELDS: [string, string, number][] = [["research_question", "Research question", 3], ["rationale", "Rationale", 4], ["design", "Design", 1], ["population", "Population", 2],
  ["data_sources", "Data sources", 2], ["primary_outcome", "Primary outcome", 1], ["comparator", "Comparator", 1], ["analysis_plan", "Analysis plan", 4],
  ["economic_method", "Health-economic method", 2], ["expected_output", "Expected output", 1]];
const OFFICE_MOVES: Record<string, string[]> = { submitted: ["feasibility", "returned", "deferred", "rejected"], feasibility: ["accepted", "returned", "deferred", "rejected"], deferred: ["feasibility", "rejected"] };

export function Ideas({ ideaId }: { ideaId: string | null }) {
  const { api, wp, has, go, actor, deptsFor } = useWs();
  const list = useLoad(() => api.get(`${wp}/ideas`), [wp]);
  const d = useLoad(() => (ideaId ? api.get(`${wp}/ideas/${ideaId}`) : Promise.resolve(null)), [wp, ideaId]);
  const act = useAction();
  const [edit, setEdit] = useState<Record<string, string> | null>(null);
  const [reason, setReason] = useState(""); const [priority, setPriority] = useState(3);
  const [creating, setCreating] = useState(false);
  const createDepts = deptsFor("investigator", "coordinator", "department_lead", "research_director", "innovastat_reviewer");
  const [nf, setNf] = useState({ department_id: "", title: "", research_question: "", rationale: "", design: "", study_category: "clinical_effectiveness", population: "", data_sources: "", condition_codes: "" });
  const i = d.data;
  const office = has("coordinator", "research_director");
  const owner = i && (i.pi === actor || i.created_by === actor);
  const move = (target: string) => act.run(async () => { await api.post(`${wp}/ideas/${i.id}/transition`, { target, expected_version: i.version, reason: reason || undefined, priority: office ? priority : undefined }); setReason(""); d.reload(); list.reload(); }, `Moved to ${label(target)}.`);
  return (
    <div className="ie-split">
      <Panel title="Ideas" actions={createDepts.length > 0 && <Button size="sm" variant="outline" onClick={() => setCreating(!creating)}><Plus size={14} /> New idea</Button>}>
        {creating && (
          <form className="ie-form" onSubmit={(e) => { e.preventDefault(); act.run(async () => {
            const r = await api.post(`${wp}/ideas`, { ...nf, department_id: nf.department_id || createDepts[0].id, condition_codes: nf.condition_codes.split(/[ ,]+/).filter(Boolean) });
            setCreating(false); list.reload(); go("ideas", r.id); }); }}>
            <Field label="Department"><select className="ie-input" value={nf.department_id} onChange={(e) => setNf({ ...nf, department_id: e.target.value })}>{createDepts.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
            {(["title", "research_question", "rationale", "design", "population", "data_sources"] as const).map((k) => <Field key={k} wide label={label(k)}><input className="ie-input" required value={nf[k]} onChange={(e) => setNf({ ...nf, [k]: e.target.value })} /></Field>)}
            <Field label="Category"><select className="ie-input" value={nf.study_category} onChange={(e) => setNf({ ...nf, study_category: e.target.value })}>{CATS.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Field>
            <Field label="ICD-10 codes" hint="e.g. I21 A41"><input className="ie-input" value={nf.condition_codes} onChange={(e) => setNf({ ...nf, condition_codes: e.target.value })} /></Field>
            <Button type="submit" disabled={act.busy}>Save draft</Button>
          </form>)}
        {list.loading ? <Loading /> : !list.data?.items.length ? <Empty>No ideas yet. Confirm a research gap or propose one.</Empty> : (
          <table className="ie-table compact"><tbody>{list.data.items.map((x: any) => (
            <tr key={x.id} className="clickable" onClick={() => { setEdit(null); go("ideas", x.id); }}>
              <td><b>{x.title}</b><div className="muted small">{x.department} · {label(x.study_category)}{x.source_gap_id ? " · from hospital data" : ""}</div></td>
              <td><Status value={x.status} /></td></tr>))}</tbody></table>)}
      </Panel>
      <Panel title={i?.title ?? "Idea"} eyebrow={i ? `${i.department} · ${label(i.study_category)} · ${i.origin === "manual" ? "proposed by a clinician" : i.origin === "claude" ? "drafted by Claude from a research gap" : "drafted from a research gap"}` : undefined}>
        {!ideaId ? <Empty>Select an idea.</Empty> : d.loading || !i ? <Loading /> : (
          <>
            <div className="ie-inline wrap"><Status value={i.status} /><span className="muted small">PI {shortSub(i.pi)} · v{i.version} · updated {fmtDateTime(i.updated_at)}</span>
              {i.source_gap_id && <a className="ie-link small" onClick={() => go("gaps", i.source_gap_id)}>Source gap</a>}
              {i.project_id && <a className="ie-link small" onClick={() => go("projects", i.project_id)}>Project</a>}</div>
            {edit ? (
              <form className="ie-form" onSubmit={(e) => { e.preventDefault(); act.run(async () => { await api.patch(`${wp}/ideas/${i.id}`, { expected_version: i.version, ...Object.fromEntries(Object.entries(edit).map(([k, v]) => [k, v === "" ? null : v])) }); setEdit(null); d.reload(); }, "Saved."); }}>
                <Field wide label="Title"><input className="ie-input" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
                {FIELDS.map(([k, l, rows]) => <Field key={k} wide label={l}><textarea className="ie-input" rows={rows} value={edit[k] ?? ""} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></Field>)}
                <div className="ie-inline"><Button type="submit" disabled={act.busy}>Save</Button><Button type="button" variant="outline" onClick={() => setEdit(null)}>Cancel</Button></div>
              </form>
            ) : (
              <dl className="ie-stack" style={{ gap: 8 }}>{FIELDS.filter(([k]) => i[k]).map(([k, l]) => <div key={k}><dt className="ie-h3">{l}</dt><dd className="ie-prose">{i[k]}</dd></div>)}</dl>
            )}
            {i.triage_reason && <Notice>Triage: {i.triage_reason}{i.priority ? ` · priority ${i.priority}` : ""}</Notice>}
            {["draft", "returned"].includes(i.status) && (owner || office) && !edit && (
              <div className="ie-inline"><Button variant="outline" onClick={() => setEdit(Object.fromEntries(["title", ...FIELDS.map((f) => f[0])].map((k) => [k, i[k] ?? ""])))}>Edit</Button>
                <Button disabled={act.busy} onClick={() => move("submitted")}>Submit to research office</Button></div>)}
            {office && OFFICE_MOVES[i.status] && (
              <div className="ie-form">
                <h3>Triage</h3>
                <div className="ie-form-grid"><Field wide label="Reason"><input className="ie-input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                  <Field label="Priority (1 = highest)"><input className="ie-input" type="number" min={1} max={5} value={priority} onChange={(e) => setPriority(Number(e.target.value))} /></Field></div>
                <div className="ie-inline wrap">{OFFICE_MOVES[i.status].map((t) => <Button key={t} variant={t === "accepted" || t === "feasibility" ? "default" : "outline"} disabled={!reason || act.busy} onClick={() => move(t)}>{label(t)}</Button>)}</div>
              </div>)}
            {office && i.status === "accepted" && (
              <Button disabled={act.busy} onClick={() => act.run(async () => { const r = await api.post(`${wp}/ideas/${i.id}/convert`, { expected_version: i.version }, { idempotencyKey: newKey() }); go("projects", r.project_id); })}>Convert to project</Button>)}
            <Feedback error={act.error} message={act.message} />
            {i.history?.length > 0 && <details className="ie-details"><summary>History</summary><ul>{i.history.map((h: any, n: number) => <li key={n}>{fmtDateTime(h.created_at)} · {shortSub(h.actor)}: {h.from_status} → {h.to_status}{h.reason ? ` — ${h.reason}` : ""}</li>)}</ul></details>}
          </>)}
      </Panel>
    </div>
  );
}
