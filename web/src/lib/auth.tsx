import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { UserManager, WebStorageStateStore } from "oidc-client-ts";
import { config } from "@/config";

type Session = { token: string; subject: string; name: string; expiresAt: number; mustChangePassword?: boolean };
type AuthState = {
  session: Session | null;
  ready: boolean;
  error: string | null;
  signIn: (devSubject?: string) => Promise<void>;
  /** Built-in accounts (VITE_AUTH_MODE=local). */
  signInWithPassword: (email: string, password: string) => Promise<void>;
  changePassword: (current: string, next: string) => Promise<void>;
  signOut: () => Promise<void>;
  getToken: () => Promise<string | null>;
};

const AuthContext = createContext<AuthState | null>(null);
const DEV_KEY = "ih.dev.session";
const LOCAL_KEY = "ih.local.session";

type LoginReply = { token: string; expires_at: string; must_change_password: boolean };
function localSession(r: LoginReply): Session {
  const c = decode(r.token);
  return { token: r.token, subject: c.sub, name: c.name ?? c.email ?? c.sub, expiresAt: Date.parse(r.expires_at), mustChangePassword: r.must_change_password };
}
async function postJson(path: string, body: unknown, token?: string): Promise<LoginReply> {
  const res = await fetch(config.apiBase + path, {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
  return data as LoginReply;
}

function decode(token: string): { sub: string; name?: string; email?: string; exp: number } {
  const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(decodeURIComponent(escape(atob(payload))));
}

let manager: UserManager | null = null;
function oidcManager(): UserManager {
  if (manager) return manager;
  if (!config.oidc.authority || !config.oidc.clientId) throw new Error("OIDC is not configured (VITE_OIDC_AUTHORITY, VITE_OIDC_CLIENT_ID)");
  manager = new UserManager({
    authority: config.oidc.authority,
    client_id: config.oidc.clientId,
    redirect_uri: `${window.location.origin}/auth/callback`,
    post_logout_redirect_uri: window.location.origin,
    response_type: "code",
    scope: config.oidc.scope,
    // Tokens live in sessionStorage: cleared when the tab closes.
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    automaticSilentRenew: true,
    extraQueryParams: config.oidc.audience ? { audience: config.oidc.audience } : undefined,
  });
  return manager;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        if (config.authMode === "dev" || config.authMode === "local") {
          const raw = sessionStorage.getItem(config.authMode === "dev" ? DEV_KEY : LOCAL_KEY);
          const s = raw ? (JSON.parse(raw) as Session) : null;
          setSession(s && s.expiresAt > Date.now() ? s : null);
          return;
        }
        const um = oidcManager();
        if (window.location.pathname === "/auth/callback") {
          await um.signinRedirectCallback();
          window.history.replaceState(null, "", "/" + (sessionStorage.getItem("ih.returnHash") ?? ""));
        }
        const user = await um.getUser();
        if (user && !user.expired && user.access_token) {
          const claims = decode(user.access_token);
          setSession({ token: user.access_token, subject: claims.sub, name: user.profile.name ?? user.profile.email ?? claims.sub, expiresAt: claims.exp * 1000 });
        }
        um.events.addUserLoaded((u) => {
          const c = decode(u.access_token);
          setSession({ token: u.access_token, subject: c.sub, name: u.profile.name ?? u.profile.email ?? c.sub, expiresAt: c.exp * 1000 });
        });
        um.events.addUserSignedOut(() => setSession(null));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Sign-in failed");
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const signIn = useCallback(async (devSubject?: string) => {
    setError(null);
    if (config.authMode === "dev") {
      const res = await fetch(`/__dev/token?sub=${encodeURIComponent(devSubject ?? "")}`);
      if (!res.ok) { setError("Dev sign-in is unavailable. In the backend, run `node scripts/dev-token.ts platform-admin` once to create the dev key."); return; }
      const { token } = await res.json();
      const c = decode(token);
      const s = { token, subject: c.sub, name: c.name ?? c.sub, expiresAt: c.exp * 1000 };
      sessionStorage.setItem(DEV_KEY, JSON.stringify(s));
      setSession(s);
      return;
    }
    sessionStorage.setItem("ih.returnHash", window.location.hash);
    await oidcManager().signinRedirect();
  }, []);

  const signInWithPassword = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      const s = localSession(await postJson("/v1/auth/login", { email, password }));
      sessionStorage.setItem(LOCAL_KEY, JSON.stringify(s));
      setSession(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed");
    }
  }, []);

  /** Throws with the server's message, for the form to show; ends with a fresh session. */
  const changePassword = useCallback(async (current: string, next: string) => {
    if (!session) throw new Error("Not signed in");
    const s = localSession(await postJson("/v1/auth/password", { current_password: current, new_password: next }, session.token));
    sessionStorage.setItem(LOCAL_KEY, JSON.stringify(s));
    setSession(s);
  }, [session]);

  const signOut = useCallback(async () => {
    setSession(null);
    if (config.authMode === "dev") { sessionStorage.removeItem(DEV_KEY); return; }
    if (config.authMode === "local") { sessionStorage.removeItem(LOCAL_KEY); return; }
    await oidcManager().signoutRedirect();
  }, []);

  const getToken = useCallback(async () => {
    if (!session) return null;
    if (config.authMode === "local" && session.expiresAt < Date.now()) { setSession(null); sessionStorage.removeItem(LOCAL_KEY); return null; }
    if (config.authMode === "oidc" && session.expiresAt - Date.now() < 30_000) {
      const u = await oidcManager().signinSilent().catch(() => null);
      return u?.access_token ?? null;
    }
    return session.token;
  }, [session]);

  const value = useMemo(() => ({ session, ready, error, signIn, signInWithPassword, changePassword, signOut, getToken }),
    [session, ready, error, signIn, signInWithPassword, changePassword, signOut, getToken]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
