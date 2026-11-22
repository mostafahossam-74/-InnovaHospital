# InnovaHospital

Hospital research office and outcomes research by InnovaStat CRO.

**The research cycle** (details in [docs/STUDIES.md](docs/STUDIES.md)):

1. The hospital uploads patient-level Excel sheets to its workspace. Names, phone and ID numbers are removed on upload, and record numbers are pseudonymised.
2. Inside the workspace, InnovaStat works through the data. An analyst or the Claude agent proposes each step, and the assigned statistician confirms it: data dictionary → cleaning and a random discovery/validation split → hypotheses screened on the discovery half → analysis plans locked before running → results on the held-out half, including cost-effectiveness → research ideas. **None of this is visible to the hospital.**
3. InnovaStat releases a **Gaps & Research Ideas report**. The research director approves or declines each suggested study; an approved idea becomes an ongoing study in the hospital's portfolio.
4. When results are ready, InnovaStat releases a **Results report**. After the hospital approves it, InnovaStat writes the **manuscript**, which a second person approves before it is sent.

The hospital-side research office from the developer package also runs here: clinician idea intake and triage, studies with ethics and data-approval gates, milestones, outputs, quality indicators, training, partnerships and the executive report, for the months the coordinator chooses. A second, aggregate route analyses monthly totals for disease burden, management outcomes, health economics and hospital parameters ([docs/ANALYTICS.md](docs/ANALYTICS.md)).

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

Tests (each test file creates its own database; GitHub Actions runs them, the type checks and the web build on every pull request and push to `main`, see `.github/workflows/test.yml`):

```bash
npm test          # 71 tests: statistics validated against statsmodels, analytics, API and study-cycle acceptance checks against PostgreSQL
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
| Research director | Approves or declines suggested studies and results, accepts manuscripts, triages ideas, defines indicators, releases executive reports |
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

## Scheduler

`npm run start:worker` runs the scheduler next to the API, with the same `DATABASE_URL`. Every minute it runs the governance expiry sweep once per local day in each hospital's timezone, putting active projects whose approvals have lapsed on hold, and sends due notifications.

Reports are not drafted automatically: hospitals send data when they have it, and a coordinator drafts a report for the months they choose (see "Executive reports").

Jobs are kept in `scheduled_job`, one per hospital, kind and day, so each runs once even with several workers. A job and its effects commit in one transaction. A failing job is rolled back and retried after 5, 10, 20 and 40 minutes; after the fifth failure it is marked `failed`, recorded in the audit log and the coordinators are told. Monthly draft jobs queued by an earlier version are closed without drafting.

## Executive reports

Data is entered per month; a report covers any range of months the coordinator chooses, up to 36 (`POST /report-runs` with `period_start` and `period_end`, or `period` for one month). Each department's indicator is the sum of its months, reported as missing, unverified or returned if any month is. The report key is `YYYY-MM` or `YYYY-MM_YYYY-MM`; a new draft of the same months is a new revision.

Disclosure control (`src/reports/disclosure.ts`):

- a department's figure is suppressed when its events or non-events are below the hospital's threshold (default 5);
- the hospital-wide total is withheld while a department is pending, and suppressed when its own count is small or when subtracting the shown departments would reveal a small count;
- ranges can overlap reports already released (January–March released, then January–April). A figure is hidden when, combined with released reports, it would let a reader work out a small count for some departments and months — April alone, for example. The check uses the figures as published, and any linear combination of them, not only one subtraction;
- approval and release re-check the stored report and refuse with `disclosure_risk`; a report released in the meantime makes a draft stale (`inputs_changed`), so it is rebuilt against it.

### Notifications

Events queue a notice in the same transaction, one per recipient, and the worker emails them on each pass:

| Event | Who is told |
|---|---|
| A report is drafted | InnovaStat reviewers (research directors if there are none), not the author |
| A report is approved | Research directors, who release it |
| A report is returned | Its author (the coordinators, for a draft made by an earlier version's scheduler) |
| A project is put on hold | Its PI and the coordinators for its department |
| A scheduled job fails for good | Coordinators |

An email says what needs doing and links to the portal; it never contains report figures or governance details. The address is looked up when the email is sent, from the person's active membership, so revoked access stops further mail and a member without an address is skipped. A failed send is retried after 5, 10, 20 and 40 minutes, then marked failed. Delivery is at least once: a crash between sending and recording can repeat one email, never lose one. Notices are kept in `notification`.

Only the `log` transport exists until an email provider is chosen; a provider plugs in behind the `Mailer` interface in `src/notifications.ts`.

## Database migrations

`npm run db:migrate` applies the files in `db/migrations/` that a database has not had yet, in order, each in its own transaction, and records them in `schema_migration`. Run it on every deploy, before the API starts, with the owner's connection:

```bash
MIGRATION_DATABASE_URL='postgres://owner:…@host:5432/innovahospital' npm run db:migrate
```

- Re-running is safe: it prints "Up to date." when there is nothing to apply.
- `--status` lists applied and pending files without changing anything.
- A database set up by hand before the runner existed has no records, so the runner refuses to start. Run it once with the last file the database already has, for example `--baseline=002_studies.sql`; it records the files up to that one without running them, then applies the rest.
- It stops if an applied file has been edited since. Add a new migration instead of changing an old one.

`npm run dev:db` and the tests use the same runner.

## Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | `ih_web` role connection string |
| `MIGRATION_DATABASE_URL` | Database owner's connection string, used only by `npm run db:migrate`. Never give it to the API |
| `AUTH_MODE` | `oidc` (default) or `local` (built-in email/password accounts, `LOCAL_AUTH_SECRET`) |
| `OIDC_ISSUER`, `OIDC_AUDIENCE` | Hospital-approved identity provider |
| `OBJECT_STORE_DIR` | Private write-once storage for released PDFs (swap for an object store in production) |
| `INNOVA_ANTHROPIC_API_KEY` | Optional: enables the Claude study agent (dictionary, hypotheses, plans, interpretation, manuscript) and idea drafting (model `claude-opus-5-5`; override with `STUDY_AGENT_MODEL` / `IDEA_AGENT_MODEL`). Without it, rules and templates run |
| `DEID_KEY` | Secret for patient-ID pseudonyms (32+ random bytes). Required in production |
| `SYNTHETIC_DATA=true` | Watermarks PDFs as synthetic |
| `CORS_ORIGINS`, `WEB_DIST_DIR`, `PORT` | Hosting |
| `SCHEDULER_INTERVAL_SECONDS` | How often the scheduler worker checks for due jobs (default 60) |
| `MAIL_TRANSPORT` | How the worker sends notification email. Only `log` exists for now (writes each email to the log, sends nothing); required in production |
| `APP_BASE_URL` | The portal's origin, for the sign-in links in emails, e.g. `https://research.hospital.example`; required in production |

The agent never receives patient rows, only column profiles, summaries and result tables. Even so, enable it for a hospital only after the hospital approves the provider and the processing location.
