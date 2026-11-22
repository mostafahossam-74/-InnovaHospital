// Serves the built web app (web/dist) from the API process, for hosts where
// one service answers on one origin (Render). Single-server installs leave
// WEB_DIST_DIR unset and let nginx serve the files with the same headers.
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
  ".map": "application/json", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
};

/** Paths the API answers; everything else is the web app. */
export const isApiPath = (path: string): boolean => path.startsWith("/v1/") || path === "/v1" || path === "/healthz" || path === "/readyz";

export function contentSecurityPolicy(idpAuthority?: string): string {
  let idp = "";
  if (idpAuthority) {
    const u = new URL(idpAuthority);
    if (u.protocol !== "https:" && u.hostname !== "localhost") throw new Error("VITE_OIDC_AUTHORITY must be an https URL");
    idp = " " + u.origin;
  }
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; ` +
    `connect-src 'self'${idp}; frame-src 'self' blob:${idp}; object-src 'none'; base-uri 'self'; form-action 'self'${idp}; frame-ancestors 'none'`;
}

/**
 * Loads every file under `dir` into memory and returns a request handler that
 * answers GET/HEAD for web app paths. It returns false for API paths and
 * other methods, which the caller passes on to the API router.
 */
export function staticSite(dir: string, idpAuthority?: string): (req: IncomingMessage, res: ServerResponse) => boolean {
  const root = resolve(dir);
  const files = new Map<string, Buffer>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.set("/" + relative(root, p).split(sep).join("/"), readFileSync(p));
    }
  };
  walk(root);
  if (!files.has("/index.html")) throw new Error(`WEB_DIST_DIR ${root} has no index.html; build the web app first`);
  const csp = contentSecurityPolicy(idpAuthority);

  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    let path: string;
    try { path = decodeURIComponent(new URL(req.url ?? "/", "http://internal").pathname); } catch { path = "/"; }
    if (isApiPath(path)) return false;
    let file = files.get(path);
    let name = path;
    if (!file && !path.startsWith("/assets/")) { file = files.get("/index.html"); name = "/index.html"; }
    res.setHeader("content-security-policy", csp);
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("strict-transport-security", "max-age=31536000");
    if (!file) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("Not found");
      return true;
    }
    res.statusCode = 200;
    res.setHeader("content-type", TYPES[extname(name)] ?? "application/octet-stream");
    // Vite puts a content hash in every file name under /assets/.
    res.setHeader("cache-control", name.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    res.setHeader("content-length", file.length);
    res.end(req.method === "HEAD" ? undefined : file);
    return true;
  };
}
