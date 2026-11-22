import { useState } from "react";
import { ROLE_LABEL, useWs, type Role } from "@/app/context";
import { useAction, useLoad } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { Feedback, Field, Loading, Panel } from "@/components/common";

export function WorkspaceSettings() {
  const { api, wp, ws, me, departments, refreshWorkspace } = useWs();
  const members = useLoad(() => api.get(`${wp}/memberships`), [wp]);
  const act = useAction();
  const [s, setS] = useState({ name: ws.name, currency: ws.currency, small_cell: ws.small_cell, timezone: ws.timezone });
  const [g, setG] = useState({ subject: "", role: "investigator", department_id: "", email: "" });
  const [dep, setDep] = useState({ code: "", name: "" });
  return (
    <div className="ie-stack">
      <Panel title="Hospital settings">
        <form className="ie-form" onSubmit={(e) => { e.preventDefault(); act.run(async () => { await api.patch(`${wp}/settings`, { expected_version: ws.version, ...s, small_cell: Number(s.small_cell) }); refreshWorkspace(); }, "Saved."); }}>
          <div className="ie-form-grid">
            <Field label="Name"><input className="ie-input" value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} /></Field>
            <Field label="Currency"><input className="ie-input" value={s.currency} onChange={(e) => setS({ ...s, currency: e.target.value.toUpperCase() })} /></Field>
            <Field label="Timezone"><input className="ie-input" value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })} /></Field>
            <Field label="Disclosure threshold" hint="Cells below this count are suppressed in reports. Set by hospital policy."><input className="ie-input" type="number" min={1} value={s.small_cell} onChange={(e) => setS({ ...s, small_cell: Number(e.target.value) })} /></Field>
          </div>
          <Button type="submit" disabled={act.busy}>Save settings</Button>
        </form>
      </Panel>
      <div className="ie-grid-2">
        <Panel title="Departments">
          <table className="ie-table compact"><tbody>{departments.map((d) => <tr key={d.id}><td><b>{d.name}</b></td><td className="mono">{d.code}</td></tr>)}</tbody></table>
          <form className="ie-form" onSubmit={(e) => { e.preventDefault(); act.run(async () => { await api.post(`${wp}/departments`, dep); setDep({ code: "", name: "" }); refreshWorkspace(); }); }}>
            <div className="ie-form-grid"><Field label="Code"><input className="ie-input" required pattern="[a-z0-9][a-z0-9_-]*" value={dep.code} onChange={(e) => setDep({ ...dep, code: e.target.value })} placeholder="nephro" /></Field>
              <Field label="Name"><input className="ie-input" required value={dep.name} onChange={(e) => setDep({ ...dep, name: e.target.value })} placeholder="Nephrology" /></Field></div>
            <Button type="submit" size="sm" disabled={act.busy}>Add department</Button>
          </form>
        </Panel>
        <Panel title="People and role grants">
          {members.loading ? <Loading /> : (
            <table className="ie-table compact"><tbody>{members.data.items.map((m: any) => <tr key={m.id}><td>{m.display_name ?? m.email ?? m.subject}</td><td className="small">{ROLE_LABEL[m.role as Role]}</td><td className="small">{m.department ?? "All departments"}</td>
              <td><Button size="sm" variant="outline" onClick={() => { const reason = prompt("Reason for revoking this grant?"); if (reason) act.run(async () => { await api.post(`${wp}/memberships/${m.id}/revoke`, { reason }); members.reload(); }); }}>Revoke</Button></td></tr>)}</tbody></table>)}
          <form className="ie-form" onSubmit={(e) => { e.preventDefault(); act.run(async () => { await api.post(`${wp}/memberships`, { issuer: me.issuer, subject: g.subject, role: g.role, department_id: g.department_id || null, email: g.email || undefined }); members.reload(); }, "Granted."); }}>
            <div className="ie-form-grid">
              <Field label="Account subject" hint="From the person's sign-in (shown when they have no access)."><input className="ie-input" required value={g.subject} onChange={(e) => setG({ ...g, subject: e.target.value })} /></Field>
              <Field label="Role"><select className="ie-input" value={g.role} onChange={(e) => setG({ ...g, role: e.target.value })}>{Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              <Field label="Department"><select className="ie-input" value={g.department_id} onChange={(e) => setG({ ...g, department_id: e.target.value })}><option value="">All departments</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
              <Field label="Email"><input className="ie-input" type="email" value={g.email} onChange={(e) => setG({ ...g, email: e.target.value })} /></Field>
            </div>
            <Button type="submit" size="sm" disabled={act.busy}>Grant</Button>
          </form>
        </Panel>
      </div>
      <Feedback error={act.error} message={act.message} />
    </div>
  );
}
