// Notification outbox (Developer_Handoff §5 step 6). Events write notices with notify()
// inside their own transaction, one per recipient; the scheduler worker delivers them with
// deliverDue(). A message says what needs doing and links to the portal, where the reader
// signs in; it never carries report figures or governance details.
//
// Delivery is at least once: an email is sent before its row is marked sent, so a crash
// between the two can repeat one email, never lose one. The address is looked up at
// delivery from the recipient's active membership, so revoked access stops further mail.
import { randomUUID } from "node:crypto";
import type { Client, Pool } from "./db.ts";
import { withTenant } from "./db.ts";
import { LOCAL_ISSUER } from "./local-auth.ts";
import { periodLabel } from "./period.ts";

export type NoticeKind = "report_review_needed" | "report_release_needed" | "report_returned" | "project_on_hold" | "scheduler_job_failed";
export const MAX_SEND_ATTEMPTS = 5;
export const SEND_RETRY_BASE_MS = 5 * 60_000;

// ---- Recipients ----------------------------------------------------------------------------
/** Active members holding any of `roles` today. With a department, workspace-wide grants count too. */
export async function membersWithRoles(c: Client, roles: string[], departmentId: string | null = null): Promise<string[]> {
  const { rows } = await c.query(`SELECT DISTINCT issuer || '|' || subject AS actor FROM membership
    WHERE active AND role = ANY($1) AND grant_start <= current_date AND (grant_end IS NULL OR grant_end >= current_date)
      AND ($2::uuid IS NULL OR department_id IS NULL OR department_id = $2) ORDER BY 1`, [roles, departmentId]);
  return rows.map((r) => r.actor);
}

export type Notice = {
  kind: NoticeKind; recipients: string[]; exclude?: (string | null | undefined)[];
  entityType: string; entityId: string; linkPath: string; params?: Record<string, string>;
  /** Identifies the event: the same event notifies each recipient once, however often it is retried. */
  dedupe: string;
};

/** Queues one notice per recipient, in the caller's transaction. Service actors are skipped. */
export async function notify(c: Client, wsId: string, n: Notice): Promise<number> {
  const skip = new Set(n.exclude?.filter(Boolean));
  let queued = 0;
  for (const to of new Set(n.recipients)) {
    if (skip.has(to) || to.startsWith("service:")) continue;
    queued += (await c.query(`INSERT INTO notification (workspace_id, kind, recipient, entity_type, entity_id, link_path, params, dedupe_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (workspace_id, dedupe_key) DO NOTHING`,
      [wsId, n.kind, to, n.entityType, n.entityId, n.linkPath, n.params ?? {}, `${n.dedupe}:${to}`])).rowCount ?? 0;
  }
  return queued;
}

// ---- Messages --------------------------------------------------------------------------------
const TASKS: Record<string, string> = { expiry_check: "governance expiry check" };
const FOOTER = "This message does not include any report or project details. Sign in to see them.";

export function renderMessage(kind: NoticeKind, p: Record<string, string>, hospital: string, link: string): { subject: string; text: string } {
  const month = periodLabel(p.period ?? "");
  const [subject, line, action] = {
    report_review_needed: [`Report for ${month} is ready for review`, `The report for ${month} has been drafted and is waiting for review.`, "Sign in to review it"],
    report_release_needed: [`Report for ${month} is ready for release`, `The report for ${month} has been reviewed and approved, and is waiting for release.`, "Sign in to release it"],
    report_returned: [`Report for ${month} was returned`, `The reviewer returned the report for ${month} with a note.`, "Sign in to read the note and draft a new revision"],
    project_on_hold: ["A project was put on hold", "A project you are responsible for was put on hold because its approvals need attention.", "Sign in to see the project and what it needs"],
    scheduler_job_failed: ["A scheduled task needs attention", `The scheduled ${TASKS[p.task] ?? "task"} for ${p.key} failed after ${p.attempts ?? "several"} attempts.`, "Sign in to handle it by hand"],
  }[kind];
  return { subject: `[${hospital}] ${subject}`, text: `${line}\n\n${action}:\n${link}\n\n${FOOTER}\n` };
}

// ---- Delivery --------------------------------------------------------------------------------
export type Email = { to: string; subject: string; text: string };
export interface Mailer { send(e: Email): Promise<{ id: string }> }

/** Development transport: writes each email to the log instead of sending it. */
export class LogMailer implements Mailer {
  private log: (line: string) => void;
  constructor(log: (line: string) => void = console.log) { this.log = log; }
  async send(e: Email) {
    const id = `log-${randomUUID()}`;
    this.log(JSON.stringify({ level: "info", msg: "email (log transport, not sent)", id, to: e.to, subject: e.subject, text: e.text }));
    return { id };
  }
}

/** MAIL_TRANSPORT selects the transport. Only "log" exists until an email provider is chosen. */
export function mailerFromEnv(): Mailer {
  const transport = process.env.MAIL_TRANSPORT ?? (process.env.NODE_ENV === "production" ? undefined : "log");
  if (transport === "log") return new LogMailer();
  if (transport === undefined) throw new Error("Set MAIL_TRANSPORT (only \"log\" is available until an email provider is configured)");
  throw new Error(`Unknown MAIL_TRANSPORT "${transport}" (available: log)`);
}

/** The portal's address for links: APP_BASE_URL, required in production. */
export function appBaseUrl(): string {
  const url = process.env.APP_BASE_URL ?? (process.env.NODE_ENV === "production" ? undefined : "http://localhost:5173");
  if (!url || !/^https?:\/\/[^/]+$/.test(url)) throw new Error("Set APP_BASE_URL to the portal's origin, e.g. https://research.hospital.example");
  return url;
}

export type Delivery = { workspace_id: string; id: string; kind: NoticeKind; outcome: "sent" | "skipped" | "retry" | "failed"; error?: string };

/** Sends every due notice, one transaction per notice. */
export async function deliverDue(pool: Pool, now: Date, mailer: Mailer, baseUrl: string): Promise<Delivery[]> {
  const out: Delivery[] = [];
  const workspaces = (await pool.query("SELECT id, name FROM workspace WHERE active ORDER BY created_at")).rows;
  for (const ws of workspaces) {
    for (;;) {
      const d = await withTenant(pool, ws.id, async (c): Promise<Delivery | null> => {
        const n = (await c.query(`SELECT id, kind, recipient, link_path, params, attempts FROM notification
          WHERE status = 'pending' AND next_attempt_at <= $1 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`, [now])).rows[0];
        if (!n) return null;
        const base = { workspace_id: ws.id, id: n.id, kind: n.kind as NoticeKind };
        const email = (await c.query(`SELECT coalesce(la.email, m.email) AS email FROM membership m
          LEFT JOIN local_account la ON m.issuer = $2 AND la.subject::text = m.subject AND la.disabled_at IS NULL
          WHERE m.active AND m.issuer || '|' || m.subject = $1 AND m.grant_start <= current_date AND (m.grant_end IS NULL OR m.grant_end >= current_date)
            AND coalesce(la.email, m.email) IS NOT NULL ORDER BY la.email IS NULL LIMIT 1`, [n.recipient, LOCAL_ISSUER])).rows[0]?.email as string | undefined;
        if (!email) {
          await c.query("UPDATE notification SET status = 'skipped', last_error = $2 WHERE id = $1", [n.id, "No active membership with an email address"]);
          return { ...base, outcome: "skipped" };
        }
        const msg = renderMessage(n.kind, n.params, ws.name, `${baseUrl}${n.link_path}`);
        try {
          const sent = await mailer.send({ to: email, ...msg });
          await c.query("UPDATE notification SET status = 'sent', attempts = attempts + 1, sent_to = $2, provider_message_id = $3, sent_at = $4, last_error = NULL WHERE id = $1",
            [n.id, email, sent.id, now]);
          return { ...base, outcome: "sent" };
        } catch (err) {
          const error = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
          const attempts = n.attempts + 1;
          if (attempts >= MAX_SEND_ATTEMPTS) {
            await c.query("UPDATE notification SET status = 'failed', attempts = $2, last_error = $3 WHERE id = $1", [n.id, attempts, error]);
            return { ...base, outcome: "failed", error };
          }
          await c.query("UPDATE notification SET attempts = $2, last_error = $3, next_attempt_at = $4 WHERE id = $1",
            [n.id, attempts, error, new Date(now.getTime() + SEND_RETRY_BASE_MS * 2 ** (attempts - 1))]);
          return { ...base, outcome: "retry", error };
        }
      });
      if (!d) break;
      out.push(d);
    }
  }
  return out;
}
