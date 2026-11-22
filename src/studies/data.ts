// Patient-level study data: Excel/CSV parsing, column profiles,
// de-identification on upload, rule-based data dictionary, cleaning and the
// discovery/validation split.
import ExcelJS from "exceljs";
import { createHash, createHmac } from "node:crypto";
import { z } from "zod";

export type Raw = string | number | boolean | null;
export const MAX_ROWS = 200_000;
export const MAX_COLUMNS = 300;

// ---- Parsing ------------------------------------------------------------------------
function cellValue(v: ExcelJS.CellValue): Raw {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return typeof v === "string" ? v.trim() || null : v;
  if (typeof v === "object") {
    if ("result" in v) return cellValue((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ("richText" in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join("").trim() || null;
    if ("text" in v) return String((v as ExcelJS.CellHyperlinkValue).text).trim() || null;
    if ("error" in v) return null;
  }
  return String(v);
}

export type Sheet = { name: string; headers: string[]; rows: Raw[][] };

export async function parseWorkbook(buf: Buffer): Promise<Sheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const sheets: Sheet[] = [];
  wb.eachSheet((ws) => {
    const all: Raw[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = (row.values as ExcelJS.CellValue[]).slice(1).map(cellValue);
      all.push(vals);
    });
    const headerIdx = all.findIndex((r) => r.filter((v) => v !== null).length >= 2);
    if (headerIdx < 0) return;
    const headers = dedupeHeaders(all[headerIdx].map((h, i) => (h === null ? `column_${i + 1}` : String(h))));
    const rows = all.slice(headerIdx + 1).map((r) => headers.map((_, i) => r[i] ?? null)).filter((r) => r.some((v) => v !== null));
    sheets.push({ name: ws.name, headers, rows });
  });
  return sheets;
}

export function parseCsv(text: string): Sheet[] {
  const out: string[][] = []; let row: string[] = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); f = ""; if (row.some((x) => x.trim())) out.push(row); row = []; }
    else f += c;
  }
  row.push(f); if (row.some((x) => x.trim())) out.push(row);
  if (!out.length) return [];
  const headers = dedupeHeaders(out[0].map((h, i) => h.trim() || `column_${i + 1}`));
  const rows = out.slice(1).map((r) => headers.map((_, i) => { const v = (r[i] ?? "").trim(); return v === "" ? null : v; }));
  return [{ name: "csv", headers, rows }];
}

function dedupeHeaders(h: string[]): string[] {
  const seen = new Map<string, number>();
  return h.map((x) => { const n = (seen.get(x) ?? 0) + 1; seen.set(x, n); return n > 1 ? `${x} (${n})` : x; });
}

/** Variable name from a header: lower snake case, ASCII, unique. */
export function varNames(headers: string[]): string[] {
  const used = new Set<string>();
  return headers.map((h, i) => {
    let n = h.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!/^[a-z]/.test(n)) n = `v_${n || i + 1}`;
    n = n.slice(0, 50);
    let u = n, k = 2; while (used.has(u)) u = `${n}_${k++}`;
    used.add(u); return u;
  });
}

// ---- Profiles and identifier detection --------------------------------------------
const NUM_RE = /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})|^(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})$/;
export const toNumber = (v: Raw): number | null => (typeof v === "number" ? v : typeof v === "string" && NUM_RE.test(v.trim()) ? Number(v.replaceAll(",", "")) : null);

const ID_HEADER = /\b(name|first.?name|last.?name|surname|full.?name|patient.?name|phone|mobile|tel|telephone|email|e.?mail|address|street|national.?id|nid|ssn|passport|iqama|id.?number|civil.?id)\b|الاسم|اسم|هاتف|جوال|العنوان|الرقم القومي|هوية/i;
const PID_HEADER = /\b(mrn|patient.?id|patient.?no|file.?no|record.?no|hospital.?no|medical.?record|encounter.?id|admission.?id)\b|رقم الملف/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/, PHONE = /^\+?[\d\s-]{9,15}$/, NATIONAL_ID = /^(\d{14}|[12]\d{9})$/;

export type ColumnProfile = {
  source: string; name: string; inferred: "number" | "date" | "category" | "text" | "empty";
  n: number; missing: number; distinct: number;
  min?: number; max?: number; mean?: number;
  top?: { value: string; count: number }[];
  identifier_reason?: string;
};

export function profile(headers: string[], rows: Raw[][], smallCell = 5): ColumnProfile[] {
  const names = varNames(headers);
  return headers.map((h, j) => {
    const vals = rows.map((r) => r[j]).filter((v): v is Exclude<Raw, null> => v !== null && v !== "");
    const strs = vals.map(String);
    const nums = vals.map(toNumber).filter((v): v is number => v !== null);
    const distinct = new Set(strs).size;
    const dates = strs.filter((s) => DATE_RE.test(s)).length;
    const inferred = !vals.length ? "empty" : nums.length >= 0.95 * vals.length ? "number" : dates >= 0.9 * vals.length ? "date" : distinct <= Math.max(30, 0.05 * vals.length) ? "category" : "text";
    const p: ColumnProfile = { source: h, name: names[j], inferred, n: rows.length, missing: rows.length - vals.length, distinct };
    if (inferred === "number") { p.min = Math.min(...nums); p.max = Math.max(...nums); p.mean = Math.round((nums.reduce((s, v) => s + v, 0) / nums.length) * 100) / 100; }
    const idReason = ID_HEADER.test(h) ? "header names a direct identifier"
      : strs.length && strs.filter((s) => EMAIL.test(s)).length > 0.5 * strs.length ? "values look like email addresses"
      : strs.length && strs.filter((s) => NATIONAL_ID.test(s.replace(/\s/g, ""))).length > 0.5 * strs.length && distinct > 0.9 * strs.length ? "values look like national ID numbers"
      : strs.length && inferred !== "number" && inferred !== "date" && strs.filter((s) => PHONE.test(s) && !DATE_RE.test(s)).length > 0.5 * strs.length ? "values look like phone numbers" : undefined;
    if (idReason) p.identifier_reason = idReason;
    // Value summaries go to reviewers and the agent only for low-cardinality, non-identifying columns,
    // and only values seen at least `smallCell` times.
    if (!idReason && inferred === "category") {
      const counts = new Map<string, number>(); strs.forEach((s) => counts.set(s, (counts.get(s) ?? 0) + 1));
      p.top = [...counts.entries()].filter(([, c]) => c >= smallCell).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([value, count]) => ({ value, count }));
    }
    return p;
  });
}

/**
 * De-identification on upload: drops columns that look like direct identifiers
 * and replaces patient-ID columns with a keyed pseudonym. Runs before anything
 * is stored. Returns the remaining columns and a report.
 */
export function deidentify(headers: string[], rows: Raw[][], key: string) {
  const prof = profile(headers, rows);
  const dropped = prof.filter((p) => p.identifier_reason).map((p) => ({ column: p.source, reason: p.identifier_reason! }));
  const pidIdx = headers.findIndex((h, j) => PID_HEADER.test(h) && !prof[j].identifier_reason);
  const keep = headers.map((_, j) => j).filter((j) => !prof[j].identifier_reason);
  const pseudo = (v: Raw) => (v === null ? null : "P" + createHmac("sha256", key).update(String(v)).digest("hex").slice(0, 12));
  const outHeaders = keep.map((j) => headers[j]);
  const outRows = rows.map((r) => keep.map((j) => (j === pidIdx ? pseudo(r[j]) : r[j])));
  return { headers: outHeaders, rows: outRows, report: { dropped_columns: dropped, pseudonymised_column: pidIdx >= 0 ? headers[pidIdx] : null,
    note: "Direct identifiers were removed before storage. Dates are kept for study intervals; the dictionary step can remove further columns." } };
}

// ---- Data dictionary -----------------------------------------------------------------
export const ROLES = ["patient_id", "identifier", "age", "sex", "admission_date", "discharge_date", "event_date", "diagnosis", "exposure",
  "outcome", "time_to_event", "cost", "los", "covariate", "ignore"] as const;
export const TYPES = ["number", "category", "binary", "date", "text"] as const;
export const dictEntry = z.object({
  source: z.string().min(1).max(300),
  name: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  label: z.string().trim().min(1).max(200),
  role: z.enum(ROLES),
  type: z.enum(TYPES),
  missing_codes: z.array(z.string().max(50)).max(20).default([]),
  positive_values: z.array(z.string().max(50)).max(20).default([]),
  negative_values: z.array(z.string().max(50)).max(20).default([]),
  unit: z.string().max(40).nullable().default(null),
  note: z.string().max(1000).nullable().default(null),
}).strict();
export type DictEntry = z.infer<typeof dictEntry>;
export const dictionarySchema = z.array(dictEntry).min(1).max(MAX_COLUMNS);

const ROLE_RULES: [RegExp, (typeof ROLES)[number]][] = [
  [PID_HEADER, "patient_id"],
  [/\bage\b|العمر|السن/i, "age"], [/\b(sex|gender)\b|الجنس|النوع/i, "sex"],
  [/admi(ssion|t).*date|date.*admi|تاريخ الدخول/i, "admission_date"], [/discharge.*date|date.*discharge|تاريخ الخروج/i, "discharge_date"],
  [/(death|died|follow.?up|last.?seen).*(date)|date.*(death|follow)/i, "event_date"],
  [/(time|days|months).*(to|until).*(event|death)|survival|follow.?up.?(days|months)/i, "time_to_event"],
  [/diagnos|icd|condition|disease|التشخيص/i, "diagnosis"],
  [/treat|management|therapy|procedure|intervention|strategy|regimen|arm|group|surgery|العلاج/i, "exposure"],
  [/\b(los|length.?of.?stay|stay.?days|hospital.?days)\b|مدة الإقامة/i, "los"],
  [/cost|charge|bill|expense|price|amount|التكلفة/i, "cost"],
  [/died|death|dead|deceased|mortality|readmi|complicat|infection|outcome|event|success|failure|recurrence|الوفاة/i, "outcome"],
];
const POSITIVE = ["1", "yes", "y", "true", "died", "dead", "deceased", "positive", "present", "readmitted", "نعم"];
const NEGATIVE = ["0", "no", "n", "false", "alive", "survived", "negative", "absent", "لا"];
const MISSING = ["", "na", "n/a", "nan", "null", "none", "unknown", "missing", "-", ".", "?", "غير معروف"];

/** Rule-based dictionary proposal from column profiles (no patient rows needed). */
export function ruleDictionary(profiles: ColumnProfile[]): DictEntry[] {
  return profiles.map((p) => {
    let role: DictEntry["role"] = p.identifier_reason ? "identifier" : ROLE_RULES.find(([re]) => re.test(p.source))?.[1] ?? (p.inferred === "text" ? "ignore" : p.inferred === "empty" ? "ignore" : "covariate");
    const lower = (p.top ?? []).map((t) => t.value.toLowerCase());
    const binaryLike = p.distinct <= 3 && lower.length > 0 && lower.every((v) => POSITIVE.includes(v) || NEGATIVE.includes(v) || MISSING.includes(v));
    let type: DictEntry["type"] = role === "patient_id" ? "text" : ["admission_date", "discharge_date", "event_date"].includes(role) || p.inferred === "date" ? "date"
      : binaryLike ? "binary" : p.inferred === "number" ? (p.distinct <= 2 && p.min === 0 && p.max === 1 ? "binary" : "number") : p.inferred === "category" ? "category" : "text";
    if (role === "outcome" && type === "category" && p.distinct > 2) role = "covariate";
    if (role === "exposure" && type === "number" && p.distinct > 10) role = "covariate";
    if (type === "date" && !["admission_date", "discharge_date", "event_date"].includes(role)) role = "ignore";
    return { source: p.source, name: p.name, label: p.source, role, type,
      missing_codes: (p.top ?? []).map((t) => t.value).filter((v) => MISSING.includes(v.toLowerCase())),
      positive_values: type !== "binary" ? [] : p.inferred === "number" ? ["1"] : (p.top ?? []).map((t) => t.value).filter((v) => POSITIVE.includes(v.toLowerCase())),
      negative_values: type !== "binary" ? [] : p.inferred === "number" ? ["0"] : (p.top ?? []).map((t) => t.value).filter((v) => NEGATIVE.includes(v.toLowerCase())),
      unit: role === "cost" ? "currency" : role === "los" ? "days" : role === "age" ? "years" : null, note: null };
  });
}

export function validateDictionary(d: DictEntry[], profiles: ColumnProfile[]): string[] {
  const problems: string[] = [];
  const sources = new Set(profiles.map((p) => p.source));
  for (const e of d) if (!sources.has(e.source)) problems.push(`Unknown column "${e.source}"`);
  const names = d.map((e) => e.name);
  for (const n of names.filter((n, i) => names.indexOf(n) !== i)) problems.push(`Duplicate variable name ${n}`);
  if (d.filter((e) => e.role === "patient_id").length > 1) problems.push("Only one patient_id column is allowed");
  for (const e of d) {
    if (e.type === "binary" && (!e.positive_values.length || !e.negative_values.length)) problems.push(`${e.name}: binary variables need the values that mean "yes" and "no"`);
    if (["cost", "los", "age", "time_to_event"].includes(e.role) && e.type !== "number") problems.push(`${e.name}: a ${e.role} column must be numeric`);
  }
  for (const p of profiles) if (p.identifier_reason && d.find((e) => e.source === p.source && e.role !== "identifier")) problems.push(`${p.source} looks like an identifier (${p.identifier_reason}); mark it identifier or explain in a note`);
  return problems.filter((x, i, a) => a.indexOf(x) === i);
}

// ---- Cleaning ------------------------------------------------------------------------
function parseDate(v: Raw): string | null {
  if (v === null) return null;
  if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10); // Excel serial
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s); // day/month/year, the usual order in Egypt and Saudi Arabia
  if (m) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  return null;
}
function iso(y: number, mo: number, d: number): string | null {
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null;
}
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400000;

export type CleanRow = Record<string, number | string | null>;

/** Applies a confirmed dictionary. Returns cleaned rows (with __split) and a report of every change. */
export function clean(headers: string[], rows: Raw[][], dict: DictEntry[], opts: { seed: number; discoveryFraction: number }) {
  const idx = new Map(headers.map((h, i) => [h, i]));
  const active = dict.filter((d) => !["identifier", "ignore"].includes(d.role));
  const report: { variable: string; label: string; role: string; type: string; missing: number; invalid: number; examples_invalid: string[]; summary: Record<string, unknown> }[] = [];
  const issues = new Map<string, { missing: number; invalid: number; ex: Set<string> }>();
  const out: CleanRow[] = rows.map((r) => {
    const o: CleanRow = {};
    for (const d of active) {
      const raw = r[idx.get(d.source)!] ?? null;
      const st = issues.get(d.name) ?? { missing: 0, invalid: 0, ex: new Set() }; issues.set(d.name, st);
      const s = raw === null ? "" : String(raw).trim();
      if (raw === null || s === "" || d.missing_codes.map((x) => x.toLowerCase()).includes(s.toLowerCase()) || MISSING.includes(s.toLowerCase())) { o[d.name] = null; st.missing++; continue; }
      let v: number | string | null;
      if (d.type === "number") v = toNumber(raw);
      else if (d.type === "date") v = parseDate(raw);
      else if (d.type === "binary") {
        // "Yes" values come from the confirmed dictionary; recognised "no" words map to 0; anything else is invalid.
        const l = s.toLowerCase();
        v = d.positive_values.map((x) => x.toLowerCase()).includes(l) ? 1 : d.negative_values.map((x) => x.toLowerCase()).includes(l) ? 0 : null;
      }
      else v = s;
      // Plausibility checks.
      if (typeof v === "number" && ((d.role === "age" && (v < 0 || v > 120)) || (["cost", "los", "time_to_event"].includes(d.role) && v < 0))) v = null;
      if (v === null) { st.invalid++; if (st.ex.size < 5) st.ex.add(s); }
      o[d.name] = v;
    }
    return o;
  });
  // Derived length of stay from dates when there is no LOS column.
  const adm = active.find((d) => d.role === "admission_date"), dis = active.find((d) => d.role === "discharge_date");
  const derived: string[] = [];
  let negativeStays = 0;
  if (adm && dis && !active.some((d) => d.role === "los")) {
    for (const o of out) { const a = o[adm.name], b = o[dis.name]; o.los_days = typeof a === "string" && typeof b === "string" ? days(a, b) : null; if (typeof o.los_days === "number" && o.los_days < 0) { o.los_days = null; negativeStays++; } }
    derived.push("los_days (discharge date − admission date)");
  }
  // Duplicates: same patient and admission date (or same patient when there are no dates).
  const pid = active.find((d) => d.role === "patient_id");
  let duplicates = 0;
  let kept = out;
  if (pid) {
    const seen = new Set<string>();
    kept = out.filter((o) => { const k = `${o[pid.name]}|${adm ? o[adm.name] : ""}`; if (o[pid.name] !== null && seen.has(k)) { duplicates++; return false; } seen.add(k); return true; });
  }
  // Deterministic split by pseudonymous patient (or row) key.
  kept.forEach((o, i) => {
    const key = pid && o[pid.name] !== null ? String(o[pid.name]) : `row${i}`;
    const h = createHash("sha256").update(`${opts.seed}|${key}`).digest().readUInt32BE(0) / 2 ** 32;
    o.__split = h < opts.discoveryFraction ? "discovery" : "validation";
  });
  for (const d of active) {
    const st = issues.get(d.name)!;
    const vals = kept.map((o) => o[d.name]).filter((v) => v !== null);
    const summary: Record<string, unknown> = {};
    if (d.type === "number" && vals.length) { const n = vals as number[]; summary.min = Math.min(...n); summary.max = Math.max(...n); summary.mean = Math.round((n.reduce((s, v) => s + v, 0) / n.length) * 100) / 100; }
    if (d.type === "binary") summary.yes_percent = vals.length ? Math.round((1000 * (vals as number[]).filter(Boolean).length) / vals.length) / 10 : null;
    if (d.type === "category") { const c = new Map<string, number>(); (vals as string[]).forEach((v) => c.set(v, (c.get(v) ?? 0) + 1)); summary.levels = c.size; summary.top = [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([value, count]) => ({ value, count })); }
    report.push({ variable: d.name, label: d.label, role: d.role, type: d.type, missing: st.missing, invalid: st.invalid, examples_invalid: [...st.ex], summary });
  }
  return {
    rows: kept,
    report: {
      rows_in: rows.length, rows_out: kept.length, duplicates_removed: duplicates, negative_stays_set_missing: negativeStays,
      removed_columns: dict.filter((d) => ["identifier", "ignore"].includes(d.role)).map((d) => ({ column: d.source, role: d.role })),
      derived, variables: report,
      split: { seed: opts.seed, discovery_fraction: opts.discoveryFraction, discovery: kept.filter((o) => o.__split === "discovery").length, validation: kept.filter((o) => o.__split === "validation").length },
    },
  };
}

/** Variables available to plans after cleaning. */
export function variablesOf(dict: DictEntry[], derived: string[]) {
  const vars = dict.filter((d) => !["identifier", "ignore", "patient_id"].includes(d.role))
    .map((d) => ({ name: d.name, label: d.label, role: d.role, type: d.type === "text" ? "category" as const : d.type }));
  if (derived.some((x) => x.startsWith("los_days"))) vars.push({ name: "los_days", label: "Length of stay (days)", role: "los", type: "number" });
  return vars;
}
