// The migration runner (scripts/migrate.ts): fresh databases, re-runs, databases
// migrated by hand before the runner existed, and edited migrations.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const DB = "ih_test_migrate";
const FILES = readdirSync(`${ROOT}db/migrations`).filter((f) => f.endsWith(".sql")).sort();
const asPostgres = (cmd: string, input?: string) => spawnSync("su", ["postgres", "-c", cmd], { input, encoding: "utf8" });
const sql = (q: string) => execFileSync("su", ["postgres", "-c", `psql -v ON_ERROR_STOP=1 -qAt -d ${DB}`], { input: q, encoding: "utf8" }).trim();
const migrate = (...args: string[]) => {
  const r = asPostgres(`MIGRATION_DATABASE_URL='postgresql://postgres@%2Fvar%2Frun%2Fpostgresql/${DB}' node ${ROOT}scripts/migrate.ts ${args.join(" ")}`);
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const recreate = () => asPostgres(`psql -q -d postgres -c 'DROP DATABASE IF EXISTS ${DB} WITH (FORCE)' -c 'CREATE DATABASE ${DB}'`);
after(() => asPostgres(`psql -q -d postgres -c 'DROP DATABASE IF EXISTS ${DB} WITH (FORCE)'`));

test("fresh database: applies every file once; a re-run changes nothing", () => {
  recreate();
  const first = migrate();
  assert.equal(first.code, 0, first.out);
  for (const f of FILES) assert.match(first.out, new RegExp(`applied ${f}`));
  assert.equal(sql("SELECT string_agg(name, ',' ORDER BY name) FROM schema_migration"), FILES.join(","));
  const again = migrate();
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /Up to date/);
  assert.match(migrate("--status").out, new RegExp(FILES.map((f) => `applied  ${f}`).join("\n")));
});

test("database migrated by hand: refuses without --baseline, then applies only what is missing", () => {
  recreate();
  for (const f of FILES.slice(0, 2)) asPostgres(`psql -v ON_ERROR_STOP=1 -q -1 -d ${DB} -f ${ROOT}db/migrations/${f}`);
  const refused = migrate();
  assert.equal(refused.code, 1);
  assert.match(refused.out, /--baseline=<that file>/);
  assert.equal(sql("SELECT count(*) FROM information_schema.columns WHERE table_name = 'agent_call' AND column_name = 'rejected_output'"), "0");
  const pendingBefore = migrate("--status", `--baseline=${FILES[1]}`);
  assert.equal(pendingBefore.code, 0, pendingBefore.out);
  assert.equal(sql("SELECT count(*) FROM schema_migration"), "0", "--status must not record anything");
  const r = migrate(`--baseline=${FILES[1]}`);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`recorded ${FILES[0]} \\(baseline, not run\\)`));
  assert.match(r.out, /applied 003_agent_rejected_output\.sql/);
  assert.equal(sql("SELECT count(*) FROM information_schema.columns WHERE table_name = 'agent_call' AND column_name = 'rejected_output'"), "1");
  assert.equal(sql("SELECT string_agg(name || ':' || baseline, ',' ORDER BY name) FROM schema_migration"),
    FILES.map((f, i) => `${f}:${i < 2}`).join(","));
  assert.equal(migrate(`--baseline=${FILES[1]}`).code, 1, "--baseline only on a database with no records");
});

test("an applied migration whose file changed stops the run", () => {
  sql(`UPDATE schema_migration SET sha256 = 'deadbeef' WHERE name = '${FILES[0]}'`);
  const r = migrate();
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`${FILES[0]} changed after it was applied`));
});

test("refuses to start without an owner connection string", () => {
  const r = spawnSync("node", [`${ROOT}scripts/migrate.ts`], { encoding: "utf8", env: { ...process.env, MIGRATION_DATABASE_URL: "" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /MIGRATION_DATABASE_URL/);
});
