import { useState } from "react";
import { useWs } from "@/app/context";
import { useAction, useLoad } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { Empty, Feedback, Field, Loading, Panel, Status, shortSub } from "@/components/common";

export function Indicators() {
  const { api, wp, has, actor, deptsFor } = useWs();
  const now = new Date(); const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const [period, setPeriod] = useState(`${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`);
  const defs = useLoad(() => api.get(`${wp}/indicator-definitions`), [wp]);
  const obs = useLoad(() => api.get(`${wp}/indicators?period=${period}`), [wp, period]);
  const act = useAction();
  const [entry, setEntry] = useState<Record<string, { n: string; d: string }>>({});
  const [nd, setNd] = useState({ code: "", name: "", category: "", numerator_definition: "", denominator_definition: "", direction: "higher_better", target_percent: "" });
  const entryDepts = deptsFor("data_steward", "coordinator");
  const reload = () => { obs.reload(); defs.reload(); };
  return (
    <div className="ie-stack">
      <Panel title="Monthly values" actions={<input className="ie-input sm" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Period" />}>
        {defs.loading || obs.loading ? <Loading /> : !defs.data?.items.length ? <Empty>No indicator definitions yet.</Empty> : (
          <table className="ie-table compact"><thead><tr><th>Indicator</th><th>Department</th><th>Value</th><th>Status</th><th>Entered by</th><th></th></tr></thead>
            <tbody>{defs.data.items.flatMap((def: any) => deptsFor("data_steward", "coordinator", "innovastat_reviewer", "research_director", "department_lead", "hospital_admin").map((dep) => {
              const o = obs.data?.items.find((x: any) => x.definition_id === def.id && x.department_id === dep.id);
              const k = `${def.code}|${dep.id}`;
              return (
                <tr key={k}><td><b>{def.name}</b><div className="muted small">v{def.def_version} · target {def.target_bp === null ? "—" : `${def.target_bp / 100}%`} · {def.direction.replace("_", " ")}</div></td>
                  <td>{dep.name}</td>
                  <td className="ih-num">{o ? `${o.numerator}/${o.denominator}${o.denominator ? ` (${((100 * o.numerator) / o.denominator).toFixed(1)}%)` : ""}` : "—"}</td>
                  <td>{o ? <Status value={o.status === "submitted" ? "unverified" : o.status} /> : <Status value="missing" />}</td>
                  <td className="small">{o ? shortSub(o.submitted_by) : ""}</td>
                  <td className="ie-inline">
                    {entryDepts.some((x) => x.id === dep.id) && <>
                      <input className="ie-input sm" style={{ minWidth: 60, width: 70 }} placeholder="num" value={entry[k]?.n ?? ""} onChange={(e) => setEntry({ ...entry, [k]: { ...entry[k], n: e.target.value } })} />
                      <input className="ie-input sm" style={{ minWidth: 60, width: 70 }} placeholder="den" value={entry[k]?.d ?? ""} onChange={(e) => setEntry({ ...entry, [k]: { ...entry[k], d: e.target.value } })} />
                      <Button size="sm" variant="outline" disabled={act.busy || !entry[k]?.n || !entry[k]?.d} onClick={() => act.run(async () => {
                        await api.put(`${wp}/indicators/${dep.id}/${period}/${def.code}`, { numerator: Number(entry[k].n), denominator: Number(entry[k].d), expected_version: o?.input_version ?? 0 });
                        setEntry({ ...entry, [k]: { n: "", d: "" } }); reload(); }, "Saved; needs verification.")}>Save</Button></>}
                    {o?.status === "submitted" && o.submitted_by !== actor && has("innovastat_reviewer", "research_director", "department_lead") &&
                      <Button size="sm" disabled={act.busy} onClick={() => act.run(async () => { await api.post(`${wp}/indicators/${o.id}/verify`, { decision: "verified", expected_version: o.input_version }); reload(); }, "Verified.")}>Verify</Button>}
                  </td></tr>);
            }))}</tbody></table>)}
        <Feedback error={act.error} message={act.message} />
        <p className="muted small">Zero eligible cases (denominator 0) is reported as not applicable, distinct from a missing value. Small cells are suppressed in reports.</p>
      </Panel>
      {has("research_director", "hospital_admin") && (
        <Panel title="Define an indicator" eyebrow="A changed definition becomes a new version">
          <form className="ie-form" onSubmit={(e) => { e.preventDefault(); act.run(async () => { await api.post(`${wp}/indicator-definitions`, { ...nd, target_percent: nd.target_percent === "" ? undefined : Number(nd.target_percent) }); reload(); }, "Definition saved."); }}>
            <div className="ie-form-grid">
              <Field label="Code"><input className="ie-input" required pattern="[a-z][a-z0-9_]+" value={nd.code} onChange={(e) => setNd({ ...nd, code: e.target.value })} placeholder="door_to_balloon_90" /></Field>
              <Field label="Name"><input className="ie-input" required value={nd.name} onChange={(e) => setNd({ ...nd, name: e.target.value })} /></Field>
              <Field label="Category"><input className="ie-input" required value={nd.category} onChange={(e) => setNd({ ...nd, category: e.target.value })} placeholder="Clinical quality" /></Field>
              <Field label="Direction"><select className="ie-input" value={nd.direction} onChange={(e) => setNd({ ...nd, direction: e.target.value })}><option value="higher_better">Higher is better</option><option value="lower_better">Lower is better</option></select></Field>
              <Field label="Target %"><input className="ie-input" type="number" min={0} max={100} step="0.01" value={nd.target_percent} onChange={(e) => setNd({ ...nd, target_percent: e.target.value })} /></Field>
              <Field wide label="Numerator definition"><input className="ie-input" required value={nd.numerator_definition} onChange={(e) => setNd({ ...nd, numerator_definition: e.target.value })} /></Field>
              <Field wide label="Denominator definition"><input className="ie-input" required value={nd.denominator_definition} onChange={(e) => setNd({ ...nd, denominator_definition: e.target.value })} /></Field>
            </div>
            <Button type="submit" disabled={act.busy}>Save definition</Button>
          </form>
        </Panel>)}
    </div>
  );
}
