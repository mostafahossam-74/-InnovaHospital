import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createPool } from "../src/db.ts";
import { buildRouter } from "../src/api.ts";
import { localAuth } from "../src/auth.ts";
import { LocalObjectStore } from "../src/storage.ts";
import type { IdeaDrafter } from "../src/analytics/ideas.ts";
import type { StudyAgent } from "../src/studies/agent.ts";

export const ISSUER = "https://idp.test.invalid/";
const ROOT = new URL("..", import.meta.url).pathname;

/** Fresh database per test file, migrated with the real migrations. */
export function freshDatabase(name: string) {
  execFileSync("bash", [`${ROOT}scripts/db-setup.sh`, name], { stdio: "ignore" });
  const ownerSql = (sql: string) => execFileSync("su", ["postgres", "-c", `psql -v ON_ERROR_STOP=1 -qAt -d ${name}`], { input: sql, encoding: "utf8" });
  return { ownerSql, webUrl: `postgres://ih_web:ih_web_local@127.0.0.1:5432/${name}` };
}

export async function harness(dbName: string, opts: { drafter?: IdeaDrafter | null; agent?: StudyAgent | null } = {}) {
  const db = freshDatabase(dbName);
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const pool = createPool(db.webUrl, 5);
  const store = new LocalObjectStore(mkdtempSync(join(tmpdir(), "ih-store-")));
  const router = buildRouter({ pool, auth: localAuth(ISSUER, "innovahospital-test", { keys: [jwk] }), reports: { store, synthetic: true }, data: { drafter: opts.drafter ?? null }, studies: { agent: opts.agent ?? null, deidKey: "test-deid-key" } });
  const server = createServer(router.handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = (sub: string) => new SignJWT({ email: `${sub}@example.invalid` }).setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER).setAudience("innovahospital-test").setSubject(sub).setIssuedAt().setExpirationTime("5m").sign(privateKey);

  async function api(sub: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers };
    if (sub) h.authorization = `Bearer ${await token(sub)}`;
    const isFile = Buffer.isBuffer(body);
    if (body !== undefined && !isFile) h["content-type"] = "application/json";
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : isFile ? new Uint8Array(body as Buffer) : JSON.stringify(body) });
    const type = res.headers.get("content-type") ?? "";
    if (type.startsWith("application/pdf")) return { status: res.status, body: null as any, bytes: Buffer.from(await res.arrayBuffer()) };
    return { status: res.status, body: (res.status === 204 ? null : await res.json()) as any, bytes: null as Buffer | null };
  }
  db.ownerSql(`INSERT INTO platform_admin VALUES ('${ISSUER}', 'platform')`);

  /** Provision a hospital with departments and role grants: { sub: [[role, deptCode|null], ...] }. */
  async function provision(slug: string, departments: string[], grants: Record<string, [string, string | null][]>) {
    const p = await api("platform", "POST", "/v1/admin/workspaces", { name: `${slug} Hospital`, slug, country: "EG" });
    if (p.status !== 201) throw new Error(JSON.stringify(p.body));
    const ws = p.body.id as string;
    const ids: Record<string, string> = {};
    for (const code of departments) {
      const d = await api("platform", "POST", `/v1/admin/workspaces/${ws}/departments`, { code, name: code.toUpperCase() });
      ids[code] = d.body.id;
    }
    for (const [sub, list] of Object.entries(grants)) for (const [role, dept] of list) {
      const m = await api("platform", "POST", `/v1/admin/workspaces/${ws}/memberships`, { issuer: ISSUER, subject: sub, role, department_id: dept ? ids[dept] : null });
      if (m.status !== 201) throw new Error(JSON.stringify(m.body));
    }
    return { ws, dept: ids };
  }
  const actor = (sub: string) => `${ISSUER}|${sub}`;
  const close = async () => { server.close(); await pool.end(); };
  return { api, provision, actor, close, ownerSql: db.ownerSql, pool };
}
