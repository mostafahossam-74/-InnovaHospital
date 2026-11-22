import { createRemoteJWKSet, createLocalJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey, JSONWebKeySet } from "jose";
import type { Pool } from "./db.ts";
import { ApiError } from "./http.ts";

export type Identity = {
  issuer: string; subject: string; email: string | null; name: string | null;
  /** Built-in accounts only: the password version the session was issued for. */
  passwordVersion?: number;
};
export const actorId = (id: Identity): string => `${id.issuer}|${id.subject}`;

export type Role = "hospital_admin" | "research_director" | "department_lead" | "investigator" | "coordinator"
  | "governance_recorder" | "data_steward" | "innovastat_reviewer" | "executive_reader";
export const ROLES: Role[] = ["hospital_admin", "research_director", "department_lead", "investigator", "coordinator",
  "governance_recorder", "data_steward", "innovastat_reviewer", "executive_reader"];
/** Everyone who works in the research office (all roles except the executive reader). */
export const STAFF: Role[] = ROLES.filter((r) => r !== "executive_reader");

export type AuthConfig = {
  issuer: string; audience: string;
  keys: JWTVerifyGetKey | Uint8Array;
  algorithms?: string[];
  /** Set for built-in accounts (AUTH_MODE=local): the API issues and checks its own sessions. */
  local?: { secret: Uint8Array };
  /** Extra check after the token verifies (built-in accounts: account state). */
  verify?: (id: Identity, opts: { allowPasswordChange: boolean }) => Promise<void>;
};

/** Production: discover the JWKS from the OIDC issuer. */
export async function discoverAuth(issuer: string, audience: string): Promise<AuthConfig> {
  const res = await fetch(new URL(".well-known/openid-configuration", issuer.endsWith("/") ? issuer : issuer + "/"));
  if (!res.ok) throw new Error(`OIDC discovery failed with HTTP ${res.status}`);
  const meta = (await res.json()) as { issuer: string; jwks_uri: string };
  if (meta.issuer !== issuer) throw new Error("OIDC discovery issuer mismatch");
  return { issuer, audience, keys: createRemoteJWKSet(new URL(meta.jwks_uri)) };
}

/** Local development and tests only: a static JWKS. Refused in production. */
export function localAuth(issuer: string, audience: string, jwks: JSONWebKeySet): AuthConfig {
  if (process.env.NODE_ENV === "production") throw new Error("Local JWKS is not allowed in production");
  return { issuer, audience, keys: createLocalJWKSet(jwks) };
}

export async function authenticate(cfg: AuthConfig, header: string | undefined, opts = { allowPasswordChange: false }): Promise<Identity> {
  const id = await verifyToken(cfg, header);
  if (cfg.verify) await cfg.verify(id, opts);
  return id;
}

async function verifyToken(cfg: AuthConfig, header: string | undefined): Promise<Identity> {
  const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header ?? "");
  if (!m) throw new ApiError(401, "unauthenticated", "Bearer token required");
  try {
    const opts = { issuer: cfg.issuer, audience: cfg.audience, algorithms: cfg.algorithms ?? ["RS256", "ES256", "PS256", "EdDSA"], clockTolerance: 30 };
    const { payload } = cfg.keys instanceof Uint8Array ? await jwtVerify(m[1], cfg.keys, opts) : await jwtVerify(m[1], cfg.keys, opts);
    if (!payload.sub || !payload.iss) throw new Error("missing sub");
    return {
      issuer: payload.iss, subject: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
      name: typeof payload.name === "string" ? payload.name : null,
      ...(cfg.local ? { passwordVersion: typeof payload.pv === "number" ? payload.pv : -1 } : {}),
    };
  } catch {
    throw new ApiError(401, "invalid_token", "Token is invalid or expired");
  }
}

/** One role grant; departmentId null means every department. */
export type Grant = { role: Role; departmentId: string | null };
export type WorkspaceAccess = { workspaceId: string; grants: Grant[]; roles: Set<Role> };

/** Grants are resolved server-side on every request (Handoff §3). */
export async function memberships(pool: Pool, id: Identity): Promise<Map<string, Grant[]>> {
  const { rows } = await pool.query<{ workspace_id: string; role: Role; department_id: string | null }>(
    "SELECT workspace_id, role, department_id FROM auth_memberships($1, $2)", [id.issuer, id.subject]);
  const out = new Map<string, Grant[]>();
  for (const r of rows) {
    if (!out.has(r.workspace_id)) out.set(r.workspace_id, []);
    out.get(r.workspace_id)!.push({ role: r.role, departmentId: r.department_id });
  }
  return out;
}

export async function isPlatformAdmin(pool: Pool, id: Identity): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>("SELECT auth_is_platform_admin($1,$2) AS ok", [id.issuer, id.subject]);
  return rows[0]?.ok === true;
}

/**
 * Resolves access to one workspace. A non-member gets 404 so workspace
 * existence is not disclosed; a member without the needed role gets 403.
 */
export async function requireWorkspace(pool: Pool, id: Identity, workspaceId: string, allowed: Role[]): Promise<WorkspaceAccess> {
  const grants = (await memberships(pool, id)).get(workspaceId);
  if (!grants?.length) throw new ApiError(404, "not_found", "Workspace not found");
  const roles = new Set(grants.map((g) => g.role));
  if (!allowed.some((r) => roles.has(r))) throw new ApiError(403, "forbidden", "Your role does not permit this operation");
  return { workspaceId, grants, roles };
}

/** True when one of `roles` is granted for this department (or for all departments). */
export function can(access: WorkspaceAccess, roles: Role[], departmentId: string | null): boolean {
  return access.grants.some((g) => roles.includes(g.role) && (g.departmentId === null || g.departmentId === departmentId));
}

/** Departments visible through `roles`: null = all; otherwise the granted IDs. */
export function departmentScope(access: WorkspaceAccess, roles: Role[] = ROLES): string[] | null {
  const gs = access.grants.filter((g) => roles.includes(g.role));
  if (gs.some((g) => g.departmentId === null)) return null;
  return [...new Set(gs.map((g) => g.departmentId!))];
}
