import { useState } from "react";
import { Download, Upload } from "lucide-react";
import { useWs } from "@/app/context";
import { useAction, useLoad } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { Empty, Feedback, Field, Loading, Notice, Panel, Status, fmtDateTime, shortSub } from "@/components/common";

const CASE_COLUMNS = ["period", "department", "condition_code", "condition_label", "management", "age_band", "sex", "cases", "deaths", "readmissions_30d", "complications", "los_days_sum", "cost_sum"];
const PARAM_COLUMNS = ["period", "department", "parameter_code", "parameter_label", "value", "unit"];
const NUMERIC = new Set(["cases", "deaths", "readmissions_30d", "complications", "los_days_sum", "cost_sum", "value"]);
const EXAMPLE = {
  case_aggregates: "period,department,condition_code,condition_label,management,cases,deaths,readmissions_30d,complications,los_days_sum,cost_sum\n2026-10,cardio,I21,Acute myocardial infarction,Primary PCI,34,2,3,2,140,2890000\n2026-10,cardio,I21,Acute myocardial infarction,Thrombolysis,15,1,2,1,88,450000",
  parameters: "period,department,parameter_code,parameter_label,value,unit\n2026-10,cardio,nurse_to_bed_ratio,Nurse-to-bed ratio,0.9,nurses per bed\n2026-10,cardio,bed_occupancy,Bed occupancy,86.5,%",
};

/** Minimal CSV parser: comma separated, double-quoted fields, header row. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') q = false; else field += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(field); field = ""; if (row.some((x) => x.trim())) rows.push(row); row = []; }
    else field += ch;
  }
  row.push(field); if (row.some((x) => x.trim())) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  const keys = head.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

function toRows(kind: "case_aggregates" | "parameters", csv: string) {
  const cols = kind === "case_aggregates" ? CASE_COLUMNS : PARAM_COLUMNS;
  return parseCsv(csv).map((r) => Object.fromEntries(Object.entries(r).filter(([k, v]) => cols.includes(k) && v !== "")
    .map(([k, v]) => [k, NUMERIC.has(k) ? Number(v) : v])));
}

export function HospitalData({ uploadId }: { uploadId: string | null }) {
  const { api, wp, has, go, actor } = useWs();
  const list = useLoad(() => api.get(`${wp}/uploads`), [wp]);
  const detail = useLoad(() => (uploadId ? api.get(`${wp}/uploads/${uploadId}`) : Promise.resolve(null)), [wp, uploadId]);
  const act = useAction();
  const [kind, setKind] = useState<"case_aggregates" | "parameters">("case_aggregates");
  const [form, setForm] = useState({ label: "", source_method: "", evidence_reference: "", csv: "", attestation: false });
  const [note, setNote] = useState("");
  const rows = form.csv ? toRows(kind, form.csv) : [];
  const canSubmit = has("data_steward", "coordinator");
  const canVerify = has("data_steward", "innovastat_reviewer", "research_director");

  const template = () => {
    const blob = new Blob([EXAMPLE[kind] + "\n"], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `innovahospital-${kind}-template.csv`; a.click();
  };
  const u = detail.data;
  return (
    <div className="ie-stack">
      <Notice>Upload <b>aggregate counts only</b> — patients per condition, management, department and month, with outcomes and costs — or monthly hospital parameters. No patient identifiers. A second person verifies each upload before it is analysed.</Notice>
      {canSubmit && (
        <Panel title={<><Upload size={16} /> New upload</>} actions={<Button variant="outline" size="sm" onClick={template}><Download size={14} /> CSV template</Button>}>
          <form className="ie-form" onSubmit={async (e) => {
            e.preventDefault();
            await act.run(async () => {
              const res = await api.post(`${wp}/uploads`, { kind, label: form.label, source_method: form.source_method, evidence_reference: form.evidence_reference || undefined, attestation: form.attestation, rows });
              setForm({ label: "", source_method: "", evidence_reference: "", csv: "", attestation: false });
              list.reload(); go("data", res.id);
            }, "Upload submitted for verification.");
          }}>
            <div className="ie-form-grid">
              <Field label="Data type"><select className="ie-input" value={kind} onChange={(e) => setKind(e.target.value as any)}>
                <option value="case_aggregates">Cases, outcomes and costs</option><option value="parameters">Hospital parameters</option></select></Field>
              <Field label="Label"><input className="ie-input" required value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Cardiology Oct 2026" /></Field>
              <Field label="Source and method"><input className="ie-input" required value={form.source_method} onChange={(e) => setForm({ ...form, source_method: e.target.value })} placeholder="HIS aggregate export, ICD-10 coded" /></Field>
              <Field label="Evidence reference"><input className="ie-input" value={form.evidence_reference} onChange={(e) => setForm({ ...form, evidence_reference: e.target.value })} /></Field>
              <Field wide label="CSV" hint={`Columns: ${(kind === "case_aggregates" ? CASE_COLUMNS : PARAM_COLUMNS).join(", ")}. Department is the department code. Empty outcome cells mean "not recorded", which differs from zero.`}>
                <textarea className="ie-input mono" rows={6} value={form.csv} onChange={(e) => setForm({ ...form, csv: e.target.value })} placeholder={EXAMPLE[kind]} />
              </Field>
              <Field label="…or a CSV file"><input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setForm({ ...form, csv: await f.text() }); }} /></Field>
            </div>
            <label className="ie-checks"><input type="checkbox" checked={form.attestation} onChange={(e) => setForm({ ...form, attestation: e.target.checked })} /> I attest these are aggregate counts from the approved source, with no patient identifiers.</label>
            <div className="ie-inline"><Button type="submit" disabled={act.busy || !rows.length || !form.attestation}>Submit {rows.length ? `${rows.length} rows` : ""}</Button></div>
            <Feedback error={act.error} message={act.message} />
          </form>
        </Panel>
      )}
      <div className="ie-split">
        <Panel title="Uploads">
          {list.loading ? <Loading /> : !list.data?.items.length ? <Empty>No uploads yet.</Empty> : (
            <table className="ie-table compact"><tbody>{list.data.items.map((x: any) => (
              <tr key={x.id} className="clickable" onClick={() => go("data", x.id)}>
                <td><b>{x.label}</b><div className="muted small">{x.kind === "parameters" ? "Parameters" : "Cases"} · {x.row_count} rows · {x.period_from}–{x.period_to}</div></td>
                <td><Status value={x.status} /></td></tr>))}</tbody></table>)}
        </Panel>
        <Panel title={u ? u.label : "Upload detail"}>
          {!uploadId ? <Empty>Select an upload.</Empty> : detail.loading ? <Loading /> : !u ? null : (
            <>
              <dl className="ie-dl">
                <div><dt>Status</dt><dd><Status value={u.status} /></dd></div><div><dt>Rows</dt><dd>{u.row_count}</dd></div>
                <div><dt>Periods</dt><dd>{u.period_from} to {u.period_to}</dd></div><div><dt>Submitted</dt><dd>{shortSub(u.submitted_by)} · {fmtDateTime(u.created_at)}</dd></div>
                <div><dt>Source</dt><dd>{u.source_method}</dd></div><div><dt>Verified by</dt><dd>{shortSub(u.verified_by)}</dd></div>
                <div><dt>SHA-256</dt><dd className="mono">{u.sha256.slice(0, 16)}…</dd></div>
              </dl>
              {u.review_note && <Notice kind="warning">{u.review_note}</Notice>}
              {u.status === "submitted" && canVerify && u.submitted_by !== actor && (
                <div className="ie-form">
                  <Field label="Review note (required to return)"><input className="ie-input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                  <div className="ie-inline">
                    <Button disabled={act.busy} onClick={() => act.run(async () => { await api.post(`${wp}/uploads/${u.id}/verify`, { decision: "verified", expected_version: u.version, note: note || undefined }); detail.reload(); list.reload(); }, "Verified.")}>Verify</Button>
                    <Button variant="outline" disabled={act.busy || !note} onClick={() => act.run(async () => { await api.post(`${wp}/uploads/${u.id}/verify`, { decision: "returned", expected_version: u.version, note }); detail.reload(); list.reload(); }, "Returned to the submitter.")}>Return</Button>
                  </div>
                </div>)}
              {u.status === "submitted" && u.submitted_by === actor && <Notice>Another person must verify your upload.</Notice>}
              <Feedback error={act.error} message={act.message} />
              <div style={{ overflowX: "auto" }}>
                <table className="ie-table compact"><thead><tr>{Object.keys(u.rows_preview[0] ?? {}).map((k) => <th key={k}>{k.replaceAll("_", " ")}</th>)}</tr></thead>
                  <tbody>{u.rows_preview.slice(0, 60).map((r: any, i: number) => <tr key={i}>{Object.values(r).map((v: any, j) => <td key={j}>{v ?? "—"}</td>)}</tr>)}</tbody></table>
              </div>
              {u.row_count > 60 && <p className="muted small">Showing 60 of {u.row_count} rows.</p>}
            </>)}
        </Panel>
      </div>
    </div>
  );
}
