import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  /** Set when the request's writes so far must be kept although the request fails (see withTenant). */
  commit?: boolean;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type Ctx = {
  req: IncomingMessage;
  params: Record<string, string>;
  query: URLSearchParams;
  requestId: string;
  body: () => Promise<unknown>;
  /** Raw request body (file uploads), up to MAX_RAW bytes. */
  raw: () => Promise<Buffer>;
};
export type Reply = { status?: number; body: unknown; raw?: { contentType: string; data: Buffer; headers?: Record<string, string> } };
type Handler = (ctx: Ctx) => Promise<Reply>;

const MAX_BODY = 1_000_000;
export const MAX_RAW = 50_000_000;

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_RAW) throw new ApiError(413, "payload_too_large", "The file is larger than 50 MB");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers["content-type"] ?? "";
  if (!/^application\/json\b/i.test(type)) throw new ApiError(415, "unsupported_media_type", "Use application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ApiError(413, "payload_too_large", "Request body is too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(422, "invalid_json", "Request body is not valid JSON");
  }
}

export class Router {
  private routes: { method: string; re: RegExp; keys: string[]; handler: Handler }[] = [];
  /** Exact origins allowed for cross-origin browser calls (CORS_ORIGINS). Empty = same-origin only. */
  corsOrigins: Set<string>;
  constructor(corsOrigins: string[] = []) { this.corsOrigins = new Set(corsOrigins); }

  on(method: string, pattern: string, handler: Handler): this {
    const keys: string[] = [];
    const re = new RegExp("^" + pattern.replace(/\{(\w+)\}/g, (_, k: string) => { keys.push(k); return "([^/]+)"; }) + "/?$");
    this.routes.push({ method, re, keys, handler });
    return this;
  }

  handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);
    const origin = req.headers.origin;
    if (origin && this.corsOrigins.has(origin)) {
      // Bearer tokens only (no cookies), so credentials are never allowed.
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-expose-headers", "x-request-id, x-artifact-sha256, content-disposition");
      if (req.method === "OPTIONS") {
        res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, OPTIONS");
        res.setHeader("access-control-allow-headers", "authorization, content-type, idempotency-key");
        res.setHeader("access-control-max-age", "600");
        res.statusCode = 204;
        res.end();
        return;
      }
    }
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    const url = new URL(req.url ?? "/", "http://internal");
    let status = 500;
    let body: unknown;
    let raw: Reply["raw"];
    try {
      const pathMatches = this.routes.filter((r) => r.re.test(url.pathname));
      const route = pathMatches.find((r) => r.method === req.method);
      if (!route) {
        throw pathMatches.length
          ? new ApiError(405, "method_not_allowed", "Method not allowed")
          : new ApiError(404, "not_found", "Route not found");
      }
      const m = route.re.exec(url.pathname)!;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      let cached: Promise<unknown> | undefined;
      const reply = await route.handler({
        req, params, query: url.searchParams, requestId,
        body: () => (cached ??= readJson(req)),
        raw: () => readRaw(req),
      });
      status = reply.status ?? 200;
      body = reply.body;
      raw = reply.raw;
    } catch (err) {
      ({ status, body } = toErrorBody(err, requestId));
    }
    res.statusCode = status;
    if (status === 204) { res.end(); return; }
    if (raw) {
      res.setHeader("content-type", raw.contentType);
      for (const [k, v] of Object.entries(raw.headers ?? {})) res.setHeader(k, v);
      res.end(raw.data);
      return;
    }
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  };
}

function toErrorBody(err: unknown, requestId: string): { status: number; body: unknown } {
  if (err instanceof ApiError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message, details: err.details, request_id: requestId } } };
  }
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return { status: 422, body: { error: { code: "validation_failed", message: "Invalid input", details, request_id: requestId } } };
  }
  const pgCode = (err as { code?: string }).code;
  if (pgCode === "23505") return { status: 409, body: { error: { code: "conflict", message: "A conflicting record already exists", request_id: requestId } } };
  if (pgCode === "23514" || pgCode === "22023" || pgCode === "22P02") {
    return { status: 422, body: { error: { code: "invalid_input", message: "Input violates a data constraint", request_id: requestId } } };
  }
  // Log server-side with the request ID only; never echo internals to clients.
  console.error(JSON.stringify({ level: "error", request_id: requestId, error: (err as Error)?.name, message: (err as Error)?.message }));
  return { status: 500, body: { error: { code: "internal", message: "Internal error", request_id: requestId } } };
}

/** Bounded cursor pagination: cursor is an opaque base64url of the last sort key. */
export function pageParams(q: URLSearchParams, max = 100): { limit: number; cursor: string | null } {
  const raw = Number(q.get("limit") ?? 50);
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, max) : 50;
  const c = q.get("cursor");
  if (!c) return { limit, cursor: null };
  try {
    return { limit, cursor: Buffer.from(c, "base64url").toString("utf8") };
  } catch {
    throw new ApiError(422, "invalid_cursor", "Invalid cursor");
  }
}
export const encodeCursor = (v: string): string => Buffer.from(v, "utf8").toString("base64url");
