import pg from "pg";
import { createHash } from "node:crypto";

export type Client = pg.PoolClient;
export type Pool = pg.Pool;

// Return DATE columns as ISO strings, never as local-midnight Date objects.
pg.types.setTypeParser(1082, (v: string) => v);

export function createPool(connectionString: string, max = 10): Pool {
  return new pg.Pool({ connectionString, max });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: string): boolean => UUID_RE.test(v);

/**
 * Runs `fn` in one transaction scoped to a workspace. Row-level security uses
 * app.workspace_id, which set_config(..., true) limits to this transaction.
 * Call only after the service has verified the caller's membership.
 * An error rolls the transaction back, except one marked `commit: true`: its writes
 * are committed and the error is still thrown (used to record a hold, then refuse).
 */
export async function withTenant<T>(pool: Pool, workspaceId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  if (!isUuid(workspaceId)) throw new Error("withTenant requires a workspace UUID");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    const keep = (err as { commit?: unknown } | null)?.commit === true;
    await client.query(keep ? "COMMIT" : "ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Canonical JSON: sorted keys, no whitespace. Used for every stored digest. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export const sha256 = (value: unknown): string =>
  createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");

export async function audit(
  c: Client, workspaceId: string, actor: string, action: string, entityType: string, entityId: string,
  details: Record<string, unknown> = {}, correlationId?: string, reason?: string,
): Promise<void> {
  await c.query(
    `INSERT INTO audit_event (workspace_id, actor, action, entity_type, entity_id, details, correlation_id, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [workspaceId, actor, action, entityType, entityId, details, correlationId ?? null, reason ?? null],
  );
}
