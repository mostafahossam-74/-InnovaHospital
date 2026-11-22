# InnovaHospital Research and Outcomes Hub

**Developer handoff | InnovaStat CRO | 5 November 2026**

## 1. Product and business model

InnovaHospital helps a hospital establish and operate a research department. It gives clinicians a place to propose research, gives the research office a way to manage studies from feasibility to dissemination, and gives leadership a monthly view of outputs, approved quality indicators, capability gaps and decisions requiring attention. InnovaStat can deliver a managed service alongside the software, including department setup, training, methods support, biostatistics and manuscript development. The hospital owns institutional governance, data access, investigator responsibilities, approvals and decisions about external release.

Start with one hospital research team and its agreed specialties. Egypt and Saudi Arabia are the initial commercial focus. The pilot uses research metadata and approved aggregate indicators. Identifiable patient records, direct EHR integration, patient-level research datasets and clinical decision support are outside pilot scope. The prototype illustrates Cardiology, Intensive Care and Oncology, with a dashboard, opportunity pipeline, projects, outcomes, publications, partnerships and a Monthly Executive Report Agent.

Commercial packages below are proposed structures. Fees, capacity and any outcome-linked terms belong in the hospital agreement.

| Package | Commercial unit | Deliverables |
|---|---|---|
| Department setup | One-time implementation fee | Readiness assessment, governance map, roles and SOPs, forms, KPI catalog, portfolio import and launch training |
| Hub subscription | Annual or monthly institutional fee | Workspace, agreed seats and sites, software support, reporting and exports |
| Managed research office | Monthly retainer with capacity limits | Coordination, feasibility and protocol consultations, training sessions and report review |
| Specialist delivery | Per milestone or scoped project | Biostatistics, research synthesis, RWE methods, writing or grant support |
| Eligible sponsored work | Separately contracted fee or share | Defined scope, eligible revenue, attribution, cost base, finance approval and audit |

Track qualified opportunities, committed contract value, invoiced amounts and cash collected separately. Use an agreed currency, exchange-rate basis and reporting month. Treat grants, sponsored studies and potential partnerships as pipeline opportunities until the corresponding status is documented. Use capacity, turnaround and verified deliverables for performance metrics. Hospital finance approves the definition of attributable net contribution.

## 2. Features and delivery order

| Module | Pilot | Later or separately scoped |
|---|---|---|
| Research office setup | Hospital/site/department hierarchy, role assignments, readiness checklist, operating plan, onboarding and KPI baseline | Multi-site rollout, enterprise SSO provisioning and cross-site benchmarking |
| Idea intake and opportunities | Clinical question intake, feasibility triage, prioritization, owner, next action and project conversion | Sponsor matching, grant alerts and external applications |
| Project portfolio | Milestones, tasks, blockers, owners, stage, timeline, status and project access | Full trial operations, monitoring, eTMF, eConsent and recruitment |
| Governance tracker | Record official ethics and data decisions, applicable route, versions, expiry, amendments and holds | Integration with institutional approval systems |
| Quality and outcomes | Versioned indicator definitions, aggregate input, review, missing flags, target comparison and disclosure controls | Separately approved data pipelines and patient-level analytics |
| Training | Needs assessment, courses, cohort enrollment, attendance, assessments and completion | LMS integration and credential verification |
| Publications and outputs | Track protocol, SAP, analysis, manuscript, abstract, poster, submission and publication milestones | Journal or institutional repository integration |
| Partnerships | Track sponsor, grant or collaboration opportunity, owner, stage, action and approved valuation | Contract execution, finance integration and configurable revenue accounting |
| Executive reporting | Monthly report agent, department views, risks, decisions, next 30-day actions, review, PDF and archive | Multi-site comparison and configurable report packs |
| AI assistance | Deterministic report drafting and editable commentary | Optional model-assisted narrative after review of provider and data controls |

## 3. Actors and access

| Role | Default scope and actions |
|---|---|
| Platform administrator | Provision tenants and technical settings. Client data access requires a separate approved and logged grant. |
| Hospital administrator | Manage approved hospital settings, roles, departments and subscriptions. |
| Research director | Approve priorities, review portfolio and release executive reports. |
| Department lead | View department projects, assign work within grant, review aggregate completeness. |
| Principal investigator | Create proposals, submit versions, manage assigned projects and record outputs. |
| Coordinator | Triage, schedule, track milestones, prepare reports and follow missing inputs. |
| Governance recorder | Record authoritative decision evidence, scope and expiry. Keep institutional authority separate from app role. |
| Quality data steward | Submit aggregate values for assigned definitions and department. |
| InnovaStat reviewer | Review authorized projects, verify inputs, approve report revisions within grant. |
| Training manager | Manage cohort, enrollment, attendance and completion within assigned scope. |
| Executive reader | View released summaries and downloads for explicitly permitted scopes. |
| Service identity | Run scheduled jobs, create drafts or deliver approved notices within defined permissions. |

Authorization combines verified identity, tenant membership, permission, department or project grant, and object state. Each list, count, file download, search and export applies the same rules. Outside staff receive explicit, time-limited project or department access. Revoke access when a project or agreement ends. Leadership visibility and reviewer access are separate grants. Quality input verification and executive release should use distinct actors. Record all consequential actions in the audit trail.

## 4. Workflow and governance

1. **Configure the office.** Register legal organization, sites, departments, governance authorities and reviewer roles. Agree the annual research plan, staffing, training needs, indicator definitions and who can approve each step.
2. **Submit a concept.** The investigator adds a research question, design, population description, proposed sources, team, feasibility assumptions and intended output. The coordinator checks completeness, overlap and priority.
3. **Assess feasibility.** Document aggregate cohort estimates, time, expertise, data owner and funding. A data owner can provide an aggregate feasibility count through the hospital's approved route. The research office accepts, returns, defers or rejects with rationale.
4. **Confirm the governance route.** Identify the applicable institutional authority and decision type for each study. Classify research, QI, audit and reviews through the approved institutional route. Attach or link the official decision record using permitted files. Track ethics and data decisions independently, by protocol version and permitted sites, purposes and period.
5. **Activate and execute.** Require current documented decisions for all configured gates. An authorized institutional exemption or documented determination may satisfy its specific gate if the hospital's policy permits. Assign milestones, owners and due dates. Store progress metadata and approved outputs.
6. **Manage amendments and expiry.** Create a new protocol version for material scope changes. Track new decisions and amendments. Mark the project on hold for relevant revoked, expired or mismatched approvals and enforce validity again on each gated operation. Resume only after valid decisions match the working version.
7. **Review and disseminate.** Track SAP, analysis QC, report, manuscript, authorship and submission status. Release an output only after its required scientific and institutional review. Record publisher identifiers and external submission dates. Track publication separately from submission.
8. **Close and learn.** Record final status, evidence of deliverables, closeout date, unresolved risks, retention schedule and lessons. Training and partnership actions can continue independently.

| Object | State sequence |
|---|---|
| Opportunity | new → triaged → feasibility → accepted, deferred or rejected → converted |
| Project | draft → submitted → feasibility → governance → active → complete → archived. Active ↔ on hold only with an authorized actor and valid resumption gates. |
| Decision | pending → recorded approved, denied or institutional determination → expired, revoked or superseded |
| Metric | expected → submitted → verified, returned or suppressed for a specific release. Editing creates a new version requiring verification. |
| Report | draft → in review → returned or approved → published → superseded or withdrawn |
| Output | planned → in progress → QC → approved → submitted or released → accepted or published as applicable |
| Training | planned → enrolled → attended → assessed → completed or incomplete |
| Partnership | lead → qualified → proposal → contracting → signed → active → closed or lost |

## 5. Monthly Executive Report Agent

Proposed cadence is the first business-approved calendar schedule after month-end, default day 1 at 09:00 in the workspace timezone. Store timezone, calendar configuration, cutoff and UTC execution instant. The month key identifies the covered month. Use separate idempotent jobs per workspace and report period. Generate department and executive views from approved scopes. The local example runs manually.

1. Freeze period inputs at cutoff. Query expected indicators, submitted versions, verification state, applicable metric definitions and policy. Also collect workflow events, due milestones, outputs, training and partnership status.
2. Mark missing, unverified, not applicable and suppressed values separately. Preserve the difference between zero eligible cases and missing data. Include source method, owner and period internally. Display trends only when definitions and periods are comparable.
3. Calculate rates in code from verified counts. Use exact unrounded values for target tests. Sum like-for-like approved numerators and denominators for pooled rates only after checking compatible definitions, populations, duplicate counting, and disclosure risk. Use direction and scope-specific thresholds from the active definition.
4. Apply cell suppression to numerator and complement where applicable. Review cross-table, cross-period and department-to-executive differencing risk. Omit sensitive aggregates where a safe release cannot be demonstrated. The sample threshold of 5 is illustrative and does not establish a hospital policy.
5. Generate sections for executive summary, department updates, research funnel, quality indicators, outputs, training, partnerships, risks, decisions and a 30-day action list. Each action gets owner, due date and status. Link statements to internal metric or event versions.
6. Require InnovaStat or hospital review and separate release authority. Report input edits after snapshot creation require a new revision under the approved cutoff policy. Corrections retain previous versions and clearly label the current release. Notify via an authenticated portal link.
7. Use optional model drafting only on an approved, sanitized snapshot. Validate citations and factual numbers against the snapshot. Require human review, log model and prompt versions, and retain a deterministic template fallback. The agent does not make clinical, governance or funding decisions.

### KPI definitions

| KPI | Computation and report rule |
|---|---|
| Eligible proposals reviewed | Distinct in-scope proposals with completed triage decision in the period |
| Triage turnaround | Median days from first submission to first triage decision, with eligible count |
| Active portfolio | Distinct projects active at cutoff. Label separately from projects activated during the month. |
| Milestone on-time rate | Due milestones completed by their approved due date divided by eligible milestones due in the period. Show unresolved overdue count. |
| Analysis and manuscripts completed | Distinct QC-approved outputs of the corresponding type during the period |
| Submission and publication | Distinct output milestones with separately recorded journal submission, acceptance or publication date |
| Training completion | Eligible enrolled people meeting configured attendance and assessment rules divided by eligible enrolled people |
| Quality indicator | Verified numerator divided by eligible denominator under the same approved definition version |
| Partnership pipeline | Count and value by stage, currency and observation date. Finance-verified actuals shown separately. |
| Indicator completeness | Verified and applicable inputs divided by expected and applicable inputs. Show missing/unverified categories separately. |

## 6. Forms and field dictionary

An asterisk indicates required at the named step. The server assigns IDs, versions, timestamps and audit actors. Use UUIDs, ISO country/currency codes, IANA timezones, UTC timestamps and local calendar periods. Normalize labels, constrain lengths and validate IDs against the tenant. Define enums, nullable states and conditional rules in versioned schemas.

| Entity | Fields and validation |
|---|---|
| Hospital workspace | legal/display name*, slug*, country*, timezone*, locale*, sponsor*, research director*, status*, reporting cadence, reporting cutoff, calendar, privacy contact, retention policy version, branding |
| Site and department | workspace*, parent site where applicable, code*, name*, service line, lead, active flag, reporting inclusion, default steward |
| Membership and grant | identity issuer* and subject*, verified work email*, role*, workspace*, permitted departments/projects, grant start/end, invitation and revocation events, sponsor |
| Office readiness | assessment date*, assessor*, governance, staffing, systems, data access, training, finance and publication readiness, evidence reference, priority, owner, target completion |
| Idea intake | title*, department*, PI*, research question*, rationale*, design*, expected population and data sources*, primary outcome, comparator, sites, estimated period, approximate aggregate volume, collaborators, conflict disclosures, requested outputs |
| Feasibility | concept*, reviewer*, decision*, reason*, staffing, methods risks, aggregate cohort estimate and assumptions, data owner, funding, resources, timeline, next step and due date |
| Project | source concept, title*, PI*, sponsor, department*, sites*, study type*, protocol version*, target dates, study objective, stage, visibility, tags, funded amount/currency, reporting owner, hold or closeout reason |
| Protocol and SAP | project*, document type*, version*, author*, checksum and approved storage reference*, status, approval events, supersedes ID, amendment reason |
| Governance decision | project*, authority*, decision kind*, decision*, official reference*, effective and expiry dates, applicable protocol version*, sites and permitted scope*, decision evidence reference*, recorder*, recorded date, revocation reason |
| Data access record | project*, dataset category*, data owner*, permitted purpose*, environment*, access role*, authorization reference*, effective and expiry dates, export restrictions, recheck or revocation status. Keep dataset contents outside the pilot. |
| Milestone or task | project*, title*, owner*, due date*, state*, dependency IDs, completion criteria, completed date, linked output, blocker, escalation |
| Indicator definition | code*, name*, category*, scope*, effective version*, numerator and denominator definitions*, inclusion/exclusion rules*, units*, direction*, target and threshold, reporting grain*, source method*, data steward*, disclosure policy*, comparator compatibility |
| Indicator observation | definition version*, department/site*, month*, numerator and denominator or approved scalar*, attestation*, evidence reference, input version*, verification decision/actor/time, override reason, suppression reason |
| Risk or decision | workspace*, linked project or period, risk statement*, owner*, likelihood, impact, mitigation, decision needed, decision authority, target date*, status and resolution |
| Training course/cohort | title*, competencies*, facilitator*, start/end*, method*, capacity, assessment and attendance thresholds, language, completion rule version |
| Training enrollment | cohort*, member*, enrollment state*, attendance events, score, completion date, certificate reference, reviewer |
| Output/publication | project*, type*, title*, lead author or owner*, version, contribution records, journal or venue, submission/acceptance/publication dates, DOI or registration ID, embargo, approvals, release visibility |
| Partnership | organization*, opportunity type*, stage*, owner*, purpose*, next action/date, funding source, amount/currency, confidence, conflict check, agreement reference, signature/close dates and finance reconciliation status |
| Report revision | workspace*, scope*, month*, version*, config version*, input versions*, structured summary, limitations, action list, status, author*, reviewer, publisher, approval/release times, snapshot and artifact hashes, supersession reference |
| Audit event | tenant*, actor*, action*, entity type and ID*, UTC timestamp*, request ID, reason, status and sanitized field changes |
| Job/notification | workspace*, period and scope*, job kind*, idempotency key*, attempt, next run, lease token/expiry, status, safe diagnostics, report revision, authorized recipients, provider ref |

## 7. Screens and navigation

| Screen | Developer requirements |
|---|---|
| Executive dashboard | Period and department filters, funnel, milestone exceptions, outputs, training and approved indicator tiles. Each KPI shows its definition, period and status. |
| Research office setup | Departments, personnel, grant scopes, data policies, report schedule, branding and activation checklist |
| Idea intake and opportunity board | Save draft, submit, request revisions, assign reviewer, prioritize and convert atomically |
| Project detail | Timeline, milestone list, protocol versions, decisions, status history, team, outputs and blockers |
| Governance queue | Required decisions, amendments and expiry warnings. Show authoritative references and approved scope. |
| Indicator workspace | Expected inputs, numeric validation, verification, suppression preview and comparable trends |
| Training | Course catalog, cohort roster, attendance, assessment and completion dashboard |
| Publications and partnerships | Search, filter, owner, stage, due date, linked project and release state |
| Monthly report center | Period setup, missing inputs, per-department and executive preview, revision diff, review, release, PDF and archive |
| Operations and audit | Tenant settings, jobs, delivery retries, permission changes and approved export audit |

Support English and Arabic with RTL layout and language-neutral IDs. Pilot terminology and translations require hospital sign-off. Use keyboard-friendly forms and status labels that do not rely on color. The earlier [InnovaHospital prototype](https://innovahospital-prototype.karawya-nuh.chatgpt.site) required authentication when checked. Its source is not included in this package.

## 8. Engineering design

The recommended pilot implementation uses a web frontend and API, a relational database, background scheduler, private object storage, and hospital-approved identity. The included reference uses Python and SQLite for portability. It demonstrates isolation, state gates, aggregate reporting and revision release. The reference's demo actors are inputs to local methods. Production identity must come from a verified session or service token, with permissions rechecked at request and job execution time.

Keep stable IDs and tenant-scoped composite foreign keys. A production PostgreSQL implementation can use row-level security as an additional control. Use a least-privilege role and establish tenant context only after membership verification. Test background workers and support accounts against the same isolation boundaries. In production, use transactional idempotency keys for concept conversion and publish, a version precondition for edits, immutable approved snapshots, and an outbox for notices. Use a uniqueness constraint on current report per workspace/scope/period. Private artifact reads require authorization and audit.

For monthly jobs, a scheduler enumerates due workspaces and resolves each local reporting period. Queue a unique job for workspace, scope, month and run type. Acquire jobs via a lease with a new fencing token. Retry transient failures with backoff. Enqueue the same scope after restart, retaining cutoff and configuration versions. Publish updates the approved release pointer and notification outbox together. Use a recovery job for orphan artifact cleanup. A separate expiry job flags holds while each write gate independently validates current approval.

### API map

Base path is `/v1/workspaces/{workspaceId}`. Use cursor pagination, explicit scope filters, typed validation and stable errors. Map unauthenticated requests to 401, insufficient role to 403, inaccessible resources to 404, stale revisions to 409, and invalid inputs to 422. Include correlation IDs. Use idempotency keys for create and release actions that may be retried.

| Route | Input and behavior |
|---|---|
| GET/PATCH /settings | Workspace configuration, version, reporting schedule and policy references |
| GET/POST /departments and /memberships | Create department or authorized grant, validate workspace scope |
| GET/POST /ideas | List scoped ideas or save title, PI, department, question, design and data-source description |
| POST /ideas/{id}/triage | Decision, reason, priority, reviewer, next action, expected version |
| POST /ideas/{id}/convert | Expected version, project fields and idempotency key |
| GET/POST /projects | Filter by department, stage and owner or create within scope |
| POST /projects/{id}/transition | target, expected_version, reason, protocol_version. Validate governance and actor. |
| POST /projects/{id}/decisions | Authority, reference, effective dates, permitted scope, protocol version, decision |
| GET/POST/PATCH /projects/{id}/milestones | Owner, deadline, dependency, status and version |
| GET/POST /indicator-definitions | Definition version, unit, eligibility, direction, policy and effective date |
| PUT /indicators/{department}/{period}/{code} | Counts or approved scalar, definition version, evidence ref and expected version |
| POST /indicators/{id}/verify | Decision, expected version, note and attestation |
| GET/POST /training/cohorts and /outputs and /partnerships | Scoped CRUD and workflow events for each module |
| POST /report-runs | Scope, month, cutoff override with reason and idempotency key. Return job ID. |
| POST /reports/{id}/approve | Expected version, digest, approval or return and reviewer note |
| POST /reports/{id}/publish | Approved digest, idempotency key and release scope |
| GET /reports/{id}/download | Verify membership and release scope, audit and return authorized PDF |
| GET /audit | Restricted event retrieval by time, entity and actor |

Example metric input

```json
{"definition_version":1,"numerator":32,"denominator":40,"evidence_reference":"AGG-CARD-2026-10","expected_version":2}
```

Example project transition

```json
{"target":"active","expected_version":4,"protocol_version":2,"reason":"Applicable clearances verified"}
```

### Deployment configuration

Configure DATABASE_URL, verified OIDC issuer/client, session secret, public base URL, object store bucket and region, worker identity, scheduler, verified mail sender and secret storage. Keep a separate staging environment. Turn on audit retention, restore tests, dependency scanning and incident response. Restrict uploads to permitted metadata documents with classification and scanning. Enforce the hospital's approved data boundary on exports, backups, notifications, logs and any AI provider.

Hospital governance and legal teams must approve the data inventory, vendor terms, roles, permitted processing location and transfer arrangements, access controls, retention and applicable research review route before live deployment. Use the official Egypt and Saudi references below for jurisdictional review. Workflow states in the app record institutional decisions. The scope and validity of those decisions come from the authorized institution.

## 9. Build order and acceptance tests

| Step | Build | Acceptance |
|---|---|---|
| 1 | Set up repository and staging. Run reference and recover authorized prototype assets if available. | Local synthetic demo completes with published JSON and PDF. |
| 2 | Implement identity, workspace/department grants and audit. | Cross-tenant IDs, files, lists, filters and background jobs fail to disclose or modify other tenants. |
| 3 | Build onboarding and intake forms, project transition API and review queue. | Draft returns preserve history. Repeated conversion creates one project. Stale writes conflict. |
| 4 | Add governance records, expiry, revocation, protocol versions and release gates. | Expired, revoked, mismatched or missing decisions block activation and other gated actions. Authorized amendment triggers review. |
| 5 | Add milestones, training, outputs and partnership registers. | Defined owners, statuses, due dates and KPI source events are reproducible. |
| 6 | Implement aggregate indicators, verification and disclosure policy. | Missing, zero, unverified, suppressed and valid values remain distinct. Cross-view differencing cases are tested. |
| 7 | Build scheduler and reporting. | Repeated runs produce one logical job. Monthly cutoff, timezones and retry are tested. |
| 8 | Add publication, private PDF, archive and notification. | Edited inputs invalidate stale approvals. Unauthorized downloads fail. Corrections supersede old releases and preserve history. |
| 9 | Run one hospital pilot. | Review workflow and metrics with hospital stakeholders, validate PDF/Arabic layout, measure review time and document operating handover. |

Proposed rollout assumes one hospital team, one period of synthetic rehearsal and one approved live reporting cycle before adding departments or integrations. Before go-live, verify the operating agreement, roles, KPI definitions, source access, document policy, and emergency pause process.

## 10. Included implementation and verification boundary

The package provides an executable local reference for study intake, portfolio transitions, ethics and data clearance, aggregate metric entry and review, suppression, executive reporting, approvals and release. It includes SQLite DDL, report contracts, tests, a sample PDF and synthetic setup steps. The web frontend, deployment identity, production database migration, scheduled worker, file storage, email and extended modules require implementation. The source code of the protected existing prototype was unavailable for this handoff.

### Official references for deployment review

- [Egypt State Information Service notice on Personal Data Protection Law No. 151 of 2020](https://sis.gov.eg/ar/%D8%A7%D9%84%D8%B1%D8%A6%D8%A7%D8%B3%D8%A9/%D8%B4%D8%A6%D9%88%D9%86-%D8%AF%D8%A7%D8%AE%D9%84%D9%8A%D8%A9/%D8%A7%D9%84%D9%82%D8%B1%D8%A7%D8%B1%D8%A7%D8%AA-%D8%A7%D9%84%D8%B1%D8%A6%D8%A7%D8%B3%D9%8A%D8%A9/%D8%A7%D9%84%D8%B1%D8%A6%D9%8A%D8%B3-%D8%A7%D9%84%D8%B3%D9%8A%D8%B3%D9%89%D9%8A-%D9%8A-%D8%B5%D8%AF-%D9%82-%D8%B9%D9%84%D9%89-%D9%82%D8%A7%D9%86%D9%88%D9%86-%D8%AD%D9%85%D8%A7%D9%8A%D8%A9-%D8%A7%D9%84%D8%A8%D9%8A%D8%A7%D9%86%D8%A7%D8%AA-%D8%A7%D9%84%D8%B4%D8%AE%D8%B5%D9%8A%D8%A9/)
- [Egyptian Drug Authority clinical medical research laws and executive regulations](https://www.edaegypt.gov.eg/en/about-us/eda-stakeholders/the-supreme-council-for-review-of-ethics-clinical-medical-research/laws-and-executive-regulations/)
- [SDAIA Personal Data Protection Law English text](https://sdaia.gov.sa/en/SDAIA/about/Documents/Personal%20Data%20English%20V2-23April2023-%20Reviewed-.pdf)
