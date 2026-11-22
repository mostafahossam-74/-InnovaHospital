import { config } from "@/config";

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;
  requestId: string | null;
  constructor(status: number, code: string, message: string, details: unknown, requestId: string | null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

export type Api = {
  get<T = any>(path: string): Promise<T>;
  post<T = any>(path: string, body?: unknown, opts?: { idempotencyKey?: string }): Promise<T>;
  patch<T = any>(path: string, body: unknown): Promise<T>;
  put<T = any>(path: string, body: unknown): Promise<T>;
  blob(path: string): Promise<Blob>;
  upload<T = any>(path: string, file: File): Promise<T>;
};

export function createApi(getToken: () => Promise<string | null>, onUnauthorized: () => void): Api {
  async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const token = await getToken();
    const h: Record<string, string> = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    const isFile = body instanceof Blob;
    if (body !== undefined && !isFile) h["content-type"] = "application/json";
    const res = await fetch(config.apiBase + path, { method, headers: h, body: body === undefined ? undefined : isFile ? body : JSON.stringify(body) });
    if (res.ok) return res;
    let err: { code?: string; message?: string; details?: unknown } = {};
    try { err = (await res.json()).error ?? {}; } catch { /* non-JSON error */ }
    if (res.status === 401) onUnauthorized();
    throw new ApiError(res.status, err.code ?? "http_error", err.message ?? `Request failed (${res.status})`, err.details, res.headers.get("x-request-id"));
  }
  const json = async (r: Response) => (r.status === 204 ? null : r.json());
  return {
    get: (path) => request("GET", path).then(json),
    post: (path, body, opts) => request("POST", path, body ?? {}, opts?.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}).then(json),
    patch: (path, body) => request("PATCH", path, body).then(json),
    put: (path, body) => request("PUT", path, body).then(json),
    blob: (path) => request("GET", path).then((r) => r.blob()),
    upload: (path, file) => request("POST", path, file, { "content-type": file.type || (file.name.endsWith(".csv") ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") }).then(json),
  };
}

/** Released PDFs: the API returns a short-lived grant URL that needs no bearer token. */

export function openBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const describeError = (e: unknown): string => {
  if (e instanceof ApiError) {
    const details = Array.isArray(e.details)
      ? (e.details as { message?: string; path?: string; code?: string }[]).map((d) => d.message ? `${d.path ? d.path + ": " : ""}${d.message}` : d.code).filter(Boolean).join("; ")
      : "";
    return `${e.message}${details ? ` — ${details}` : ""}${e.requestId ? ` (ref ${e.requestId.slice(0, 8)})` : ""}`;
  }
  return e instanceof Error ? e.message : "Something went wrong";
};
