// Shared pieces for the route modules.
import { z } from "zod";
import type { Client, Pool } from "./db.ts";
import { isUuid, withTenant } from "./db.ts";
import { ApiError } from "./http.ts";
import type { Ctx, Router } from "./http.ts";
import { authenticate, requireWorkspace } from "./auth.ts";
import type { AuthConfig, Identity, Role, WorkspaceAccess } from "./auth.ts";

export const text = (max: number) => z.string().trim().min(1).max(max);
export const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM");
export const version = z.number().int().positive();
export const uuid = z.string().uuid();

export const W = "/v1/workspaces/{workspaceId}";

export function wsParam(ctx: Ctx): string {
  const id = ctx.params.workspaceId;
  if (!isUuid(id)) throw new ApiError(404, "not_found", "Workspace not found");
  return id;
}
export function idParam(ctx: Ctx, name = "id"): string {
  const id = ctx.params[name];
  if (!isUuid(id)) throw new ApiError(404, "not_found", "Resource not found");
  return id;
}

export type Scoped = <T>(ctx: Ctx, roles: Role[], fn: (c: Client, me: Identity, wsId: string, access: WorkspaceAccess) => Promise<T>) => Promise<T>;
export type RouteDeps = { r: Router; pool: Pool; scoped: Scoped; identify: (ctx: Ctx) => Promise<Identity> };

export function makeScoped(pool: Pool, auth: AuthConfig): { scoped: Scoped; identify: (ctx: Ctx) => Promise<Identity> } {
  const identify = (ctx: Ctx) => authenticate(auth, ctx.req.headers.authorization);
  const scoped: Scoped = async (ctx, roles, fn) => {
    const me = await identify(ctx);
    const wsId = wsParam(ctx);
    const access = await requireWorkspace(pool, me, wsId, roles);
    return withTenant(pool, wsId, (c) => fn(c, me, wsId, access));
  };
  return { scoped, identify };
}

/**
 * Runs a create/release action once per Idempotency-Key: a retry with the
 * same key returns the stored response instead of acting again.
 */
export async function idempotent<T>(c: Client, ctx: Ctx, wsId: string, scope: string, fn: () => Promise<{ status?: number; body: T }>) {
  const key = ctx.req.headers["idempotency-key"];
  if (typeof key !== "string" || key.length < 8 || key.length > 200) throw new ApiError(422, "idempotency_key_required", "Send an Idempotency-Key header (8-200 characters)");
  const prior = await c.query("SELECT response FROM idempotency_key WHERE workspace_id = $1 AND scope = $2 AND key = $3", [wsId, scope, key]);
  if (prior.rowCount) return prior.rows[0].response as { status?: number; body: T };
  const res = await fn();
  await c.query("INSERT INTO idempotency_key (workspace_id, scope, key, response) VALUES ($1,$2,$3,$4)", [wsId, scope, key, res]);
  return res;
}

export const conflict = (what = "record") => new ApiError(409, "version_conflict", `The ${what} was changed by someone else; reload and retry`);
export const notFound = (what = "Resource") => new ApiError(404, "not_found", `${what} not found`);
export const forbidden = (msg = "Your role does not permit this operation") => new ApiError(403, "forbidden", msg);
