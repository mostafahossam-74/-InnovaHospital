import { useState } from "react";
import { Sparkles } from "lucide-react";
import { useWs } from "@/app/context";
import { useAction, useLoad } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { Empty, Feedback, Field, Loading, Notice, Panel, Status, fmtDateTime, label, shortSub } from "@/components/common";

const TYPES = ["management_outcome_variation", "cost_effectiveness", "department_outcome_variation", "parameter_outcome_association", "rising_burden", "high_burden_unstudied", "data_completeness"];

export function Gaps({ gapId }: { gapId: string | null }) {
  const { api, wp, has, go, actor, deptsFor } = useWs();
  const [status, setStatus] = useState(""); const [type, setType] = useState("");
  const list = useLoad(() => api.get(`${wp}/gaps?${new URLSearchParams({ ...(status && { status }), ...(type && { gap_type: type }) })}`), [wp, status, type]);
  const g = useLoad(() => (gapId ? api.get(`${wp}/gaps/${gapId}`) : Promise.resolve(null)), [wp, gapId]);
  const act = useAction();
  const [reason, setReason] = useState("");
  const ideaDepts = deptsFor("coordinator", "investigator", "innovastat_reviewer", "research_director", "department_lead");
  const [dept, setDept] = useState("");
  const gap = g.data;
  const decide = (s: string) => act.run(async () => { await api.post(`${wp}/gaps/${gap.id}/decision`, { status: s, reason, expected_version: gap.version }); setReason(""); g.reload(); list.reload(); }, `Gap ${s}.`);
  const makeIdea = (mode: "template" | "claude") => act.run(async () => {
    const r = await api.post(`${wp}/gaps/${gap.id}/ideas`, { department_id: dept || ideaDepts[0]?.id, mode });
    if (r.fallback_reasons?.length) alert(`Claude's draft was not usable (${r.fallback_reasons.join("; ")}); the standard template was used.`);
    go("ideas", r.id);
  });
  return (
    <div className="ie-split">
      <Panel title="Research gap register" actions={<>
        <select className="ie-input sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">Open + decided</option>{["proposed", "confirmed", "deferred", "rejected"].map((s) => <option key={s}>{s}</option>)}</select>
        <select className="ie-input sm" value={type} onChange={(e) => setType(e.target.value)} aria-label="Type"><option value="">All types</option>{TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></>}>
        {list.loading ? <Loading /> : !list.data?.items.length ? <Empty>No gaps. Run an analysis of verified hospital data.</Empty> : (
          <table className="ie-table compact"><tbody>{list.data.items.map((x: any) => (
            <tr key={x.id} className={`clickable ${x.id === gapId ? "selected" : ""}`} onClick={() => go("gaps", x.id)}>
              <td><span className="ih-score" title="Priority score 0-100">{Number(x.priority_score).toFixed(0)}</span></td>
              <td><b>{x.title}</b><div className="muted small">{label(x.gap_type)} · {label(x.study_category)}{x.ideas ? ` · ${x.ideas} idea(s)` : ""}</div></td>
              <td><Status value={x.status} /></td></tr>))}</tbody></table>)}
      </Panel>
      <Panel title={gap?.title ?? "Gap detail"} eyebrow={gap ? `${label(gap.gap_type)} · ${label(gap.study_category)}` : undefined}>
        {!gapId ? <Empty>Select a gap to see the evidence behind it.</Empty> : g.loading || !gap ? <Loading /> : (
          <>
            <p className="ih-statement">{gap.statement}</p>
            <dl className="ie-dl">
              <div><dt>Priority</dt><dd><span className="ih-score">{Number(gap.priority_score).toFixed(1)}</span></dd></div>
              <div><dt>Status</dt><dd><Status value={gap.status} /></dd></div>
              {gap.condition_code && <div><dt>Condition</dt><dd>{gap.condition_label} ({gap.condition_code})</dd></div>}
              <div><dt>Proposed by</dt><dd>{shortSub(gap.created_by)} · {fmtDateTime(gap.created_at)}</dd></div>
              {gap.decided_by && <div><dt>Decided by</dt><dd>{shortSub(gap.decided_by)} · {fmtDateTime(gap.decided_at)}</dd></div>}
            </dl>
            {gap.decision_reason && <Notice>{gap.decision_reason}</Notice>}
            <h3 className="ie-h3">Suggested study designs</h3>
            <ul>{gap.suggested_designs.map((d: string) => <li key={d}>{d}</li>)}</ul>
            <details className="ie-details"><summary>Statistics behind this gap</summary><pre className="mono" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(gap.metrics, null, 2)}</pre></details>
            <p className="muted small">Priority = 40% disease burden + 35% size of effect + 25% strength of evidence (false-discovery-adjusted q).</p>
            {gap.status !== "confirmed" && has("innovastat_reviewer", "research_director") && (gap.created_by === actor
              ? <Notice>You ran this analysis, so another reviewer decides its gaps.</Notice>
              : <div className="ie-form">
                  <Field wide label="Decision rationale"><textarea className="ie-input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Clinically important, feasible with local data, not already answered…" /></Field>
                  <div className="ie-inline"><Button disabled={!reason || act.busy} onClick={() => decide("confirmed")}>Confirm gap</Button>
                    <Button variant="outline" disabled={!reason || act.busy} onClick={() => decide("deferred")}>Defer</Button>
                    <Button variant="outline" disabled={!reason || act.busy} onClick={() => decide("rejected")}>Reject</Button></div>
                </div>)}
            {gap.status === "confirmed" && ideaDepts.length > 0 && (
              <div className="ie-form">
                <h3>Turn into a research idea</h3>
                <Field label="Department"><select className="ie-input" value={dept} onChange={(e) => setDept(e.target.value)}>{ideaDepts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
                <div className="ie-inline">
                  <Button disabled={act.busy} onClick={() => makeIdea("template")}>Draft study idea</Button>
                  <Button variant="outline" disabled={act.busy} onClick={() => makeIdea("claude")}><Sparkles size={14} /> Draft with Claude</Button>
                </div>
                <p className="muted small">The draft opens in Ideas for the investigator to edit before submission. Claude drafts are rejected if they state numbers not in this gap.</p>
              </div>)}
            {gap.ideas?.length > 0 && <><h3 className="ie-h3">Ideas from this gap</h3>
              <table className="ie-table compact"><tbody>{gap.ideas.map((i: any) => <tr key={i.id} className="clickable" onClick={() => go("ideas", i.id)}><td>{i.title}</td><td><Status value={i.status} /></td><td className="small muted">{i.origin}</td></tr>)}</tbody></table></>}
            <Feedback error={act.error} message={act.message} />
          </>)}
      </Panel>
    </div>
  );
}
