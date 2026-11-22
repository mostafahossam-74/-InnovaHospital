import { useState } from "react";
import { Download, FileText } from "lucide-react";
import { useWs } from "@/app/context";
import { useAction, useLoad } from "@/lib/hooks";
import { openBlob } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Empty, Feedback, Field, Loading, Notice, Panel, Status, fmtDateTime, fmtPeriod, label, newKey, shortSub } from "@/components/common";

export function Reports({ reportId }: { reportId: string | null }) {
  const { api, wp, has, go, actor } = useWs();
  const list = useLoad(() => api.get(`${wp}/reports`), [wp]);
  const d = useLoad(() => (reportId ? api.get(`${wp}/reports/${reportId}`) : Promise.resolve(null)), [wp, reportId]);
  const act = useAction();
  const now = new Date(); const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const [period, setPeriod] = useState(`${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`);
  const [note, setNote] = useState("");
  const r = d.data; const s = r?.snapshot;
  const reload = () => { d.reload(); list.reload(); };
  return (
    <div className="ie-split">
      <Panel title="Revisions" actions={has("coordinator") && (
        <span className="ie-inline"><input className="ie-input sm" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Report month" />
          <Button size="sm" disabled={act.busy} onClick={() => act.run(async () => { const x = await api.post(`${wp}/report-runs`, { period }, { idempotencyKey: newKey() }); list.reload(); go("reports", x.id); })}><FileText size={14} /> Draft</Button></span>)}>
        {list.loading ? <Loading /> : !list.data?.items.length ? <Empty>No reports yet.</Empty> : (
          <table className="ie-table compact"><tbody>{list.data.items.map((x: any) => (
            <tr key={x.id} className="clickable" onClick={() => go("reports", x.id)}><td><b>{fmtPeriod(x.period)}</b><div className="muted small">revision {x.revision} · {fmtDateTime(x.created_at)}</div></td><td><Status value={x.status} /></td></tr>))}</tbody></table>)}
        <Feedback error={!reportId ? act.error : null} />
      </Panel>
      <Panel title={s ? `${s.hospital} — ${fmtPeriod(s.period)}` : "Report"} eyebrow={r ? `Revision ${r.revision} · digest ${r.digest.slice(0, 12)}` : undefined}
        actions={r && <Button size="sm" variant="outline" onClick={() => act.run(async () => openBlob(await api.blob(`${wp}/reports/${r.id}/pdf`)))}><Download size={14} /> PDF</Button>}>
        {!reportId ? <Empty>Select a report revision.</Empty> : d.loading || !r ? <Loading /> : (
          <>
            <div className="ie-inline wrap"><Status value={r.status} /><span className="muted small">author {shortSub(r.author)}{r.reviewer ? ` · reviewer ${shortSub(r.reviewer)}` : ""}{r.publisher ? ` · released by ${shortSub(r.publisher)} ${fmtDateTime(r.published_at)}` : ""}</span></div>
            {r.stale && <Notice kind="warning">Inputs changed since this revision was drafted. It can no longer be approved or released; draft a new revision.</Notice>}
            {r.review_note && <Notice>{r.review_note}</Notice>}
            {r.status === "draft" && has("innovastat_reviewer", "research_director") && r.author !== actor && (
              <div className="ie-form"><Field wide label="Review note (required to return)"><input className="ie-input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                <div className="ie-inline"><Button disabled={act.busy || r.stale} onClick={() => act.run(async () => { await api.post(`${wp}/reports/${r.id}/review`, { decision: "approve", digest: r.digest, note: note || undefined }); reload(); }, "Approved for release.")}>Approve</Button>
                  <Button variant="outline" disabled={act.busy || !note} onClick={() => act.run(async () => { await api.post(`${wp}/reports/${r.id}/review`, { decision: "return", digest: r.digest, note }); reload(); }, "Returned.")}>Return</Button></div></div>)}
            {r.status === "approved" && has("research_director") && ![r.author, r.reviewer].includes(actor) && (
              <Button disabled={act.busy || r.stale} onClick={() => act.run(async () => { await api.post(`${wp}/reports/${r.id}/publish`, { digest: r.digest }, { idempotencyKey: newKey() }); reload(); }, "Released to executive readers.")}>Release report</Button>)}
            <Feedback error={act.error} message={act.message} />

            <h3 className="ie-h3">Executive summary</h3>
            <ul>{s.executive_summary.map((l: string) => <li key={l}>{l}</li>)}</ul>
            {s.research_intelligence && <>
              <h3 className="ie-h3">Research from InnovaStat</h3>
              <table className="ie-table compact"><thead><tr><th>Suggested study</th><th>Category</th><th>Decision</th></tr></thead>
                <tbody>{s.research_intelligence.ideas.map((g: any) => <tr key={g.title}><td>{g.title}</td><td className="small">{label(g.study_category)}</td><td><Status value={g.status === "released" ? "proposed" : g.status} /></td></tr>)}</tbody></table>
            </>}
            <h3 className="ie-h3">Quality indicators</h3>
            <table className="ie-table compact"><thead><tr><th>Department</th><th>Indicator</th><th>Status</th><th className="ih-num">Value</th><th className="ih-num">Target</th></tr></thead>
              <tbody>{s.indicators.map((i: any, n: number) => <tr key={n}><td>{i.department}</td><td>{i.name}</td><td><Status value={i.status} /></td><td className="ih-num">{i.percent ?? "—"}{i.percent !== undefined ? "%" : ""}</td>
                <td className="ih-num">{i.target_percent !== undefined ? `${i.target_percent}% ${i.meets_target ? "✓ met" : "✗ not met"}` : "—"}</td></tr>)}</tbody></table>
            <h3 className="ie-h3">Next 30-day actions</h3>
            {!s.actions.length ? <Empty>None.</Empty> : <table className="ie-table compact"><tbody>{s.actions.map((a: any, n: number) => <tr key={n}><td>{a.action}</td><td className="small">{a.owner}</td><td className="small">{a.due_date}</td></tr>)}</tbody></table>}
            <details className="ie-details"><summary>Portfolio, milestones, outputs, training, risks</summary><pre className="mono" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify({ funnel: s.funnel, portfolio: s.portfolio, milestones: s.milestones, outputs: s.outputs, training: s.training, partnerships: s.partnerships, risks: s.risks }, null, 2)}</pre></details>
            <p className="muted small">{s.limitations.join(" ")}</p>
          </>)}
      </Panel>
    </div>
  );
}
