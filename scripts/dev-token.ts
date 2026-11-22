// LOCAL DEVELOPMENT ONLY. Creates a dev signing key in .dev/ (git-ignored) and
// prints a bearer token for a subject. The API trusts this key only when
// DEV_JWKS_FILE is set, which is refused when NODE_ENV=production.
// Usage: node scripts/dev-token.ts <subject>   (issuer/audience from env)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { exportJWK, generateKeyPair, importJWK, SignJWT } from "jose";

if (process.env.NODE_ENV === "production") throw new Error("dev-token is not available in production");
const dir = new URL("../.dev/", import.meta.url);
const privPath = new URL("dev-private.jwk.json", dir);
const jwksPath = new URL("dev-jwks.json", dir);
if (!existsSync(privPath)) {
  mkdirSync(dir, { recursive: true });
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  writeFileSync(privPath, JSON.stringify({ ...(await exportJWK(privateKey)), kid: "dev" }), { mode: 0o600 });
  writeFileSync(jwksPath, JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid: "dev", alg: "RS256", use: "sig" }] }));
}
const sub = process.argv[2];
if (!sub) throw new Error("Usage: node scripts/dev-token.ts <subject>");
const key = await importJWK(JSON.parse(readFileSync(privPath, "utf8")), "RS256");
const token = await new SignJWT({ email: `${sub}@example.invalid` }).setProtectedHeader({ alg: "RS256", kid: "dev" })
  .setIssuer(process.env.OIDC_ISSUER ?? "https://dev.innovahospital.invalid/")
  .setAudience(process.env.OIDC_AUDIENCE ?? "innovahospital-dev")
  .setSubject(sub).setIssuedAt().setExpirationTime("1h").sign(key);
console.log(token);
