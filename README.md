# InnovaHospital

Hospital research office and outcomes research by InnovaStat CRO.

**The research cycle** (details in [docs/STUDIES.md](docs/STUDIES.md)):

1. The hospital uploads patient-level Excel sheets to its workspace. Names, phone and ID numbers are removed on upload, and record numbers are pseudonymised.
2. Inside the workspace, InnovaStat works through the data. An analyst or the Claude agent proposes each step, and the assigned statistician confirms it: data dictionary → cleaning and a random discovery/validation split → hypotheses screened on the discovery half → analysis plans locked before running → results on the held-out half, including cost-effectiveness → research ideas. **None of this is visible to the hospital.**
3. InnovaStat releases a **Gaps & Research Ideas report**. The research director approves or declines each suggested study; an approved idea becomes an ongoing study in the hospital's portfolio.
4. When results are ready, InnovaStat releases a **Results report**. After the hospital approves it, InnovaStat writes the **manuscript**, which a second person approves before it is sent.

The hospital-side research office from the developer package also runs here: clinician idea intake and triage, studies with ethics and data-approval gates, milestones, outputs, quality indicators, training, partnerships and the monthly executive report. A second, aggregate route analyses monthly totals for disease burden, management outcomes, health economics and hospital parameters ([docs/ANALYTICS.md](docs/ANALYTICS.md)).

Stack: Node 22 TypeScript API, PostgreSQL 16 with row-level security per hospital, React + Vite web app, the same as InnovaEvidence.

> Use synthetic data until each hospital's data-sharing agreement, ethics approval and data-protection review cover patient-level uploads (Egypt PDPL 151/2020, KSA PDPL), and approve any use of the Claude agent.

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

Sign in as any demo user. InnovaStat: `analyst`, `statistician`, `statistician2`. Hospital: `director`, `coordinator`, `steward`, `pi` (Cardiology), `icu_pi` (Intensive Care), `governance`, `admin`, `exec` (executive reader). Platform: `platform-admin`.

The seed does the following:
- uploads a synthetic 2,400-patient Excel workbook (with fake names and IDs, to show they are removed) and takes it through every confirmed step;
- releases a Gaps & Ideas report with four suggested studies; the director approves the sepsis study, and the other three wait for a decision;
- releases the sepsis results report, which the director approves, and sends the manuscript;
- also loads 12 months of aggregate data and releases the October executive report.

`docs/sample-gaps-ideas-report.pdf` and `docs/sample-executive-report.pdf` are released reports from the seed.

Live check of the Claude study agent (needs `INNOVA_ANTHROPIC_API_KEY` set before `npm run dev:api`): `npm run dev:agent-check` runs the same cycle with every step through the agent and prints, for each call, whether its output passed validation or fell back to the rules.

Tests (each test file creates its own database):

```bash
npm test          # 37 tests: statistics validated against statsmodels, analytics, API and study-cycle acceptance checks against PostgreSQL
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
| InnovaStat analyst | Runs the study workbench and aggregate analyses, drafts ideas, reports and manuscripts, releases approved reports |
| InnovaStat statistician (`innovastat_reviewer`) | Confirms each workbench step, accepts results run by others, confirms gaps and proposals, approves reports and manuscripts written by others |
| Hospital administrator | Settings, departments, role grants |
| Research director | Approves or declines suggested studies and results, accepts manuscripts, triages ideas, defines indicators, releases monthly reports |
| Research coordinator | Run analyses, triage and convert ideas, move projects, draft reports |
| Data steward | Uploads study Excel and monthly totals, enters indicator values (for granted departments) |
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
| `db/migrations/002_studies.sql`, `src/api-studies.ts` | Study workbench, proposals, client reports, manuscripts, InnovaStat roles |
| `src/studies/` | Excel parsing, de-identification, dictionary, cleaning, hypothesis screening, agent, reports, synthetic workbook |
| `src/stats/` | Regression models (validated against statsmodels) and the study runner with IPTW and bootstrapped cost-effectiveness |
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
| `INNOVA_ANTHROPIC_API_KEY` | Optional: enables the Claude study agent (dictionary, hypotheses, plans, interpretation, manuscript) and idea drafting (model `claude-opus-5-5`; override with `STUDY_AGENT_MODEL` / `IDEA_AGENT_MODEL`). Without it, rules and templates run |
| `DEID_KEY` | Secret for patient-ID pseudonyms (32+ random bytes). Required in production |
| `SYNTHETIC_DATA=true` | Watermarks PDFs as synthetic |
| `CORS_ORIGINS`, `WEB_DIST_DIR`, `PORT` | Hosting |

The agent never receives patient rows, only column profiles, summaries and result tables. Even so, enable it for a hospital only after the hospital approves the provider and the processing location.
