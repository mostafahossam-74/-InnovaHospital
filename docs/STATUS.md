# Status against the handoff build order (Developer_Handoff.md §9)

| Step | State | Notes |
|---|---|---|
| 1. Repository, staging, reference | Done locally | The Python reference and contracts are in `reference/` and `contracts/`. The local synthetic demo completes with a released JSON snapshot and PDF (`npm run dev:seed`, `docs/sample-executive-report.pdf`). No staging environment yet. The protected prototype's source was not available. |
| 2. Identity, grants, audit | Done (API) | OIDC bearer tokens or built-in accounts. Department-scoped role grants with end dates, resolved on every request. Row-level security on every tenant table. Append-only audit. Tests: cross-tenant lists, reads, downloads and direct SQL. |
| 3. Intake, transitions, review queue | Done | Ideas with history (returns keep it), triage with a reason and priority, idempotent atomic conversion, optimistic concurrency (409 on stale writes). |
| 4. Governance | Done | Ethics and data decisions per protocol version, with expiry, revocation and supersession. Activation is gated. Revocation, expiry and amendment put an active project on hold, and gated writes recheck validity. Expiry sweep: `POST /governance/expiry-check`. |
| 5. Milestones, training, outputs, partnerships | Done (pilot depth) | Training is tracked per cohort (enrolled and completed counts). Per-person enrollment and attendance are not built yet. |
| 6. Indicators and disclosure | Done | Versioned definitions, values re-verified after every edit, verifier ≠ submitter. Missing, zero, unverified, returned and suppressed stay distinct. Cross-view differencing checks are still open. |
| **+ Hospital-data analytics** | Done | Verified aggregate uploads, the analytics engine, the gap register, and ideas from gaps (`docs/ANALYTICS.md`). |
| 7. Scheduler | Not started | Reports are drafted on demand, idempotently per request key. A scheduled worker (lease, fencing, retry) as in InnovaEvidence's `src/scheduler.ts` and `src/worker.ts` is the next step. The expiry sweep endpoint is ready for it to call. |
| 8. Publication, PDF, archive, notification | Mostly done | Release needs a reviewed digest. Inputs that changed invalidate approval. Released PDFs are write-once and hash-checked. Readers see released revisions only. Superseding and withdrawal work. Email notification (outbox) is not built yet. |
| 9. Pilot | Not started | Needs the hospital's approved indicator definitions, thresholds, Arabic terminology sign-off and governance review. |

## Open decisions for InnovaStat and the hospital

- Thresholds: disclosure cell size (default 5), minimum patients per arm (30), FDR level (0.05), high-burden share (5%).
- Who may see analyses: currently all research-office staff of the hospital. Department-scoped analysis views can be added if department leads should see only their own departments.
- Whether Claude drafting may be enabled, and under which data-processing terms.
- Arabic translations beyond navigation labels: RTL layout is in place, but the terminology needs hospital sign-off.
- Hosting: deploy as InnovaEvidence does (single Ubuntu server or Render). The deploy scripts are not yet adapted.
