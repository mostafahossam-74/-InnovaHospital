// Render entry point (render.yaml). Turns the values Render provides into what the app expects,
// then runs one of:
//
//   node scripts/render.ts predeploy            migrations as the database owner, then the ih_web password
//   node scripts/render.ts api                  the API and web app, connected as ih_web
//   node scripts/render.ts worker               the scheduler worker, connected as ih_web
//   node scripts/render.ts bootstrap-admin EMAIL   the first platform administrator (built-in sign-in)
//
// Render environment (see render.yaml):
//   OWNER_DATABASE_URL   the database owner's connection string (Render's default user)
//   DB_HOST, DB_PORT, DB_NAME   where the app connects as ih_web
//   IH_WEB_PASSWORD      generated; set on the ih_web role at every pre-deploy
//   LOCAL_AUTH_SECRET    generated; hashed to the 32-byte key built-in sign-in needs
//   APP_BASE_URL         the portal's public address, for links in emails (worker)
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";

const required = (name: string) => {
  const v = process.env[name];
  if (!v) { console.error(`render: set ${name}`); process.exit(1); }
  return v;
};
const appDatabaseUrl = () =>
  `postgres://ih_web:${encodeURIComponent(required("IH_WEB_PASSWORD"))}@${required("DB_HOST")}:${process.env.DB_PORT ?? "5432"}/${encodeURIComponent(required("DB_NAME"))}`;
// Built-in sign-in needs a base64 key of at least 32 bytes, whatever form the generated value takes.
const signingKey = () => createHash("sha256").update(required("LOCAL_AUTH_SECRET")).digest("base64");
const ROOT = new URL("..", import.meta.url).pathname;

const command = process.argv[2];
if (command === "predeploy") {
  // Migrations: everything the database does not have yet, in order (scripts/migrate.ts).
  const r = spawnSync(process.execPath, [`${ROOT}scripts/migrate.ts`], { stdio: "inherit", env: { ...process.env, MIGRATION_DATABASE_URL: required("OWNER_DATABASE_URL") } });
  if (r.status !== 0) process.exit(r.status ?? 1);
  // The API and worker connect as ih_web (created by migration 001), never as the owner.
  const c = new pg.Client({ connectionString: required("OWNER_DATABASE_URL") });
  await c.connect();
  const sql = (await c.query("SELECT format('ALTER ROLE ih_web WITH LOGIN PASSWORD %L', $1::text) AS q", [required("IH_WEB_PASSWORD")])).rows[0].q;
  await c.query(sql);
  await c.end();
  console.log("render: migrations applied; ih_web password set");
} else if (command === "api" || command === "worker") {
  process.env.DATABASE_URL = appDatabaseUrl();
  process.env.NODE_ENV ??= "production";
  if (command === "api") {
    process.env.AUTH_MODE ??= "local";
    if (process.env.AUTH_MODE === "local") process.env.LOCAL_AUTH_SECRET = signingKey();
    process.env.WEB_DIST_DIR ??= `${ROOT}web/dist`;
    process.env.OBJECT_STORE_DIR ??= "/var/data/objects";
    await import("../src/server.ts");
  } else {
    await import("../src/worker.ts");
  }
} else if (command === "bootstrap-admin") {
  // The first platform administrator for built-in sign-in: every account route needs an admin.
  const email = (process.argv[3] ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) { console.error("render: usage: node scripts/render.ts bootstrap-admin you@hospital.example"); process.exit(1); }
  const { hashPassword, LOCAL_ISSUER } = await import("../src/local-auth.ts");
  const c = new pg.Client({ connectionString: required("OWNER_DATABASE_URL") });
  await c.connect();
  try {
    await c.query("BEGIN");
    if ((await c.query("SELECT 1 FROM platform_admin WHERE issuer = $1", [LOCAL_ISSUER])).rowCount) {
      console.error("render: a platform administrator already exists; add more from the app (Platform administration)");
      process.exit(1);
    }
    const password = randomBytes(12).toString("base64url");
    const subject = (await c.query(`INSERT INTO local_account (email, display_name, password_hash, must_change_password, created_by)
      VALUES ($1, $2, $3, true, 'bootstrap') RETURNING subject`, [email, "Platform administrator", await hashPassword(password)])).rows[0].subject;
    await c.query("INSERT INTO platform_admin (issuer, subject) VALUES ($1, $2)", [LOCAL_ISSUER, String(subject)]);
    await c.query("COMMIT");
    console.log(`render: platform administrator ${email} created. Temporary password (change it at first sign-in): ${password}`);
  } finally {
    await c.end();
  }
} else {
  console.error("render: usage: node scripts/render.ts predeploy|api|worker|bootstrap-admin EMAIL");
  process.exit(1);
}
