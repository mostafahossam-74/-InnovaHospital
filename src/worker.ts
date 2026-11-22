// Scheduler process (npm run start:worker). Runs src/scheduler.ts every
// SCHEDULER_INTERVAL_SECONDS (default 60) with the same ih_web connection as the API
// (DATABASE_URL). Several workers may run at once: each job is taken by one of them.
import { createPool } from "./db.ts";
import { env } from "./config.ts";
import { tick } from "./scheduler.ts";
import { appBaseUrl, mailerFromEnv } from "./notifications.ts";

const pool = createPool(env("DATABASE_URL"), 3);
// Email: MAIL_TRANSPORT (only "log" until a provider is configured) and APP_BASE_URL for links.
const mailer = mailerFromEnv();
const baseUrl = appBaseUrl();
const everyMs = Number(env("SCHEDULER_INTERVAL_SECONDS", "60")) * 1000;
if (!Number.isFinite(everyMs) || everyMs < 1000) throw new Error("SCHEDULER_INTERVAL_SECONDS must be at least 1");

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ level, msg, ...extra }));

let stopping = false;
let timer: NodeJS.Timeout | undefined;
let running: Promise<void> = Promise.resolve();

async function pass() {
  try {
    const { queued, ran, sent } = await tick(pool, new Date(), { mailer, baseUrl });
    if (queued) log("info", "jobs queued", { queued });
    for (const j of ran) log(j.outcome === "done" ? "info" : "warn", `job ${j.outcome}`, { workspace: j.workspace_id, kind: j.kind, key: j.job_key, error: j.error });
    for (const n of sent) log(n.outcome === "sent" ? "info" : "warn", `notification ${n.outcome}`, { workspace: n.workspace_id, id: n.id, kind: n.kind, error: n.error });
  } catch (err) {
    log("error", "scheduler pass failed", { error: err instanceof Error ? err.message : String(err) });
  }
  if (!stopping) timer = setTimeout(() => { running = pass(); }, everyMs);
}

log("info", "scheduler started", { every_seconds: everyMs / 1000 });
running = pass();

const shutdown = async () => {
  stopping = true;
  clearTimeout(timer);
  await running;
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
