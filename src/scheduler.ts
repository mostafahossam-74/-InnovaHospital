// Scheduled jobs (Developer_Handoff §5, STATUS step 7). Each tick:
//   1. queues the jobs that are due for every active workspace: the monthly report draft
//      for the last closed month once the workspace's report_day/report_hour (local time)
//      has passed, and one expiry sweep per local day;
//   2. runs queued jobs whose time has come.
//
// A job runs in one transaction with the row locked (FOR UPDATE SKIP LOCKED) and is marked
// done in that same transaction, so its effects and its status commit together: a crash
// rolls both back and the job stays pending, and two workers never run the same job.
// Because all the work happens inside the database transaction, this gives what a lease
// and fencing token would, without them. A failing job is rolled back (savepoint) and
// retried after 5, 10, 20 and 40 minutes; after MAX_ATTEMPTS it is marked failed and audited.
//
// The scheduler only drafts. Review and release stay with people.
import type { Client, Pool } from "./db.ts";
import { audit, withTenant } from "./db.ts";
import { duePeriod, localDate } from "./period.ts";
import { draftReport } from "./api-reports.ts";
import { expirySweep } from "./api-office.ts";
import { deliverDue, membersWithRoles, notify } from "./notifications.ts";
import type { Delivery, Mailer } from "./notifications.ts";

export const SCHEDULER_ACTOR = "service:scheduler";
export const MAX_ATTEMPTS = 5;
export const RETRY_BASE_MS = 5 * 60_000;

export type JobKind = "report_draft" | "expiry_check";
export type Job = { workspace_id: string; kind: JobKind; job_key: string; scheduled_at: Date; attempts: number };
export type JobAction = (c: Client, job: Job) => Promise<Record<string, unknown>>;
export type JobOutcome = { workspace_id: string; kind: JobKind; job_key: string; outcome: "done" | "retry" | "failed"; result?: unknown; error?: string };

const correlation = (job: Job) => `scheduler:${job.kind}:${job.job_key}`;

export const ACTIONS: Record<JobKind, JobAction> = {
  // Drafts the month's report unless someone already did; a person reviews and releases it.
  report_draft: async (c, job) => {
    const existing = (await c.query("SELECT id, revision FROM report_revision WHERE period = $1 ORDER BY revision LIMIT 1", [job.job_key])).rows[0];
    if (existing) return { skipped: "already_drafted", report_id: existing.id, revision: existing.revision };
    return draftReport(c, job.workspace_id, job.job_key, SCHEDULER_ACTOR, correlation(job));
  },
  // Holds active projects whose approvals lapsed on this local date.
  expiry_check: async (c, job) => {
    const r = await expirySweep(c, job.workspace_id, SCHEDULER_ACTOR, job.job_key, correlation(job));
    return { held: r.held.map((h) => h.id), expiring_within_60_days: r.expiring_within_60_days.length };
  },
};

type Workspace = { id: string; timezone: string; report_day: number; report_hour: number; created_at: Date };
const activeWorkspaces = async (pool: Pool): Promise<Workspace[]> =>
  (await pool.query("SELECT id, timezone, report_day, report_hour, created_at FROM workspace WHERE active ORDER BY created_at")).rows;

/** Queues the jobs due at `now`. Re-queuing an existing job does nothing. Returns how many were added. */
export async function enqueueDue(pool: Pool, now: Date): Promise<number> {
  let added = 0;
  for (const ws of await activeWorkspaces(pool)) {
    const due = duePeriod(now, { timezone: ws.timezone, schedule_day: ws.report_day, schedule_hour: ws.report_hour });
    const today = localDate(now, ws.timezone);
    added += await withTenant(pool, ws.id, async (c) => {
      let n = 0;
      // A slot that passed before the workspace existed would only draft an empty report.
      if (due.scheduledAt >= ws.created_at) {
        n += (await c.query(`INSERT INTO scheduled_job (workspace_id, kind, job_key, scheduled_at, next_attempt_at)
          VALUES ($1,'report_draft',$2,$3,$3) ON CONFLICT DO NOTHING`, [ws.id, due.period, due.scheduledAt])).rowCount ?? 0;
      }
      n += (await c.query(`INSERT INTO scheduled_job (workspace_id, kind, job_key, scheduled_at, next_attempt_at)
        VALUES ($1,'expiry_check',$2,$3,$3) ON CONFLICT DO NOTHING`, [ws.id, today.date, today.midnight])).rowCount ?? 0;
      return n;
    });
  }
  return added;
}

/** Runs every queued job whose time has come, one transaction per job. */
export async function runDue(pool: Pool, now: Date, actions: Record<JobKind, JobAction> = ACTIONS): Promise<JobOutcome[]> {
  const outcomes: JobOutcome[] = [];
  for (const ws of await activeWorkspaces(pool)) {
    for (;;) {
      const outcome = await withTenant(pool, ws.id, async (c): Promise<JobOutcome | null> => {
        const job: Job | undefined = (await c.query(`SELECT workspace_id, kind, job_key, scheduled_at, attempts FROM scheduled_job
          WHERE status = 'pending' AND next_attempt_at <= $1 ORDER BY scheduled_at, kind LIMIT 1 FOR UPDATE SKIP LOCKED`, [now])).rows[0];
        if (!job) return null;
        const base = { workspace_id: job.workspace_id, kind: job.kind, job_key: job.job_key };
        const where = "workspace_id = $1 AND kind = $2 AND job_key = $3";
        await c.query("SAVEPOINT job");
        try {
          const result = await actions[job.kind](c, job);
          await c.query("RELEASE SAVEPOINT job");
          await c.query(`UPDATE scheduled_job SET status = 'done', attempts = attempts + 1, result = $4, last_error = NULL, finished_at = $5 WHERE ${where}`,
            [job.workspace_id, job.kind, job.job_key, result, now]);
          return { ...base, outcome: "done", result };
        } catch (err) {
          await c.query("ROLLBACK TO SAVEPOINT job");
          const error = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
          const attempts = job.attempts + 1;
          if (attempts >= MAX_ATTEMPTS) {
            await c.query(`UPDATE scheduled_job SET status = 'failed', attempts = $4, last_error = $5, finished_at = $6 WHERE ${where}`,
              [job.workspace_id, job.kind, job.job_key, attempts, error, now]);
            await audit(c, job.workspace_id, SCHEDULER_ACTOR, "scheduler.job_failed", "scheduled_job", `${job.kind}:${job.job_key}`, { attempts, error }, correlation(job));
            await notify(c, job.workspace_id, { kind: "scheduler_job_failed", recipients: await membersWithRoles(c, ["coordinator"]),
              entityType: "scheduled_job", entityId: `${job.kind}:${job.job_key}`,
              linkPath: `/#/w/${job.workspace_id}/${job.kind === "report_draft" ? "reports" : "projects"}`,
              params: { task: job.kind, key: job.job_key, period: job.kind === "report_draft" ? job.job_key : "", attempts: String(attempts) },
              dedupe: `scheduler_job_failed:${job.kind}:${job.job_key}` });
            return { ...base, outcome: "failed", error };
          }
          const retryAt = new Date(now.getTime() + RETRY_BASE_MS * 2 ** (attempts - 1));
          await c.query(`UPDATE scheduled_job SET attempts = $4, last_error = $5, next_attempt_at = $6 WHERE ${where}`,
            [job.workspace_id, job.kind, job.job_key, attempts, error, retryAt]);
          return { ...base, outcome: "retry", error };
        }
      });
      if (!outcome) break;
      outcomes.push(outcome);
    }
  }
  return outcomes;
}

export type TickOptions = { actions?: Record<JobKind, JobAction>; mailer?: Mailer; baseUrl?: string };

/** One scheduler pass: queue what is due, run it, then send due notifications (when given a mailer). */
export async function tick(pool: Pool, now = new Date(), opts: TickOptions = {}) {
  const queued = await enqueueDue(pool, now);
  const ran = await runDue(pool, now, opts.actions ?? ACTIONS);
  const sent: Delivery[] = opts.mailer ? await deliverDue(pool, now, opts.mailer, opts.baseUrl ?? "") : [];
  return { queued, ran, sent };
}
