// Applies db/migrations/*.sql that have not been applied yet, in file-name order.
// Each file runs in its own transaction and is recorded in schema_migration with
// its SHA-256, so a deploy can run this every time before the API starts.
//
// Connect as the database owner, not the ih_web runtime role:
//   MIGRATION_DATABASE_URL=postgres://owner:…@host/db node scripts/migrate.ts
//
// Options:
//   --status           list applied and pending files; change nothing
//   --baseline=<file>  for a database migrated by hand before this runner existed:
//                      record every file up to and including <file> as applied,
//                      without running them, then apply the rest
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const DIR = new URL("../db/migrations/", import.meta.url).pathname;
const LOCK = 7_210_914_001; // pg_advisory_lock key: one runner at a time per database

const args = process.argv.slice(2);
const statusOnly = args.includes("--status");
const baseline = args.find((a) => a.startsWith("--baseline="))?.slice("--baseline=".length);
const unknown = args.filter((a) => a !== "--status" && !a.startsWith("--baseline="));
if (unknown.length) fail(`Unknown option: ${unknown.join(" ")}`);

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) fail("Set MIGRATION_DATABASE_URL to the database owner's connection string (not the ih_web runtime role).");

const files = readdirSync(DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
if (baseline && !files.includes(baseline)) fail(`--baseline: no migration named ${baseline}. Files: ${files.join(", ")}`);
const sha = (f: string) => createHash("sha256").update(readFileSync(join(DIR, f))).digest("hex");

function fail(msg: string): never { console.error(`migrate: ${msg}`); process.exit(1); }

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("SET client_min_messages = warning"); // hide "already exists, skipping" notices
  await client.query("SELECT pg_advisory_lock($1)", [LOCK]);
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migration (
    name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), baseline boolean NOT NULL DEFAULT false)`);
  const applied = new Map<string, string>((await client.query("SELECT name, sha256 FROM schema_migration")).rows.map((r) => [r.name, r.sha256]));

  // A database set up by hand before this runner has tables but no records: running
  // 001 again would fail half-way, so ask which files it already has.
  if (!applied.size && !baseline && (await client.query("SELECT to_regclass('public.workspace') IS NOT NULL AS has")).rows[0].has) {
    fail("This database already has the schema but no migration records. Find the last migration it has had " +
      "and run once with --baseline=<that file>, for example --baseline=002_studies.sql.");
  }
  if (baseline && applied.size) fail("--baseline is only for a database with no migration records yet.");

  for (const f of applied.keys()) if (!files.includes(f)) console.warn(`migrate: warning: ${f} was applied but its file is gone`);
  for (const f of files) {
    const recorded = applied.get(f);
    if (recorded && recorded !== sha(f)) {
      fail(`${f} changed after it was applied (recorded ${recorded.slice(0, 12)}…, file ${sha(f).slice(0, 12)}…). ` +
        "Never edit an applied migration; add a new file instead.");
    }
  }

  if (baseline && !statusOnly) {
    const upTo = files.slice(0, files.indexOf(baseline) + 1);
    for (const f of upTo) await client.query("INSERT INTO schema_migration (name, sha256, baseline) VALUES ($1,$2,true)", [f, sha(f)]);
    upTo.forEach((f) => { applied.set(f, sha(f)); console.log(`recorded ${f} (baseline, not run)`); });
  }

  const pending = files.filter((f) => !applied.has(f));
  if (statusOnly) {
    for (const f of files) console.log(`${applied.has(f) ? "applied" : "pending"}  ${f}`);
  } else {
    for (const f of pending) {
      try {
        await client.query("BEGIN");
        await client.query(readFileSync(join(DIR, f), "utf8"));
        await client.query("INSERT INTO schema_migration (name, sha256) VALUES ($1,$2)", [f, sha(f)]);
        await client.query("COMMIT");
        console.log(`applied ${f}`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        fail(`${f} failed and was rolled back: ${err instanceof Error ? err.message : err}`);
      }
    }
    console.log(pending.length ? `Done: ${pending.length} applied.` : "Up to date.");
  }
} finally {
  await client.end().catch(() => {});
}
