import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

/**
 * LOCAL DEVELOPMENT ONLY: GET /__dev/token?sub=<subject> signs a short-lived
 * token with the backend's dev key (created by `node scripts/dev-token.ts`).
 * The plugin exists only for `vite dev` (apply: "serve"), answers loopback
 * clients only, and a production build refuses VITE_AUTH_MODE=dev.
 */
function devLogin(env: Record<string, string>): Plugin {
  return {
    name: "innovahospital-dev-login",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__dev/token", async (req, res) => {
        const remote = req.socket.remoteAddress ?? "";
        if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) { res.statusCode = 403; res.end(); return; }
        const sub = new URL(req.url ?? "", "http://x").searchParams.get("sub") ?? "";
        if (!/^[\w.-]{1,64}$/.test(sub)) { res.statusCode = 400; res.end(); return; }
        const { importJWK, SignJWT } = await import("jose");
        const keyPath = env.DEV_KEY_FILE ?? fileURLToPath(new URL("../.dev/dev-private.jwk.json", import.meta.url));
        const key = await importJWK(JSON.parse(readFileSync(keyPath, "utf8")), "RS256");
        const token = await new SignJWT({ email: `${sub}@example.invalid`, name: sub })
          .setProtectedHeader({ alg: "RS256", kid: "dev" })
          .setIssuer(env.DEV_OIDC_ISSUER ?? "https://dev.innovahospital.invalid/")
          .setAudience(env.DEV_OIDC_AUDIENCE ?? "innovahospital-dev")
          .setSubject(sub).setIssuedAt().setExpirationTime("8h").sign(key);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ token }));
      });
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  if (command === "build" && env.VITE_AUTH_MODE === "dev") {
    throw new Error("VITE_AUTH_MODE=dev cannot be used for a build. Configure OIDC (VITE_OIDC_AUTHORITY, VITE_OIDC_CLIENT_ID).");
  }
  const api = env.API_PROXY_TARGET ?? "http://127.0.0.1:8080";
  return {
    plugins: [react(), devLogin(env)],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: {
      port: 5173,
      proxy: { "/v1": { target: api, changeOrigin: false }, "/readyz": { target: api } },
    },
    build: { sourcemap: true },
  };
});
