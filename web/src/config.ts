export const config = {
  apiBase: (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "",
  authMode: (import.meta.env.VITE_AUTH_MODE as "oidc" | "local" | "dev" | undefined) ?? "oidc",
  oidc: {
    authority: import.meta.env.VITE_OIDC_AUTHORITY as string | undefined,
    clientId: import.meta.env.VITE_OIDC_CLIENT_ID as string | undefined,
    scope: (import.meta.env.VITE_OIDC_SCOPE as string | undefined) ?? "openid profile email",
    audience: (import.meta.env.VITE_OIDC_AUDIENCE as string | undefined) || undefined,
  },
};
