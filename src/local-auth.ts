// Built-in sign-in (AUTH_MODE=local): email and password accounts stored in
// local_account, for installations without an external identity provider.
// The API issues its own short-lived session tokens (HS256, signed with
// LOCAL_AUTH_SECRET) and checks the account on every request, so disabling an
// account or changing its password ends its sessions at once.
import { randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { SignJWT } from "jose";
import type { AuthConfig, Identity } from "./auth.ts";
import type { Pool } from "./db.ts";
import { ApiError } from "./http.ts";

/** Issuer of built-in accounts; with the subject it forms the account ID used in memberships. */
export const LOCAL_ISSUER = "innovahospital:local";
export const LOCAL_AUDIENCE = "innovahospital";
export const SESSION_HOURS = 8;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;

export function localAuthConfig(secret: Uint8Array): AuthConfig {
  if (secret.length < 32) throw new Error("LOCAL_AUTH_SECRET must be at least 32 random bytes, base64-encoded");
  return { issuer: LOCAL_ISSUER, audience: LOCAL_AUDIENCE, keys: secret, algorithms: ["HS256"], local: { secret } };
}

// ---- Passwords --------------------------------------------------------------
// scrypt with N=2^16, r=8, p=1 (64 MiB per hash): about 0.1-0.2 s on one CPU.
const N = 65536, R = 8, P = 1, KEYLEN = 32;
const scryptAsync = (pw: string, salt: Buffer, n: number, r: number, p: number) =>
  new Promise<Buffer>((res, rej) => scrypt(pw.normalize("NFKC"), salt, KEYLEN,
    { N: n, r, p, maxmem: 256 * n * r } satisfies ScryptOptions, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split("$");
  if (alg !== "scrypt" || !key) return false;
  const want = Buffer.from(key, "base64");
  const got = await scryptAsync(pw, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Hash of a random password: verified against when the email is unknown, so timing does not reveal accounts. */
let dummyHash: Promise<string> | null = null;
export const dummyPasswordHash = () => (dummyHash ??= hashPassword(randomBytes(16).toString("hex")));

/** A temporary password the admin passes on; the user must replace it at first sign-in. */
export function temporaryPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const groups = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join(""));
  return groups.join("-");
}

export function passwordProblem(pw: string, email: string): string | null {
  if (pw.length < 12) return "The password must be at least 12 characters.";
  if (pw.length > 200) return "The password must be at most 200 characters.";
  if (pw.toLowerCase().includes(email.split("@")[0].toLowerCase()) && email.split("@")[0].length >= 4) return "The password must not contain your email name.";
  if (new Set(pw).size < 5) return "The password is too repetitive.";
  return null;
}

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

// ---- Sessions -----------------------------------------------------------------
export type LocalAccount = {
  subject: string; email: string; display_name: string | null; password_hash: string;
  must_change_password: boolean; password_version: number; failed_attempts: number;
  locked_until: Date | null; disabled_at: Date | null;
};

export async function issueSession(secret: Uint8Array, a: Pick<LocalAccount, "subject" | "email" | "display_name" | "password_version" | "must_change_password">) {
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600_000);
  const token = await new SignJWT({ email: a.email, name: a.display_name ?? a.email, pv: a.password_version, pwc: a.must_change_password })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(LOCAL_ISSUER).setAudience(LOCAL_AUDIENCE).setSubject(a.subject)
    .setIssuedAt().setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secret);
  return { token, expires_at: expiresAt.toISOString(), must_change_password: a.must_change_password };
}

/**
 * Checks a built-in account's session on each request: the account must exist
 * and be enabled, and the token must carry its current password version.
 * Until the temporary password is replaced, only the password change is allowed.
 */
export async function checkLocalSession(pool: Pool, id: Identity, allowPasswordChange: boolean): Promise<void> {
  const { rows } = await pool.query<Pick<LocalAccount, "password_version" | "disabled_at" | "must_change_password">>(
    "SELECT password_version, disabled_at, must_change_password FROM local_account WHERE subject = $1", [id.subject]);
  const a = rows[0];
  if (!a || a.disabled_at || a.password_version !== id.passwordVersion) {
    throw new ApiError(401, "invalid_token", "Your session has ended. Sign in again.");
  }
  if (a.must_change_password && !allowPasswordChange) {
    throw new ApiError(403, "password_change_required", "Choose a new password before continuing.");
  }
}
