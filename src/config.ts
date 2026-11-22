// Environment configuration. Secrets come from the host secret manager.
import { readFileSync } from "node:fs";
import type { AuthConfig } from "./auth.ts";
import { discoverAuth, localAuth } from "./auth.ts";
import { localAuthConfig } from "./local-auth.ts";

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export async function loadAuth(): Promise<AuthConfig> {
  // AUTH_MODE=local: built-in email and password accounts, no identity provider.
  if (process.env.AUTH_MODE === "local") return localAuthConfig(Buffer.from(env("LOCAL_AUTH_SECRET"), "base64"));
  if (process.env.AUTH_MODE && process.env.AUTH_MODE !== "oidc") throw new Error("AUTH_MODE must be oidc or local");
  const issuer = env("OIDC_ISSUER");
  const audience = env("OIDC_AUDIENCE", process.env.OIDC_CLIENT_ID);
  // DEV_JWKS_FILE is for local development only and is refused in production.
  if (process.env.DEV_JWKS_FILE) {
    if (process.env.NODE_ENV === "production") throw new Error("DEV_JWKS_FILE is not allowed in production");
    return localAuth(issuer, audience, JSON.parse(readFileSync(process.env.DEV_JWKS_FILE, "utf8")));
  }
  return discoverAuth(issuer, audience);
}
