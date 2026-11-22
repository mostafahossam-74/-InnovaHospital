# InnovaHospital

Hospital research office and outcomes intelligence by InnovaStat CRO. The hospital sends **aggregate** data (patients per condition, management pathway, department and month, with deaths, readmissions, complications, length of stay and cost; plus monthly hospital parameters such as staffing and bed occupancy). InnovaHospital turns that data into:

1. **Disease burden.** Each condition's share of all cases, with 95% CIs and a trend test, plus mortality, readmission, length of stay and cost by department.
2. **Management and outcomes.** Outcomes for each way a condition is managed, with comparative effectiveness between managements (risk differences, risk ratios, Benjamini–Hochberg q values).
3. **Health economics.** Incremental cost, deaths averted, an ICER per death averted, dominance class, bed-days and annual budget impact.
4. **Efficacy of hospital parameters.** Associations between parameters and outcomes, computed within departments so that case-mix differences between departments do not drive them.
5. **A research-gap register.** Each signal becomes a candidate gap with a traceable statement, a 0–100 priority score and suggested designs. A reviewer other than the analyst confirms it.
6. **Research ideas.** A confirmed gap becomes a ready-to-edit study concept (comparative effectiveness, cost-effectiveness and budget impact, interrupted time series, burden-and-outcomes cohort…). Ideas then go through the research office workflow: intake, triage, feasibility, conversion, ethics and data approvals, milestones, outputs and publications.
7. **A monthly executive report** with disclosure control, review and release by different people, and a PDF.

It implements `docs/Developer_Handoff.md` (the InnovaStat developer package; the Python reference is in `reference/`) and adds the hospital-data analytics module. It uses the same stack and conventions as InnovaEvidence: Node 22 TypeScript API, PostgreSQL 16 with row-level security, and a React + Vite web app.

> Use synthetic data only until the hospital's governance, legal and data-protection review is complete (Handoff §8, Egypt PDPL 151/2020, KSA PDPL). The system stores no patient-level records.

## Quick start (local, synthetic data)

Requirements: Node ≥ 22.18 and PostgreSQL 16.

```bash
npm ci && (cd web && npm ci)
npm run dev:db                 # create the database and the dev signing key
npm run dev:api                # API on :8080 (dev auth, synthetic-data watermark)
```

In a second terminal:

```bash
npm run dev:seed               # builds "Nile Demo Hospital (synthetic)" through the API
cd web && VITE_AUTH_MODE=dev npm run dev    # http://localhost:5173
```

Sign in as any demo user: `coordinator`, `reviewer`, `director`, `steward`, `pi` (Cardiology investigator), `icu_pi`, `governance`, `admin`, `exec` (executive reader) or `platform-admin`. The seed uploads 12 months of synthetic aggregates for Cardiology, Intensive Care, Oncology and Internal Medicine, verifies them, runs the analysis (it finds 18 gaps and the seed confirms 5), drafts an idea, activates a project, records indicators and releases the October report. `docs/sample-executive-report.pdf` is that released report.

Tests (each test file creates its own database):

```bash
npm test          # 19 tests: statistics, analytics engine, API acceptance checks against PostgreSQL
npm run typecheck && (cd web && npx tsc -b)
```

## How the data flows

```
data steward ──upload CSV──▶ data_upload (submitted) ──second person verifies──▶ verified
                                                                         │
coordinator / reviewer ──run analysis (period, departments)──────────────▼
     analysis_run (frozen results + SHA-256)  ──▶  research_gap (proposed)
                                                         │  reviewer ≠ analyst: confirm / defer / reject
                                                         ▼
                                      idea (draft, template or Claude) ──▶ submitted ──▶ triage ──▶ feasibility
                                                         ──▶ accepted ──▶ convert (idempotent) ──▶ project
     project: submitted → feasibility → governance ─[valid ethics + data decision for the protocol version]→ active
              revocation / expiry / amendment → on hold        milestones · outputs · publications
monthly: coordinator drafts report ──▶ reviewer approves (digest) ──▶ director releases (PDF, archive)
```

## Upload format

CSV with a header row. Use one file per type, or send JSON to `POST /uploads`.

| Type | Columns |
|---|---|
| Cases, outcomes and costs | `period` (YYYY-MM), `department` (code), `condition_code` (ICD-10, e.g. `I21` or `I21.4`), `condition_label`, `management` (pathway, e.g. "Primary PCI"), optional `age_band`, `sex`, `cases`, `deaths`, `readmissions_30d`, `complications`, `los_days_sum`, `cost_sum` |
| Hospital parameters | `period`, `department`, `parameter_code` (e.g. `nurse_to_bed_ratio`), `parameter_label`, `value`, `unit` |

An empty outcome cell means "not recorded", which is different from 0. Counts must not exceed `cases`. Uploaded rows cannot be changed: a correction is a new upload, and for each department-month the newest verified upload replaces older ones.

## Roles

| Role | Can |
|---|---|
| Hospital administrator | Settings, departments, role grants |
| Research director | Confirm gaps, triage ideas, define indicators, release reports |
| Research coordinator | Run analyses, triage and convert ideas, move projects, draft reports |
| InnovaStat reviewer | Verify uploads and indicators, confirm gaps, approve reports |
| Data steward | Upload data and enter indicator values (for granted departments) |
| Principal investigator | Propose ideas, edit and submit their own, manage their projects' milestones and outputs |
| Governance recorder | Record official ethics and data decisions |
| Department lead | Work within their department, verify indicators |
| Executive reader | Released reports only |

A grant can apply to all departments or to one department, with an optional end date. The person who submits data, runs an analysis or authors a report cannot also verify, confirm or approve it. The approving reviewer cannot release.

## Layout

| Path | Purpose |
|---|---|
| `db/migrations/001_core.sql` | Schema, row-level security on every tenant table, append-only audit, frozen uploads and analyses, separation-of-duty checks, `ih_web` runtime role |
| `src/analytics/stats.ts` | Wilson and Newcombe intervals, two-proportion test, risk ratio, chi-square heterogeneity, Spearman with Fisher z, Benjamini–Hochberg, Poisson rate ratio |
| `src/analytics/engine.ts` | Burden, management outcomes, comparisons, economics, variation, parameter associations, coverage, completeness |
| `src/analytics/gaps.ts` | Signal → gap rules, statements and priority score |
| `src/analytics/ideas.ts` | Study-concept templates per gap type; optional Claude drafter with number validation |
| `src/analytics/synthetic.ts` | Deterministic synthetic hospital with planted signals (demo and tests) |
| `src/api*.ts` | HTTP API (`/v1/workspaces/{id}/…`): core, data and analytics, research office, reports |
| `src/reports/` | Monthly snapshot with disclosure control, and the PDF |
| `web/` | React web app: overview, hospital data, outcomes analytics, gaps, ideas, projects, indicators, training and partnerships, reports, settings. English with an Arabic/RTL layout switch |
| `docs/ANALYTICS.md` | Statistical methods, gap rules and limitations |
| `docs/STATUS.md` | Status against the handoff's build order, open items |
| `reference/`, `contracts/`, `docs/Developer_Handoff.md` | The InnovaStat developer package, unchanged |

## Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | `ih_web` role connection string |
| `AUTH_MODE` | `oidc` (default) or `local` (built-in email/password accounts, `LOCAL_AUTH_SECRET`) |
| `OIDC_ISSUER`, `OIDC_AUDIENCE` | Hospital-approved identity provider |
| `OBJECT_STORE_DIR` | Private write-once storage for released PDFs (swap for an object store in production) |
| `INNOVA_ANTHROPIC_API_KEY` | Optional: enables "Draft with Claude" for study ideas (model `claude-opus-5-5`, override with `IDEA_AGENT_MODEL`). Without it, the deterministic templates are used |
| `SYNTHETIC_DATA=true` | Watermarks PDFs as synthetic |
| `CORS_ORIGINS`, `WEB_DIST_DIR`, `PORT` | Hosting |

Send hospital data to Claude only after the hospital approves the provider, the data boundary and the processing location (Handoff §5 step 7, §8). The drafter receives only the aggregate statistics of one confirmed gap.
