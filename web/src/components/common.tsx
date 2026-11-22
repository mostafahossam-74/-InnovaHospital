import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, LoaderCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function Panel({ title, eyebrow, actions, children, className = "" }: { title?: ReactNode; eyebrow?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ie-panel ${className}`}>
      {(title || actions) && (
        <div className="panel-head">
          <div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}{title && <h2>{title}</h2>}</div>
          {actions && <div className="ie-actions">{actions}</div>}
        </div>
      )}
      <div className="ie-panel-body">{children}</div>
    </section>
  );
}

export function Notice({ kind = "info", children }: { kind?: "info" | "error" | "success" | "warning"; children: ReactNode }) {
  const Icon = kind === "error" || kind === "warning" ? AlertTriangle : kind === "success" ? CheckCircle2 : Info;
  return <div className={`ie-notice ${kind}`} role={kind === "error" ? "alert" : "status"}><Icon size={16} /><div>{children}</div></div>;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <div className="ie-loading"><LoaderCircle className="spin" size={16} /> {label}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="ie-empty">{children}</div>;
}

export function Feedback({ error, message }: { error?: string | null; message?: string | null }) {
  return <>{error && <Notice kind="error">{error}</Notice>}{message && <Notice kind="success">{message}</Notice>}</>;
}

const TONE: Record<string, string> = {
  submitted: "info", verified: "good", returned: "warn", withdrawn: "neutral",
  proposed: "info", confirmed: "good", rejected: "bad", deferred: "warn",
  draft: "neutral", feasibility: "info", accepted: "good", converted: "good",
  governance: "info", active: "good", on_hold: "warn", complete: "good", archived: "neutral",
  approved: "good", denied: "bad", determination: "good", revoked: "bad",
  planned: "neutral", in_progress: "info", blocked: "bad", done: "good", cancelled: "neutral", qc: "info", published: "good", released: "good",
  superseded: "neutral", missing: "bad", unverified: "warn", not_applicable: "neutral", suppressed: "neutral",
  dominant: "good", dominated: "bad", more_costly_more_effective: "info", less_costly_less_effective: "warn",
  locked: "good", pending_review: "info", significant: "good", not_significant: "warn", hospital_approved: "good", hospital_returned: "warn", hospital_accepted: "good", sent: "info", uploaded: "neutral", dictionary: "info", cleaning: "info", hypotheses: "info", analysis: "info", received: "info",
  lead: "neutral", qualified: "info", proposal: "info", contracting: "info", signed: "good", closed: "neutral", lost: "bad",
};
export function Status({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="muted">—</span>;
  return <span className={`ie-status ${TONE[value] ?? "neutral"}`}>{value.replaceAll("_", " ")}</span>;
}

export function Field({ label, hint, children, wide = false }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return <label className={`ie-field ${wide ? "wide" : ""}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Metric({ label, value, sub, tone = "teal", icon: Icon }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string; icon: any }) {
  return <article className="metric-card"><div className={`metric-icon ${tone}`}><Icon size={18} /></div><div><p>{label}</p><strong>{value}</strong>{sub && <span>{sub}</span>}</div></article>;
}

export function Tags({ items }: { items: string[] }) {
  return <span className="ie-tags">{items.map((t) => <Badge key={t} variant="outline">{t}</Badge>)}</span>;
}

export const fmtDate = (v: string | null | undefined) => (v ? new Date(v).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");
export const fmtDateTime = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
export const fmtPeriod = (p: string) => new Date(`${p}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
export const shortSub = (actor: string | null | undefined) => (actor ? actor.slice(actor.lastIndexOf("|") + 1) : "—");
export const newKey = () => crypto.randomUUID();

export const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(d)}%`);
export const num = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
export const label = (v: string | null | undefined) => (v ? v.replaceAll("_", " ") : "—");

/** Horizontal share bar with the value written next to it (no colour-only meaning). */
export function Bar({ value, max = 1, text }: { value: number; max?: number; text?: string }) {
  const w = Math.max(0, Math.min(100, (100 * value) / (max || 1)));
  return <span className="ih-bar"><span className="ih-bar-track"><span className="ih-bar-fill" style={{ width: `${w}%` }} /></span><span className="ih-bar-text">{text ?? pct(value)}</span></span>;
}

const MEASURE: Record<string, string> = { adjusted_odds_ratio: "adjusted odds ratio", odds_ratio_iptw: "propensity-weighted odds ratio", adjusted_mean_difference: "adjusted mean difference", ratio_of_geometric_means: "ratio of geometric means", adjusted_hazard_ratio: "adjusted hazard ratio" };
export const measure = (m: string) => MEASURE[m] ?? label(m);
