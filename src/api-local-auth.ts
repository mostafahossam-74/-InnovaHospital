// Routes for built-in accounts (AUTH_MODE=local): sign-in, password change,
// and account administration by platform admins.
import { z } from "zod";
import type { Pool } from "./db.ts";
import { ApiError, Router } from "./http.ts";
import type { Ctx } from "./http.ts";
import { actorId, authenticate, isPlatformAdmin } from "./auth.ts";
import type { AuthConfig, Identity } from "./auth.ts";
import {
  dummyPasswordHash, hashPassword, issueSession, LOCAL_ISSUER, LOCK_MINUTES, MAX_FAILED_ATTEMPTS, normalizeEmail,
  passwordProblem, temporaryPassword, verifyPassword, type LocalAccount,
} from "./local-auth.ts";

const loginBody = z.object({ email: z.string().max(320), password: z.string().max(200) }).strict();
const passwordBody = z.object({ current_password: z.string().max(200), new_password: z.string().max(400) }).strict();
const createBody = z.object({ email: z.string().trim().email().max(320), display_name: z.string().trim().min(1).max(200).optional() }).strict();
const patchBody = z.object({ disabled: z.boolean() }).strict();

const BAD_LOGIN = () => new ApiError(401, "invalid_credentials", "Email or password is incorrect.");
const LOCKED = () => new ApiError(429, "account_locked", `Too many failed sign-in attempts. Try again in ${LOCK_MINUTES} minutes.`);

/**
 * Failed attempts on emails without an account, kept in memory, so that
 * unknown and existing emails lock out alike and the lock message does not
 * reveal which addresses have accounts.
 */
const unknownFailures = new Map<string, { count: number; until: number }>();

function log(event: string, actor: string, detail: Record<string, unknown>) {
  console.log(JSON.stringify({ level: "info", msg: "audit", event, actor, ...detail }));
}

export function registerLocalAuthRoutes(r: Router, { pool, auth, secret }: { pool: Pool; auth: AuthConfig; secret: Uint8Array }) {
  const requireAdmin = async (ctx: Ctx): Promise<Identity> => {
    const me = await authenticate(auth, ctx.req.headers.authorization);
    if (!(await isPlatformAdmin(pool, me))) throw new ApiError(403, "forbidden", "Platform admin required");
    return me;
  };

  r.on("POST", "/v1/auth/login", async (ctx) => {
    const b = loginBody.parse(await ctx.body());
    const email = normalizeEmail(b.email);
    const a = (await pool.query<LocalAccount>("SELECT * FROM local_account WHERE email = $1", [email])).rows[0];
    if (!a || a.disabled_at) {
      const f = unknownFailures.get(email);
      if (f && f.until > Date.now()) throw LOCKED();
      await verifyPassword(b.password, await dummyPasswordHash());
      const count = (f && f.until === 0 ? f.count : 0) + 1;
      if (unknownFailures.size > 10_000) unknownFailures.clear();
      unknownFailures.set(email, count >= MAX_FAILED_ATTEMPTS ? { count: 0, until: Date.now() + LOCK_MINUTES * 60_000 } : { count, until: 0 });
      throw BAD_LOGIN();
    }
    if (a.locked_until && a.locked_until > new Date()) throw LOCKED();
    if (!(await verifyPassword(b.password, a.password_hash))) {
      await pool.query(
        `UPDATE local_account SET
           locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) END,
           failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END
         WHERE subject = $1`, [a.subject, MAX_FAILED_ATTEMPTS, LOCK_MINUTES]);
      throw BAD_LOGIN();
    }
    await pool.query("UPDATE local_account SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE subject = $1", [a.subject]);
    return { body: await issueSession(secret, a) };
  });

  r.on("POST", "/v1/auth/password", async (ctx) => {
    const me = await authenticate(auth, ctx.req.headers.authorization, { allowPasswordChange: true });
    const b = passwordBody.parse(await ctx.body());
    const a = (await pool.query<LocalAccount>("SELECT * FROM local_account WHERE subject = $1", [me.subject])).rows[0];
    // 403, not 401: a wrong current password must not end the session in the web app.
    if (!a || !(await verifyPassword(b.current_password, a.password_hash))) throw new ApiError(403, "wrong_password", "Your current password is incorrect.");
    const problem = passwordProblem(b.new_password, a.email);
    if (problem) throw new ApiError(422, "weak_password", problem);
    if (b.new_password === b.current_password) throw new ApiError(422, "weak_password", "Choose a password different from the current one.");
    const updated = (await pool.query<LocalAccount>(
      `UPDATE local_account SET password_hash = $2, must_change_password = false, password_version = password_version + 1,
         password_changed_at = now(), failed_attempts = 0, locked_until = NULL
       WHERE subject = $1 RETURNING *`, [a.subject, await hashPassword(b.new_password)])).rows[0];
    log("account.password_change", actorId(me), { subject: a.subject });
    return { body: await issueSession(secret, updated) };
  });

  r.on("GET", "/v1/admin/accounts", async (ctx) => {
    await requireAdmin(ctx);
    const { rows } = await pool.query(
      `SELECT subject, email, display_name, must_change_password, disabled_at, created_at, last_login_at,
              CASE WHEN locked_until > now() THEN locked_until END AS locked_until
       FROM local_account ORDER BY email`);
    return { body: { issuer: LOCAL_ISSUER, items: rows } };
  });

  r.on("POST", "/v1/admin/accounts", async (ctx) => {
    const me = await requireAdmin(ctx);
    const b = createBody.parse(await ctx.body());
    const temp = temporaryPassword();
    try {
      const { rows } = await pool.query<{ subject: string }>(
        "INSERT INTO local_account (email, display_name, password_hash, created_by) VALUES ($1,$2,$3,$4) RETURNING subject",
        [normalizeEmail(b.email), b.display_name ?? null, await hashPassword(temp), actorId(me)]);
      log("account.create", actorId(me), { subject: rows[0].subject });
      return { status: 201, body: { issuer: LOCAL_ISSUER, subject: rows[0].subject, email: normalizeEmail(b.email), temporary_password: temp } };
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new ApiError(409, "account_exists", "An account with this email already exists.");
      throw e;
    }
  });

  r.on("POST", "/v1/admin/accounts/{subject}/reset-password", async (ctx) => {
    const me = await requireAdmin(ctx);
    const temp = temporaryPassword();
    const { rows } = await pool.query<{ email: string }>(
      `UPDATE local_account SET password_hash = $2, must_change_password = true, password_version = password_version + 1,
         password_changed_at = now(), failed_attempts = 0, locked_until = NULL
       WHERE subject::text = $1 RETURNING email`, [ctx.params.subject, await hashPassword(temp)]);
    if (!rows.length) throw new ApiError(404, "not_found", "Account not found");
    log("account.reset_password", actorId(me), { subject: ctx.params.subject });
    return { body: { subject: ctx.params.subject, email: rows[0].email, temporary_password: temp } };
  });

  r.on("PATCH", "/v1/admin/accounts/{subject}", async (ctx) => {
    const me = await requireAdmin(ctx);
    const b = patchBody.parse(await ctx.body());
    if (b.disabled && me.issuer === LOCAL_ISSUER && me.subject === ctx.params.subject) {
      throw new ApiError(422, "cannot_disable_self", "You cannot disable your own account.");
    }
    const { rowCount } = await pool.query(
      `UPDATE local_account SET disabled_at = CASE WHEN $2 THEN coalesce(disabled_at, now()) END,
         failed_attempts = 0, locked_until = NULL
       WHERE subject::text = $1`, [ctx.params.subject, b.disabled]);
    if (!rowCount) throw new ApiError(404, "not_found", "Account not found");
    log(b.disabled ? "account.disable" : "account.enable", actorId(me), { subject: ctx.params.subject });
    return { status: 204, body: null };
  });
}
