// Web/API process. Connects with the ih_web database role (DATABASE_URL).
import { createServer } from "node:http";
import { createPool } from "./db.ts";
import { buildRouter } from "./api.ts";
import { env, loadAuth } from "./config.ts";
import { staticSite } from "./static.ts";
import { LocalObjectStore } from "./storage.ts";
import { anthropicKey, ClaudeIdeaDrafter } from "./analytics/ideas.ts";
import { ClaudeStudyAgent } from "./studies/agent.ts";

const pool = createPool(env("DATABASE_URL"));
// OBJECT_STORE_DIR: private write-once storage for released PDFs. Production
// swaps in an object-store implementation of the same ObjectStore interface.
const store = new LocalObjectStore(env("OBJECT_STORE_DIR"));
const corsOrigins = (process.env.CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
if (corsOrigins.some((o) => o === "*" || !/^https?:\/\/[^/]+$/.test(o))) throw new Error("CORS_ORIGINS must list exact origins, not wildcards or paths");
// Optional Claude drafting of study concepts from confirmed gaps; without a key
// the deterministic templates are used.
const drafter = anthropicKey() && process.env.IDEA_DRAFTER !== "off" ? new ClaudeIdeaDrafter() : null;
// DEID_KEY: secret for patient-ID pseudonyms (32+ random bytes). Required in production.
const deidKey = process.env.DEID_KEY ?? (process.env.NODE_ENV === "production" ? env("DEID_KEY") : "dev-only-deid-key");
// Claude study agent (dictionary, hypotheses, plans, interpretation, manuscript); rule-based steps without a key.
const agent = anthropicKey() && process.env.STUDY_AGENT !== "off" ? new ClaudeStudyAgent() : null;
const router = buildRouter({ pool, auth: await loadAuth(), reports: { store, synthetic: process.env.SYNTHETIC_DATA === "true" }, corsOrigins, data: { drafter }, studies: { agent, deidKey } });
const port = Number(env("PORT", "8080"));
const web = process.env.WEB_DIST_DIR ? staticSite(process.env.WEB_DIST_DIR, process.env.AUTH_MODE === "local" ? undefined : process.env.VITE_OIDC_AUTHORITY) : null;
const server = createServer(web ? (req, res) => { if (!web(req, res)) void router.handle(req, res); } : router.handle);
server.listen(port, () => console.log(JSON.stringify({ level: "info", msg: "api listening", port })));
const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
