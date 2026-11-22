import { useState } from "react";
import { useWs } from "@/app/context";
import { useAction, useLoad } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { Empty, Feedback, Field, Loading, Panel, Status, fmtDate, label, num, shortSub } from "@/components/common";

const STAGES = ["lead", "qualified", "proposal", "contracting", "signed", "active", "closed", "lost"];

export function Office() {
  const { api, wp, has, go, ws } = useWs();
  const office = has("coordinator", "research_director");
  const training = useLoad(() => api.get(`${wp}/training`), [wp]);
  const outputs = useLoad(() => api.get(`${wp}/outputs`), [wp]);
  const partners = useLoad(() => (has("research_director", "coordinator", "hospital_admin", "innovastat_reviewer") ? api.get(`${wp}/partnerships`) : Promise.resolve({ items: [] })), [wp]);
  const act = useAction();
  const [t, setT] = useState({ title: "", facilitator: "", start_date: "", end_date: "", competencies: "" });
  const [p, setP] = useState({ organization: "", opportunity_type: "grant", owner: "", purpose: "", amount: "" });
  return (
    <div className="ie-stack">
      <Panel title="Outputs and publications">
        {outputs.loading ? <Loading /> : !outputs.data?.items.length ? <Empty>No outputs yet.</Empty> : (
          <table className="ie-table compact"><thead><tr><th>Output</th><th>Project</th><th>Status</th><th>Submitted</th><th>Published</th></tr></thead>
            <tbody>{outputs.data.items.map((o: any) => <tr key={o.id} className="clickable" onClick={() => go("projects", o.project_id)}><td>{o.title}<div className="muted small">{label(o.output_type)} · {shortSub(o.lead)}</div></td><td className="small">{o.project_title}</td><td><Status value={o.status} /></td><td className="small">{fmtDate(o.submitted_date)}</td><td className="small">{fmtDate(o.published_date)}</td></tr>)}</tbody></table>)}
      </Panel>
      <div className="ie-grid-2">
        <Panel title="Training cohorts">
          {training.loading ? <Loading /> : !training.data?.items.length ? <Empty>No cohorts.</Empty> : (
            <table className="ie-table compact"><tbody>{training.data.items.map((c: any) => <tr key={c.id}><td><b>{c.title}</b><div className="muted small">{c.facilitator} · {fmtDate(c.start_date)}–{fmtDate(c.end_date)} · {c.competencies.join(", ")}</div></td><td className="ih-num">{c.completed}/{c.enrolled} completed</td>
              <td>{office && <Button size="sm" variant="outline" onClick={() => { const e = prompt("Enrolled", String(c.enrolled)); const d = prompt("Completed", String(c.completed)); if (e !== null && d !== null) act.run(async () => { await api.patch(`${wp}/training/${c.id}`, { expected_version: c.version, enrolled: Number(e), completed: Number(d) }); training.reload(); }); }}>Update</Button>}</td></tr>)}</tbody></table>)}
          {office && (
            <form className="ie-form" onSubmit={(e) => { e.preventDefault(); act.run(async () => { await api.post(`${wp}/training`, { ...t, competencies: t.competencies.split(",").map((x) => x.trim()).filter(Boolean) }); training.reload(); setT({ title: "", facilitator: "", start_date: "", end_date: "", competencies: "" }); }); }}>
              <div className="ie-form-grid">
                <Field label="Course"><input className="ie-input" required value={t.title} onChange={(e) => setT({ ...t, title: e.target.value })} placeholder="Health economics for clinicians" /></Field>
                <Field label="Facilitator"><input className="ie-input" required value={t.facilitator} onChange={(e) => setT({ ...t, facilitator: e.target.value })} /></Field>
                <Field label="Start"><input className="ie-input" type="date" required value={t.start_date} onChange={(e) => setT({ ...t, start_date: e.target.value })} /></Field>
                <Field label="End"><input className="ie-input" type="date" required value={t.end_date} onChange={(e) => setT({ ...t, end_date: e.target.value })} /></Field>
                <Field wide label="Competencies (comma separated)"><input className="ie-input" value={t.competencies} onChange={(e) => setT({ ...t, competencies: e.target.value })} /></Field>
              </div>
              <Button type="submit" size="sm" disabled={act.busy}>Add cohort</Button>
            </form>)}
        </Panel>
        <Panel title="Partnerships and funding pipeline">
          {partners.loading ? <Loading /> : !partners.data?.items.length ? <Empty>No opportunities.</Empty> : (
            <table className="ie-table compact"><tbody>{partners.data.items.map((x: any) => <tr key={x.id}><td><b>{x.organization}</b><div className="muted small">{x.opportunity_type} · {x.purpose}</div></td><td className="ih-num">{x.amount ? `${x.currency} ${num(Number(x.amount))}` : "—"}</td>
              <td>{office ? <select className="ie-input sm" value={x.stage} onChange={(e) => act.run(async () => { await api.patch(`${wp}/partnerships/${x.id}`, { expected_version: x.version, stage: e.target.value }); partners.reload(); })}>{STAGES.map((s) => <option key={s}>{s}</option>)}</select> : <Status value={x.stage} />}</td></tr>)}</tbody></table>)}
          {office && (
            <form className="ie-form" onSubmit={(e) => { e.preventDefault(); act.run(async () => { await api.post(`${wp}/partnerships`, { ...p, owner: p.owner || "Research office", amount: p.amount ? Number(p.amount) : undefined, currency: p.amount ? ws.currency : undefined }); partners.reload(); setP({ organization: "", opportunity_type: "grant", owner: "", purpose: "", amount: "" }); }); }}>
              <div className="ie-form-grid">
                <Field label="Organization"><input className="ie-input" required value={p.organization} onChange={(e) => setP({ ...p, organization: e.target.value })} /></Field>
                <Field label="Type"><select className="ie-input" value={p.opportunity_type} onChange={(e) => setP({ ...p, opportunity_type: e.target.value })}><option value="grant">Grant</option><option value="sponsor">Sponsor</option><option value="collaboration">Collaboration</option></select></Field>
                <Field label={`Value (${ws.currency})`}><input className="ie-input" type="number" min={0} value={p.amount} onChange={(e) => setP({ ...p, amount: e.target.value })} /></Field>
                <Field wide label="Purpose"><input className="ie-input" required value={p.purpose} onChange={(e) => setP({ ...p, purpose: e.target.value })} /></Field>
              </div>
              <Button type="submit" size="sm" disabled={act.busy}>Add opportunity</Button>
            </form>)}
          <p className="muted small">Pipeline values are opportunities until finance verifies them.</p>
        </Panel>
      </div>
      <Feedback error={act.error} message={act.message} />
    </div>
  );
}
