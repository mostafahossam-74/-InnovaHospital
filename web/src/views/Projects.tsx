import { useState } from "react";
import { useWs } from "@/app/context";
import { useAction, useLoad } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { Empty, Feedback, Field, Loading, Notice, Panel, Status, fmtDate, fmtDateTime, label, shortSub } from "@/components/common";

const NEXT: Record<string, string[]> = { draft: ["submitted"], submitted: ["feasibility", "draft"], feasibility: ["governance", "draft"], governance: ["active", "feasibility"], active: ["on_hold", "complete"], on_hold: ["active", "complete"], complete: ["archived"] };
const OUTPUT_TYPES = ["protocol", "sap", "analysis", "manuscript", "abstract", "poster", "economic_model", "report"];
const OUTPUT_NEXT: Record<string, string[]> = { planned: ["in_progress"], in_progress: ["qc"], qc: ["approved", "in_progress"], approved: ["submitted", "released"], submitted: ["accepted"], accepted: ["published"] };

export function Projects({ projectId }: { projectId: string | null }) {
  const { api, wp, has, go, actor } = useWs();
  const list = useLoad(() => api.get(`${wp}/projects`), [wp]);
  const d = useLoad(() => (projectId ? api.get(`${wp}/projects/${projectId}`) : Promise.resolve(null)), [wp, projectId]);
  const act = useAction();
  const [reason, setReason] = useState("");
  const [dec, setDec] = useState({ kind: "ethics", authority: "", decision: "approved", reference: "", effective_date: "", expiry_date: "", permitted_scope: "" });
  const [ms, setMs] = useState({ title: "", owner: "", due_date: "" });
  const [out, setOut] = useState({ output_type: "protocol", title: "", lead: "" });
  const p = d.data;
  const office = has("coordinator", "research_director");
  const isPi = p?.pi === actor;
  const reload = () => { d.reload(); list.reload(); };
  return (
    <div className="ie-split">
      <Panel title="Portfolio">
        {list.loading ? <Loading /> : !list.data?.items.length ? <Empty>No projects yet. Accepted ideas are converted here.</Empty> : (
          <table className="ie-table compact"><tbody>{list.data.items.map((x: any) => (
            <tr key={x.id} className="clickable" onClick={() => go("projects", x.id)}>
              <td><b>{x.title}</b><div className="muted small">{x.department} · {label(x.study_category)} · protocol v{x.protocol_version}{x.overdue_milestones ? ` · ${x.overdue_milestones} overdue` : ""}</div></td>
              <td><Status value={x.stage} /></td></tr>))}</tbody></table>)}
      </Panel>
      <Panel title={p?.title ?? "Project"} eyebrow={p ? `${p.department} · ${p.study_type}` : undefined}>
        {!projectId ? <Empty>Select a project.</Empty> : d.loading || !p ? <Loading /> : (
          <>
            <div className="ie-inline wrap"><Status value={p.stage} /><span className="muted small">PI {shortSub(p.pi)} · protocol v{p.protocol_version} · v{p.version}</span>
              {p.idea_id && <a className="ie-link small" onClick={() => go("ideas", p.idea_id)}>Source idea</a>}</div>
            {p.objective && <p className="ie-prose">{p.objective}</p>}
            {p.hold_reason && <Notice kind="warning">On hold: {p.hold_reason}</Notice>}
            {p.gate_problems.length > 0 && ["governance", "active", "on_hold"].includes(p.stage) && <Notice kind="warning">Approval gate: {p.gate_problems.join("; ")}</Notice>}
            {(office || isPi) && NEXT[p.stage] && (
              <div className="ie-form">
                <Field wide label="Reason (needed for hold, return or completion)"><input className="ie-input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                <div className="ie-inline wrap">
                  {NEXT[p.stage].filter((t) => office || t === "submitted").map((t) => (
                    <Button key={t} variant={["active", "submitted", "feasibility", "governance"].includes(t) ? "default" : "outline"} disabled={act.busy}
                      onClick={() => act.run(async () => { await api.post(`${wp}/projects/${p.id}/transition`, { target: t, expected_version: p.version, reason: reason || undefined }); setReason(""); reload(); }, `Moved to ${label(t)}.`)}>{label(t)}</Button>))}
                  {(["active", "governance", "on_hold"].includes(p.stage)) && (
                    <Button variant="outline" disabled={!reason || act.busy} onClick={() => act.run(async () => { await api.post(`${wp}/projects/${p.id}/amend`, { expected_version: p.version, reason }); setReason(""); reload(); }, "Protocol amended; new approvals are needed.")}>Amend protocol</Button>)}
                </div>
              </div>)}
            <Feedback error={act.error} message={act.message} />

            <h3 className="ie-h3">Governance decisions</h3>
            {!p.decisions.length ? <Empty>No decisions recorded.</Empty> : (
              <table className="ie-table compact"><thead><tr><th>Kind</th><th>Decision</th><th>Authority / reference</th><th>Protocol</th><th>Valid</th><th></th></tr></thead>
                <tbody>{p.decisions.map((x: any) => (
                  <tr key={x.id} style={{ opacity: x.superseded ? 0.5 : 1 }}><td>{x.kind}</td><td><Status value={x.decision} /></td><td className="small">{x.authority} · {x.reference}</td>
                    <td>v{x.protocol_version}</td><td className="small">{fmtDate(x.effective_date)} – {x.expiry_date ? fmtDate(x.expiry_date) : "open"}</td><td className="small muted">{x.superseded ? "superseded" : "current"}</td></tr>))}</tbody></table>)}
            {has("governance_recorder") && (
              <form className="ie-form" onSubmit={(e) => { e.preventDefault(); act.run(async () => {
                const r = await api.post(`${wp}/projects/${p.id}/decisions`, { ...dec, expiry_date: dec.expiry_date || null, protocol_version: p.protocol_version });
                reload(); if (r.project_on_hold) alert("The project was put on hold because its approvals are no longer valid."); }, "Decision recorded."); }}>
                <h3>Record an official decision (protocol v{p.protocol_version})</h3>
                <div className="ie-form-grid">
                  <Field label="Kind"><select className="ie-input" value={dec.kind} onChange={(e) => setDec({ ...dec, kind: e.target.value })}><option value="ethics">Ethics</option><option value="data">Data access</option></select></Field>
                  <Field label="Decision"><select className="ie-input" value={dec.decision} onChange={(e) => setDec({ ...dec, decision: e.target.value })}>{["approved", "determination", "denied", "revoked"].map((x) => <option key={x}>{x}</option>)}</select></Field>
                  <Field label="Authority"><input className="ie-input" required value={dec.authority} onChange={(e) => setDec({ ...dec, authority: e.target.value })} placeholder="Hospital REC" /></Field>
                  <Field label="Official reference"><input className="ie-input" required value={dec.reference} onChange={(e) => setDec({ ...dec, reference: e.target.value })} /></Field>
                  <Field label="Effective"><input className="ie-input" type="date" required value={dec.effective_date} onChange={(e) => setDec({ ...dec, effective_date: e.target.value })} /></Field>
                  <Field label="Expiry"><input className="ie-input" type="date" value={dec.expiry_date} onChange={(e) => setDec({ ...dec, expiry_date: e.target.value })} /></Field>
                  <Field wide label="Permitted scope (sites, purposes, period)"><input className="ie-input" required value={dec.permitted_scope} onChange={(e) => setDec({ ...dec, permitted_scope: e.target.value })} /></Field>
                </div>
                <Button type="submit" disabled={act.busy}>Record decision</Button>
              </form>)}

            <h3 className="ie-h3">Milestones</h3>
            {!p.milestones.length ? <Empty>No milestones.</Empty> : (
              <table className="ie-table compact"><tbody>{p.milestones.map((m: any) => (
                <tr key={m.id}><td>{m.title}<div className="muted small">{shortSub(m.owner)} · due {fmtDate(m.due_date)}{m.completed_date ? ` · done ${fmtDate(m.completed_date)}` : ""}</div></td><td><Status value={m.state} /></td>
                  <td>{(office || isPi) && m.state !== "done" && <select className="ie-input sm" value="" onChange={(e) => e.target.value && act.run(async () => { await api.patch(`${wp}/milestones/${m.id}`, { expected_version: m.version, state: e.target.value }); reload(); })}>
                    <option value="">Update…</option>{["in_progress", "blocked", "done", "cancelled"].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>}</td></tr>))}</tbody></table>)}
            {(office || isPi) && (
              <form className="ie-form" onSubmit={(e) => { e.preventDefault(); act.run(async () => { await api.post(`${wp}/projects/${p.id}/milestones`, { ...ms, owner: ms.owner || actor }); setMs({ title: "", owner: "", due_date: "" }); reload(); }); }}>
                <div className="ie-form-grid"><Field label="Milestone"><input className="ie-input" required value={ms.title} onChange={(e) => setMs({ ...ms, title: e.target.value })} placeholder="SAP approved" /></Field>
                  <Field label="Owner"><input className="ie-input" value={ms.owner} onChange={(e) => setMs({ ...ms, owner: e.target.value })} placeholder="(you)" /></Field>
                  <Field label="Due"><input className="ie-input" type="date" required value={ms.due_date} onChange={(e) => setMs({ ...ms, due_date: e.target.value })} /></Field></div>
                <Button type="submit" size="sm" disabled={act.busy}>Add milestone</Button>
              </form>)}

            <h3 className="ie-h3">Outputs and publications</h3>
            {!p.outputs.length ? <Empty>No outputs.</Empty> : (
              <table className="ie-table compact"><tbody>{p.outputs.map((o: any) => (
                <tr key={o.id}><td>{o.title}<div className="muted small">{label(o.output_type)} · lead {shortSub(o.lead)}{o.doi ? ` · ${o.doi}` : ""}</div></td><td><Status value={o.status} /></td>
                  <td className="ie-inline">{(OUTPUT_NEXT[o.status] ?? []).map((s) => <Button key={s} size="sm" variant="outline" disabled={act.busy}
                    onClick={() => act.run(async () => { const today = new Date().toISOString().slice(0, 10);
                      await api.patch(`${wp}/outputs/${o.id}`, { expected_version: o.version, status: s, ...(s === "submitted" && { submitted_date: today }), ...(s === "accepted" && { accepted_date: today }), ...(s === "published" && { published_date: today }) }); reload(); })}>{label(s)}</Button>)}</td></tr>))}</tbody></table>)}
            {(office || isPi) && (
              <form className="ie-form" onSubmit={(e) => { e.preventDefault(); act.run(async () => { await api.post(`${wp}/projects/${p.id}/outputs`, { ...out, lead: out.lead || actor }); setOut({ output_type: "protocol", title: "", lead: "" }); reload(); }); }}>
                <div className="ie-form-grid"><Field label="Type"><select className="ie-input" value={out.output_type} onChange={(e) => setOut({ ...out, output_type: e.target.value })}>{OUTPUT_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
                  <Field label="Title"><input className="ie-input" required value={out.title} onChange={(e) => setOut({ ...out, title: e.target.value })} /></Field></div>
                <Button type="submit" size="sm" disabled={act.busy}>Add output</Button>
              </form>)}
            <details className="ie-details"><summary>Stage history</summary><ul>{p.history.map((h: any, n: number) => <li key={n}>{fmtDateTime(h.created_at)} · {shortSub(h.actor)}: {h.from_stage} → {h.to_stage}{h.reason ? ` — ${h.reason}` : ""}</li>)}</ul></details>
          </>)}
      </Panel>
    </div>
  );
}
