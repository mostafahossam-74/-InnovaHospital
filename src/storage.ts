// Private artifact storage. Production uses an object store bucket
// (OBJECT_BUCKET) with short-lived signed URLs; this filesystem
// implementation serves local development and tests with the same contract:
// write-once keys, integrity hash verified on every read.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export interface ObjectStore {
  put(key: string, body: Buffer): Promise<{ sha256: string }>;
  get(key: string, expectedSha256: string): Promise<Buffer>;
}

const KEY_RE = /^[a-z0-9][a-z0-9/_.-]{0,400}$/;
export const sha256Bytes = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export class LocalObjectStore implements ObjectStore {
  root: string;
  constructor(root: string) { this.root = resolve(root); }

  private path(key: string): string {
    if (!KEY_RE.test(key) || key.includes("..")) throw new Error("Invalid object key");
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error("Invalid object key");
    return p;
  }

  async put(key: string, body: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    await writeFile(p, body, { flag: "wx", mode: 0o600 }); // write-once
    await chmod(p, 0o400);
    return { sha256: sha256Bytes(body) };
  }

  async get(key: string, expectedSha256: string) {
    const body = await readFile(this.path(key));
    if (sha256Bytes(body) !== expectedSha256) throw new Error("Artifact integrity check failed");
    return body;
  }
}

/** Short-lived download grants, the local equivalent of a presigned URL. */
export type DownloadGrant = { ws: string; report: string; sub: string; exp: number };

export function signGrant(key: Buffer, grant: DownloadGrant): string {
  const body = Buffer.from(JSON.stringify(grant)).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

export function verifyGrant(key: Buffer, token: string, now = Date.now()): DownloadGrant | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", key).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const g = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as DownloadGrant;
    return typeof g.exp === "number" && g.exp > now ? g : null;
  } catch {
    return null;
  }
}
