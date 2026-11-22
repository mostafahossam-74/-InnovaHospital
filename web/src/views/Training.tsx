import { useState } from "react";
import { useWs } from "@/app/context";
import { useAction, useLoad } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { Empty, Feedback, Field, Loading, Notice, Panel, Status, fmtDate } from "@/components/common";

const EMPTY_COHORT = { title: "", facilitator: "", start_date: "", end_date: "", competencies: "", sessions: 4, min_attendance_percent: 80, assessment_required: false, pass_score: 70, capacity: "" };

/** Training cohorts and their people: attendance, assessment and completion (Developer_Handoff §2, §4). */
export function Training({ cohortId }: { cohortId: string | null }) {
  const { api, wp, has, go, departments } = useWs();
  const trainer = has("training_manager", "coordinator", "research_director");
  const list = useLoad(() => api.get(`${wp}/training`), [wp]);
  const d = useLoad(() => (cohortId ? api.get(`${wp}/training/${cohortId}`) : Promise.resolve(null)), [wp, cohortId]);
  const act = useAction();
  const [t, setT] = useState(EMPTY_COHORT);
  const [person, setPerson] = useState({ participant_name: "", participant_email: "", department_id: "" });
  const c = d.data;
  const today = new Date().toISOString().slice(0, 10);
  const ended = c && c.end_date <= today;
  const reload = () => { d.reload(); list.reload(); };
  const patch = (e: any, body: Record<string, unknown>) => act.run(async () => { await api.patch(`${wp}/training/enrollments/${e.id}`, { expected_version: e.version, ...body }); reload(); });

  return (
    <div className="ie-split">
      <Panel title="Cohorts">
        {list.loading ? <Loading /> : !list.data?.items.length ? <Empty>No cohorts.</Empty> : (
          <table className="ie-table compact"><tbody>{list.data.items.map((x: any) => (
            <tr key={x.id} className="clickable" onClick={() => go("training", x.id)}>
              <td><b>{x.title}</b><div className="muted small">{x.facilitator} · {fmtDate(x.start_date)}–{fmtDate(x.end_date)}</div></td>
              <td className="ih-num small">{x.people ? `${x.people_completed}/${x.people} completed` : x.enrolled ? `${x.completed}/${x.enrolled} (counts)` : "—"}</td></tr>))}</tbody></table>)}
        {trainer && (
          <form className="ie-form" onSubmit={(e) => { e.preventDefault(); act.run(async () => {
            const x = await api.post(`${wp}/training`, { title: t.title, facilitator: t.facilitator, start_date: t.start_date, end_date: t.end_date,
              competencies: t.competencies.split(",").map((s) => s.trim()).filter(Boolean), sessions: Number(t.sessions), min_attendance_percent: Number(t.min_attendance_percent),
              assessment_required: t.assessment_required, pass_score: t.assessment_required ? Number(t.pass_score) : null, ...(t.capacity ? { capacity: Number(t.capacity) } : {}) });
            setT(EMPTY_COHORT); list.reload(); go("training", x.id); }); }}>
            <div className="ie-form-grid">
              <Field label="Course"><input className="ie-input" required value={t.title} onChange={(e) => setT({ ...t, title: e.target.value })} placeholder="Health economics for clinicians" /></Field>
              <Field label="Facilitator"><input className="ie-input" required value={t.facilitator} onChange={(e) => setT({ ...t, facilitator: e.target.value })} /></Field>
              <Field label="Start"><input className="ie-input" type="date" required value={t.start_date} onChange={(e) => setT({ ...t, start_date: e.target.value })} /></Field>
              <Field label="End"><input className="ie-input" type="date" required value={t.end_date} onChange={(e) => setT({ ...t, end_date: e.target.value })} /></Field>
              <Field label="Sessions"><input className="ie-input" type="number" min={1} max={100} value={t.sessions} onChange={(e) => setT({ ...t, sessions: Number(e.target.value) })} /></Field>
              <Field label="Minimum attendance %"><input className="ie-input" type="number" min={0} max={100} value={t.min_attendance_percent} onChange={(e) => setT({ ...t, min_attendance_percent: Number(e.target.value) })} /></Field>
              <Field label="Assessment"><label className="small"><input type="checkbox" checked={t.assessment_required} onChange={(e) => setT({ ...t, assessment_required: e.target.checked })} /> required</label></Field>
              {t.assessment_required && <Field label="Pass score"><input className="ie-input" type="number" min={0} max={100} value={t.pass_score} onChange={(e) => setT({ ...t, pass_score: Number(e.target.value) })} /></Field>}
              <Field label="Capacity (optional)"><input className="ie-input" type="number" min={1} value={t.capacity} onChange={(e) => setT({ ...t, capacity: e.target.value })} /></Field>
              <Field wide label="Competencies (comma separated)"><input className="ie-input" value={t.competencies} onChange={(e) => setT({ ...t, competencies: e.target.value })} /></Field>
            </div>
            <Button type="submit" size="sm" disabled={act.busy}>Add cohort</Button>
          </form>)}
        <Feedback error={!cohortId ? act.error : null} />
      </Panel>

      <Panel title={c ? c.title : "Cohort"} eyebrow={c ? `${fmtDate(c.start_date)}–${fmtDate(c.end_date)} · ${c.sessions} session${c.sessions === 1 ? "" : "s"}` : undefined}>
        {!cohortId ? <Empty>Choose a cohort.</Empty> : d.loading || !c ? <Loading /> : (<>
          <Notice>Completion rule: attend at least {c.min_attendance_percent}% of the {c.sessions} sessions{c.assessment_required ? ` and score at least ${c.pass_score}` : ""}.
            {!ended && " Completion is decided after the cohort ends."}</Notice>
          {!c.enrollments.length && c.enrolled > 0 && <p className="muted small">Recorded as counts before person records: {c.completed} of {c.enrolled} completed.</p>}
          {!c.enrollments.length ? <Empty>No one enrolled yet.</Empty> : (
            <table className="ie-table compact"><thead><tr><th>Person</th><th>Attendance</th>{c.assessment_required && <th>Score</th>}<th>Status</th><th /></tr></thead>
              <tbody>{c.enrollments.map((e: any) => {
                const open = !["completed", "incomplete", "withdrawn"].includes(e.state);
                return (<tr key={e.id}>
                  <td>{e.participant_name}<div className="muted small">{e.participant_email ?? ""}{e.department_id ? ` · ${departments.find((x) => x.id === e.department_id)?.name ?? ""}` : ""}</div></td>
                  <td className="small">{Array.from({ length: c.sessions }, (_, i) => i + 1).map((s) => (
                    <label key={s} title={`Session ${s}`} style={{ marginRight: 4 }}>
                      <input type="checkbox" disabled={!trainer || !open || act.busy} checked={e.attended_sessions.includes(s)}
                        onChange={(ev) => patch(e, { attended_sessions: ev.target.checked ? [...e.attended_sessions, s] : e.attended_sessions.filter((x: number) => x !== s) })} />
                    </label>))}<div className="muted small">{e.rule.attendance_percent}%</div></td>
                  {c.assessment_required && <td>{trainer && open
                    ? <input className="ie-input sm" type="number" min={0} max={100} defaultValue={e.score ?? ""} style={{ width: 70 }} aria-label="Score"
                        onBlur={(ev) => { const v = ev.target.value === "" ? null : Number(ev.target.value); if (v !== e.score) patch(e, { score: v }); }} />
                    : e.score ?? "—"}</td>}
                  <td><Status value={e.state} />{open && <div className="muted small">{e.rule.meets ? "meets the rule" : e.rule.reasons.join("; ")}</div>}
                    {e.state === "completed" && <div className="muted small">{fmtDate(e.completion_date)}{e.certificate_reference ? ` · ${e.certificate_reference}` : ""}</div>}</td>
                  <td className="ie-inline">{trainer && open && ended && <Button size="sm" disabled={act.busy} onClick={() => act.run(async () => { await api.post(`${wp}/training/enrollments/${e.id}/decide`, { expected_version: e.version }); reload(); })}>Decide</Button>}
                    {trainer && open && <Button size="sm" variant="outline" disabled={act.busy} onClick={() => { if (confirm(`Withdraw ${e.participant_name}?`)) patch(e, { withdraw: true }); }}>Withdraw</Button>}
                    {trainer && e.state === "completed" && !e.certificate_reference && <Button size="sm" variant="outline" disabled={act.busy} onClick={() => { const ref = prompt("Certificate reference"); if (ref) patch(e, { certificate_reference: ref }); }}>Certificate</Button>}</td>
                </tr>);
              })}</tbody></table>)}
          {trainer && (
            <form className="ie-form" onSubmit={(ev) => { ev.preventDefault(); act.run(async () => {
              await api.post(`${wp}/training/${c.id}/enrollments`, { participant_name: person.participant_name, participant_email: person.participant_email || null, department_id: person.department_id || null });
              setPerson({ participant_name: "", participant_email: "", department_id: "" }); reload(); }); }}>
              <div className="ie-form-grid">
                <Field label="Name"><input className="ie-input" required value={person.participant_name} onChange={(e) => setPerson({ ...person, participant_name: e.target.value })} /></Field>
                <Field label="Email (optional)"><input className="ie-input" type="email" value={person.participant_email} onChange={(e) => setPerson({ ...person, participant_email: e.target.value })} /></Field>
                <Field label="Department (optional)"><select className="ie-input" value={person.department_id} onChange={(e) => setPerson({ ...person, department_id: e.target.value })}>
                  <option value="">—</option>{departments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
              </div>
              <Button type="submit" size="sm" disabled={act.busy}>Enroll</Button>
            </form>)}
          <Feedback error={act.error} message={act.message} />
        </>)}
      </Panel>
    </div>
  );
}
