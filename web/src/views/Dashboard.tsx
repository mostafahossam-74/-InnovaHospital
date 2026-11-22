import { Activity, BarChart3, FlaskConical, Lightbulb, Target, TriangleAlert } from "lucide-react";
import { useWs } from "@/app/context";
import { useLoad } from "@/lib/hooks";
import { Bar, Empty, Loading, Metric, Notice, Panel, Status, label, num, pct } from "@/components/common";

export function Dashboard() {
  const { api, wp, staff, go, ws } = useWs();
  const d = useLoad(async () => {
    if (!staff) return null;
    const [analyses, gaps, ideas, projects] = await Promise.all([
      api.get(`${wp}/analyses`), api.get(`${wp}/gaps`), api.get(`${wp}/ideas`), api.get(`${wp}/projects`)]);
    const latest = analyses.items[0] ? await api.get(`${wp}/analyses/${analyses.items[0].id}`) : null;
    return { latest, gaps: gaps.items, ideas: ideas.items, projects: projects.items };
  }, [wp, staff]);
  if (!staff) return <Notice>Released monthly reports are under <a className="ie-link" onClick={() => go("reports")}>Monthly reports</a>.</Notice>;
  if (d.loading) return <Loading />;
  if (d.error) return <Notice kind="error">{d.error}</Notice>;
  const { latest, gaps, ideas, projects } = d.data!;
  const s = latest?.results.summary;
  const conds = latest?.results.conditions ?? [];
  const confirmed = gaps.filter((g: any) => g.status === "confirmed");
  const proposed = gaps.filter((g: any) => g.status === "proposed");
  return (
    <div className="ie-stack">
      <div className="ih-kpis">
        <Metric icon={BarChart3} label="Cases analysed" value={s ? num(s.total_cases) : "—"} sub={s ? `${s.periods[0]} to ${s.periods.at(-1)} · ${s.conditions} conditions` : "No analysis yet"} />
        <Metric icon={Target} tone="amber" label="Research gaps" value={`${confirmed.length} confirmed`} sub={`${proposed.length} awaiting review`} />
        <Metric icon={Lightbulb} label="Research ideas" value={ideas.length} sub={`${ideas.filter((i: any) => i.source_gap_id).length} from hospital data`} />
        <Metric icon={FlaskConical} tone="blue" label="Active projects" value={projects.filter((p: any) => p.stage === "active").length} sub={`${projects.filter((p: any) => p.stage === "on_hold").length} on hold`} />
        <Metric icon={Activity} label="Hospital mortality" value={s?.mortality ? pct(s.mortality.rate) : "—"} sub={s?.mean_cost ? `mean cost ${ws.currency} ${num(s.mean_cost)}` : undefined} />
      </div>
      <div className="ie-grid-2">
        <Panel title="Disease burden" eyebrow="Share of all cases" actions={<a className="ie-link small" onClick={() => go("analysis", latest?.id)}>Open analytics</a>}>
          {!conds.length ? <Empty>Upload and verify hospital data, then run an analysis.</Empty> : (
            <table className="ie-table compact"><thead><tr><th>Condition</th><th>Share</th><th className="ih-num">Cases</th><th className="ih-num">Mortality</th></tr></thead>
              <tbody>{conds.slice(0, 8).map((c: any) => (
                <tr key={c.condition_code}><td>{c.condition_label} <span className="muted small">{c.condition_code}</span></td>
                  <td style={{ minWidth: 180 }}><Bar value={c.share} max={conds[0].share} text={pct(c.share)} /></td>
                  <td className="ih-num">{num(c.cases)}</td><td className="ih-num">{pct(c.mortality?.rate)}</td></tr>))}</tbody></table>)}
        </Panel>
        <Panel title="Highest-priority research gaps" actions={<a className="ie-link small" onClick={() => go("gaps")}>All gaps</a>}>
          {!gaps.length ? <Empty>No gaps yet.</Empty> : (
            <table className="ie-table compact"><tbody>{gaps.slice(0, 8).map((g: any) => (
              <tr key={g.id} className="clickable" onClick={() => go("gaps", g.id)}>
                <td><span className="ih-score">{Number(g.priority_score).toFixed(0)}</span></td>
                <td>{g.title}<div className="muted small">{label(g.study_category)}</div></td><td><Status value={g.status} /></td></tr>))}</tbody></table>)}
        </Panel>
      </div>
      {projects.some((p: any) => p.stage === "on_hold" || p.overdue_milestones > 0) && (
        <Panel title={<><TriangleAlert size={16} /> Needs attention</>}>
          <table className="ie-table compact"><tbody>{projects.filter((p: any) => p.stage === "on_hold" || p.overdue_milestones > 0).map((p: any) => (
            <tr key={p.id} className="clickable" onClick={() => go("projects", p.id)}><td>{p.title}</td><td><Status value={p.stage} /></td>
              <td className="muted small">{p.hold_reason ?? `${p.overdue_milestones} overdue milestone(s)`}</td></tr>))}</tbody></table>
        </Panel>)}
    </div>
  );
}
