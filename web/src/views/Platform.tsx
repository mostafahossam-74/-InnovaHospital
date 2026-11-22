import { useState } from "react";
import type { Api } from "@/lib/api";
import { useAction, useLoad } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { Feedback, Field, Loading, Panel, fmtDateTime } from "@/components/common";

export function Platform({ api }: { api: Api }) {
  const list = useLoad(() => api.get("/v1/admin/workspaces"), []);
  const act = useAction();
  const [f, setF] = useState({ name: "", slug: "", country: "EG", currency: "EGP", timezone: "Africa/Cairo", admin_subject: "", admin_issuer: "" });
  return (
    <div className="ie-stack">
      <Panel title="Hospitals">
        {list.loading ? <Loading /> : <table className="ie-table compact"><tbody>{list.data.items.map((w: any) => <tr key={w.id}><td><b>{w.name}</b></td><td className="mono">{w.slug}</td><td>{w.country}</td><td className="small">{fmtDateTime(w.created_at)}</td></tr>)}</tbody></table>}
        <p className="muted small">Platform administrators see hospital identifiers only. Reading hospital data needs an explicit, logged role grant.</p>
      </Panel>
      <Panel title="Provision a hospital">
        <form className="ie-form" onSubmit={(e) => { e.preventDefault(); act.run(async () => {
          const r = await api.post("/v1/admin/workspaces", { name: f.name, slug: f.slug, country: f.country, currency: f.currency, timezone: f.timezone });
          if (f.admin_subject) await api.post(`/v1/admin/workspaces/${r.id}/memberships`, { issuer: f.admin_issuer, subject: f.admin_subject, role: "hospital_admin" });
          list.reload(); }, "Hospital provisioned."); }}>
          <div className="ie-form-grid">
            <Field label="Name"><input className="ie-input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Slug"><input className="ie-input" required pattern="[a-z0-9][a-z0-9-]+" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} /></Field>
            <Field label="Country"><select className="ie-input" value={f.country} onChange={(e) => setF({ ...f, country: e.target.value, currency: e.target.value === "SA" ? "SAR" : "EGP", timezone: e.target.value === "SA" ? "Asia/Riyadh" : "Africa/Cairo" })}><option value="EG">Egypt</option><option value="SA">Saudi Arabia</option></select></Field>
            <Field label="Currency"><input className="ie-input" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} /></Field>
            <Field label="First hospital admin: issuer"><input className="ie-input" value={f.admin_issuer} onChange={(e) => setF({ ...f, admin_issuer: e.target.value })} /></Field>
            <Field label="First hospital admin: subject"><input className="ie-input" value={f.admin_subject} onChange={(e) => setF({ ...f, admin_subject: e.target.value })} /></Field>
          </div>
          <Button type="submit" disabled={act.busy}>Provision</Button>
          <Feedback error={act.error} message={act.message} />
        </form>
      </Panel>
    </div>
  );
}
