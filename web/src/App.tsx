import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Activity, BarChart3, Building2, Database, FileText, FlaskConical, GraduationCap, Languages, LayoutDashboard,
  Lightbulb, LockKeyhole, LogOut, Microscope, Send, ShieldCheck, Target, Users, Wrench, Inbox,
} from "lucide-react";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger,
} from "@/components/ui/sidebar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { createApi, describeError } from "@/lib/api";
import { config } from "@/config";
import { ROLE_LABEL, WorkspaceContext, type Ctx, type Department, type Me, type Role, type Settings } from "@/app/context";
import { Loading, Notice } from "@/components/common";
import { Dashboard } from "@/views/Dashboard";
import { HospitalData } from "@/views/HospitalData";
import { Analysis } from "@/views/Analysis";
import { Gaps } from "@/views/Gaps";
import { Ideas } from "@/views/Ideas";
import { Projects } from "@/views/Projects";
import { Indicators } from "@/views/Indicators";
import { Reports } from "@/views/Reports";
import { Office } from "@/views/Office";
import { WorkspaceSettings } from "@/views/WorkspaceSettings";
import { Platform } from "@/views/Platform";
import { Workbench } from "@/views/Workbench";
import { Deliverables } from "@/views/Deliverables";
import { HospitalResearch } from "@/views/HospitalResearch";

const DEMO_USERS = ["analyst", "statistician", "statistician2", "director", "coordinator", "steward", "pi", "governance", "admin", "exec", "platform-admin"];
const STAFF: Role[] = ["hospital_admin", "research_director", "department_lead", "investigator", "coordinator", "governance_recorder", "data_steward", "innovastat_reviewer", "innovastat_analyst"];
const INTERNAL: Role[] = ["innovastat_analyst", "innovastat_reviewer"];

type NavItem = { id: string; label: string; ar: string; icon: any; title: string; subtitle: string; show: (c: Ctx) => boolean };
const NAV: NavItem[] = [
  { id: "dashboard", label: "Overview", ar: "نظرة عامة", icon: LayoutDashboard, title: "Overview", subtitle: "Research output and what needs attention.", show: () => true },
  { id: "workbench", label: "Study workbench", ar: "منصة التحليل", icon: Microscope, title: "Study workbench (InnovaStat)", subtitle: "Patient-level data: dictionary, cleaning, hypotheses, locked plans and validated results, each confirmed by a statistician.", show: (c) => c.internal },
  { id: "deliverables", label: "Ideas, reports & manuscripts", ar: "التقارير", icon: Send, title: "Deliverables (InnovaStat)", subtitle: "Research ideas, Gaps & Ideas reports, results reports and manuscripts for the hospital.", show: (c) => c.internal },
  { id: "analysis", label: "Aggregate analytics", ar: "تحليلات النتائج", icon: BarChart3, title: "Aggregate outcomes analytics (InnovaStat)", subtitle: "Monthly totals: disease burden, management and outcomes, health economics, hospital parameters.", show: (c) => c.internal },
  { id: "gaps", label: "Aggregate gaps", ar: "الفجوات البحثية", icon: Target, title: "Research gaps from aggregate data (InnovaStat)", subtitle: "Signals from monthly totals, confirmed by a statistician.", show: (c) => c.internal },
  { id: "research", label: "Research with InnovaStat", ar: "البحث مع InnovaStat", icon: Inbox, title: "Research with InnovaStat", subtitle: "Send study data, read InnovaStat's reports, approve suggested studies and results, receive manuscripts.", show: (c) => !c.internal },
  { id: "data", label: "Monthly totals", ar: "بيانات المستشفى", icon: Database, title: "Monthly aggregate data", subtitle: "Monthly totals of cases, outcomes, costs and hospital parameters.", show: (c) => c.internal || c.has("data_steward", "coordinator") },
  { id: "ideas", label: "Ideas & intake", ar: "الأفكار البحثية", icon: Lightbulb, title: "Research ideas", subtitle: "Proposals from clinicians: triage, feasibility and conversion.", show: (c) => c.staff },
  { id: "projects", label: "Studies", ar: "المشاريع", icon: FlaskConical, title: "Ongoing studies", subtitle: "Studies from approval to publication, gated by ethics and data approvals.", show: (c) => c.staff },
  { id: "indicators", label: "Quality indicators", ar: "مؤشرات الجودة", icon: Activity, title: "Quality indicators", subtitle: "Versioned definitions, monthly values and independent verification.", show: (c) => c.staff },
  { id: "office", label: "Training & partners", ar: "التدريب والشراكات", icon: GraduationCap, title: "Training, outputs and partnerships", subtitle: "Research capacity, publications and the funding pipeline.", show: (c) => c.staff },
  { id: "reports", label: "Monthly reports", ar: "التقارير الشهرية", icon: FileText, title: "Monthly executive reports", subtitle: "Drafted by the coordinator, reviewed, released by the research director.", show: () => true },
  { id: "settings", label: "Settings & access", ar: "الإعدادات", icon: Wrench, title: "Settings and access", subtitle: "Departments, role grants and reporting policy.", show: (c) => c.has("hospital_admin") },
];


function parseHash(): { ws: string | null; view: string; param: string | null } {
  const parts = window.location.hash.replace(/^#\/?/, "").split("/");
  if (parts[0] === "platform") return { ws: null, view: "platform", param: null };
  if (parts[0] === "account") return { ws: null, view: "account", param: null };
  if (parts[0] === "w" && parts[1]) return { ws: parts[1], view: parts[2] || "dashboard", param: parts[3] ? decodeURIComponent(parts[3]) : null };
  return { ws: null, view: "dashboard", param: null };
}

function SignIn() {
  const { signIn, signInWithPassword, error } = useAuth();
  const [subject, setSubject] = useState("analyst");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="ie-signin">
      <div className="ie-signin-card">
        <div className="brand-mark">IH</div>
        <h1>InnovaHospital</h1>
        <p>Hospital research office and outcomes intelligence by InnovaStat CRO.</p>
        {config.authMode === "dev" ? (
          <>
            <Notice kind="warning">Local development sign-in. This option does not exist in deployed builds.</Notice>
            <label className="ie-field"><span>Sign in as (subject)</span>
              <input className="ie-input" list="demo-users" value={subject} onChange={(e) => setSubject(e.target.value)} />
              <datalist id="demo-users">{DEMO_USERS.map((u) => <option key={u} value={u} />)}</datalist>
              <small>Demo users: {DEMO_USERS.join(", ")}</small>
            </label>
            <Button className="w-full" onClick={() => signIn(subject)}>Sign in</Button>
          </>
        ) : config.authMode === "local" ? (
          <form className="ie-stack" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await signInWithPassword(email, password); setBusy(false); }}>
            <label className="ie-field"><span>Email</span>
              <input className="ie-input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="ie-field"><span>Password</span>
              <input className="ie-input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <Button className="w-full" type="submit" disabled={busy}><LockKeyhole size={16} /> {busy ? "Signing in…" : "Sign in"}</Button>
            <p className="muted small">Forgot your password? Ask your InnovaStat administrator to reset it.</p>
          </form>
        ) : (
          <Button className="w-full" onClick={() => signIn()}><LockKeyhole size={16} /> Sign in with your organization</Button>
        )}
        {error && <Notice kind="error">{error}</Notice>}
      </div>
    </div>
  );
}

/** Built-in accounts: choose a new password (required after a temporary one). */
function ChangePassword({ required, onDone }: { required: boolean; onDone?: () => void }) {
  const { changePassword, signOut } = useAuth();
  const [f, setF] = useState({ current: "", next: "", again: "" });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (f.next !== f.again) { setError("The two new passwords do not match."); return; }
    setBusy(true);
    try { await changePassword(f.current, f.next); setDone(true); setF({ current: "", next: "", again: "" }); onDone?.(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not change the password"); }
    finally { setBusy(false); }
  };
  return (
    <form className="ie-stack" onSubmit={submit}>
      {required && <Notice kind="warning">You signed in with a temporary password. Choose your own password to continue.</Notice>}
      <label className="ie-field"><span>{required ? "Temporary password" : "Current password"}</span>
        <input className="ie-input" type="password" autoComplete="current-password" required value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} />
      </label>
      <label className="ie-field"><span>New password</span>
        <input className="ie-input" type="password" autoComplete="new-password" required minLength={12} value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />
      </label>
      <label className="ie-field"><span>New password again</span>
        <input className="ie-input" type="password" autoComplete="new-password" required minLength={12} value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} />
      </label>
      <p className="muted small">At least 12 characters. A few unrelated words with a number work well.</p>
      <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Change password"}</Button>
      {required && <Button type="button" variant="outline" onClick={() => signOut()}>Sign out</Button>}
      {error && <Notice kind="error">{error}</Notice>}
      {done && !required && <Notice kind="success">Password changed. Other sessions of this account have been signed out.</Notice>}
    </form>
  );
}

export default function App() {
  const { session, ready, signOut, getToken } = useAuth();
  const [route, setRoute] = useState(parseHash);
  const [me, setMe] = useState<Me | null>(null);
  const [ws, setWs] = useState<Settings | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [wsNonce, setWsNonce] = useState(0);
  const [rtl, setRtl] = useState(() => localStorage.getItem("ih.rtl") === "1");

  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    document.documentElement.dir = rtl ? "rtl" : "ltr";
    document.documentElement.lang = rtl ? "ar" : "en";
    try { localStorage.setItem("ih.rtl", rtl ? "1" : "0"); } catch { /* storage unavailable */ }
  }, [rtl]);

  const api = useMemo(() => createApi(getToken, () => { void signOut(); }), [getToken, signOut]);

  useEffect(() => {
    if (!session || session.mustChangePassword) return;
    setError(null);
    api.get<Me>("/v1/me").then(setMe).catch((e) => setError(describeError(e)));
  }, [session, api]);

  useEffect(() => {
    if (!me || route.ws || route.view === "platform" || route.view === "account") return;
    const remembered = localStorage.getItem("ih.workspace");
    const pick = me.workspaces.find((w) => w.id === remembered) ?? me.workspaces[0];
    if (pick) window.location.hash = `#/w/${pick.id}/dashboard`;
    else if (me.platform_admin) window.location.hash = "#/platform";
  }, [me, route.ws, route.view]);

  useEffect(() => {
    if (!route.ws || !me) return;
    if (!me.workspaces.some((w) => w.id === route.ws)) { setWs(null); return; }
    localStorage.setItem("ih.workspace", route.ws);
    Promise.all([api.get<Settings>(`/v1/workspaces/${route.ws}/settings`), api.get<{ items: Department[] }>(`/v1/workspaces/${route.ws}/departments`)])
      .then(([s, d]) => { setWs(s); setDepartments(d.items); }).catch((e) => setError(describeError(e)));
  }, [route.ws, me, api, wsNonce]);

  const go = useCallback((view: string, param?: string) => {
    if (!route.ws) return;
    window.location.hash = `#/w/${route.ws}/${view}${param ? `/${encodeURIComponent(param)}` : ""}`;
  }, [route.ws]);

  if (!ready) return <div className="ie-signin"><Loading /></div>;
  if (!session) return <SignIn />;
  if (session.mustChangePassword) {
    return <div className="ie-signin"><div className="ie-signin-card"><div className="brand-mark">IH</div><h1>Choose your password</h1><ChangePassword required /></div></div>;
  }
  if (error && !me) return <div className="ie-signin"><div className="ie-signin-card"><Notice kind="error">{error}</Notice><Button onClick={() => signOut()}>Sign out</Button></div></div>;
  if (!me) return <div className="ie-signin"><Loading label="Loading your hospitals…" /></div>;

  const membership = me.workspaces.find((w) => w.id === route.ws);
  const roles = new Set<Role>(membership?.roles ?? []);
  const grants = membership?.grants ?? [];
  const ctx: Ctx | null = ws && membership && ws.id === membership.id ? {
    api, me, ws, wp: `/v1/workspaces/${ws.id}`, actor: `${me.issuer}|${me.subject}`, roles, grants, departments,
    staff: STAFF.some((r) => roles.has(r)),
    internal: INTERNAL.some((r) => roles.has(r)),
    has: (...rs) => rs.some((r) => roles.has(r)),
    deptsFor: (...rs) => {
      const gs = grants.filter((g) => rs.includes(g.role));
      return gs.some((g) => g.department_id === null) ? departments : departments.filter((d) => gs.some((g) => g.department_id === d.id));
    },
    go, refreshWorkspace: () => setWsNonce((n) => n + 1),
  } : null;

  const nav = ctx ? NAV.filter((n) => n.show(ctx)) : [];
  const current = route.view === "account" ? { title: "Your account", subtitle: "Change your password." }
    : route.view === "platform" ? { title: "Platform administration", subtitle: "Hospitals, departments and first role grants (identifiers only)." }
    : NAV.find((n) => n.id === route.view && ctx && n.show(ctx)) ?? NAV[0];
  const noAccess = !me.workspaces.length && !me.platform_admin;

  return (
    <SidebarProvider>
      <Sidebar collapsible="offcanvas" className="brand-sidebar" side={rtl ? "right" : "left"}>
        <SidebarHeader className="brand-head"><div className="brand-mark">IH</div><div><strong>InnovaHospital</strong><span>by InnovaStat CRO</span></div></SidebarHeader>
        <SidebarContent>
          {ctx && (
            <SidebarGroup>
              <SidebarGroupLabel>{rtl ? "المستشفى" : "Hospital"}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {nav.map((item) => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton isActive={route.view === item.id} onClick={() => go(item.id)}><item.icon /><span>{rtl ? item.ar : item.label}</span></SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
          {me.platform_admin && (
            <SidebarGroup>
              <SidebarGroupLabel>InnovaStat</SidebarGroupLabel>
              <SidebarGroupContent><SidebarMenu>
                <SidebarMenuItem><SidebarMenuButton isActive={route.view === "platform"} onClick={() => { window.location.hash = "#/platform"; }}><ShieldCheck /><span>Platform administration</span></SidebarMenuButton></SidebarMenuItem>
              </SidebarMenu></SidebarGroupContent>
            </SidebarGroup>
          )}
        </SidebarContent>
        <SidebarFooter>
          <div className="expert-card"><div><Users size={16} /><b>{membership ? membership.roles.map((r) => ROLE_LABEL[r]).join(", ") : me.platform_admin ? "Platform admin" : "No hospital"}</b></div><p>Access is checked on every request, per department.</p></div>
          <button className="account" onClick={() => signOut()} title="Sign out">
            <div className="avatar small">{(session.name || session.subject).slice(0, 2).toUpperCase()}</div>
            <span><b>{session.name || session.subject}</b><small>Sign out</small></span><LogOut size={16} />
          </button>
          {config.authMode === "local" && <a className="ie-link small" style={{ padding: "0 8px" }} href="#/account">Change password</a>}
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="app-shell">
        <header className="topbar">
          <div className="top-title"><SidebarTrigger /><div><h1>{current.title}</h1><p>{current.subtitle}</p></div></div>
          <Button variant="outline" size="sm" onClick={() => setRtl(!rtl)} aria-label="Switch layout direction"><Languages size={15} /> {rtl ? "English" : "العربية"}</Button>
        </header>
        {me.workspaces.length > 0 && route.view !== "platform" && (
          <div className="company-bar">
            <div>
              <span>Hospital</span>
              <Select value={route.ws ?? undefined} onValueChange={(id) => { window.location.hash = `#/w/${id}/dashboard`; }}>
                <SelectTrigger className="company-select" aria-label="Hospital"><Building2 /><SelectValue placeholder="Choose a hospital" /></SelectTrigger>
                <SelectContent>{me.workspaces.map((w) => <SelectItem value={w.id} key={w.id}>{w.name}</SelectItem>)}</SelectContent>
              </Select>
              <span className="segregated"><LockKeyhole /> Isolated workspace</span>
            </div>
            {ws && <div><Badge variant="outline">{ws.country}</Badge><span>{ws.currency} · {ws.timezone}</span></div>}
          </div>
        )}
        <main className="content-area">
          {error && <Notice kind="error">{error}</Notice>}
          {noAccess && <Notice kind="warning">Your account has no hospital yet. Ask InnovaStat to grant access, quoting your account ID: <code className="mono">{me.issuer} | {me.subject}</code></Notice>}
          {route.view === "account" ? <div style={{ maxWidth: 420 }}><ChangePassword required={false} /></div>
            : route.view === "platform" ? (me.platform_admin ? <Platform api={api} /> : <Notice kind="error">Platform admin access is required.</Notice>)
            : route.ws && !membership ? <Notice kind="error">Hospital not found or you no longer have access.</Notice>
            : ctx ? (
              <WorkspaceContext.Provider value={ctx}>
                {route.view === "dashboard" && <Dashboard />}
                {route.view === "workbench" && ctx.internal && <Workbench datasetId={route.param} />}
                {route.view === "deliverables" && ctx.internal && <Deliverables />}
                {route.view === "research" && !ctx.internal && <HospitalResearch reportId={route.param} />}
                {route.view === "data" && (ctx.internal || ctx.has("data_steward", "coordinator")) && <HospitalData uploadId={route.param} />}
                {route.view === "analysis" && ctx.internal && <Analysis analysisId={route.param} />}
                {route.view === "gaps" && ctx.internal && <Gaps gapId={route.param} />}
                {route.view === "ideas" && ctx.staff && <Ideas ideaId={route.param} />}
                {route.view === "projects" && ctx.staff && <Projects projectId={route.param} />}
                {route.view === "indicators" && ctx.staff && <Indicators />}
                {route.view === "office" && ctx.staff && <Office />}
                {route.view === "reports" && <Reports reportId={route.param} />}
                {route.view === "settings" && ctx.has("hospital_admin") && <WorkspaceSettings />}
              </WorkspaceContext.Provider>
            ) : route.ws ? <Loading /> : null}
        </main>
        <div className="production-note"><ShieldCheck size={14} /> Identifiers removed on upload · every analysis step confirmed by a statistician · the hospital sees results only when released</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
