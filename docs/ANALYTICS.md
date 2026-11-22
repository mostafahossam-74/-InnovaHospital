# Analytics methods

Engine version `ih-analytics-1` (`src/analytics/`). The same input always gives the same output: rows are sorted and values rounded before the result is hashed. Every analysis stores its configuration, the IDs of the uploads it used and a SHA-256 digest of its results. Stored analyses cannot be edited.

## Inputs

Only **verified** uploads are used. For each department-month, the newest verified upload of case data wins, and the same applies to each parameter. Age and sex strata are summed. Outcome fields are optional per cell: a rate's denominator counts only the cells that recorded that outcome, and completeness is reported separately.

## Outputs

| Section | Method |
|---|---|
| Disease burden | Share of all cases per condition, with a Wilson 95% CI. Trend: share in the later half of the months vs the earlier half, as a Poisson rate ratio with a log-normal CI |
| Management and outcomes | Per condition × management: mortality, 30-day readmission and complications (Wilson CIs), mean length of stay, mean cost per case, and share of the condition |
| Comparative outcomes | Each management with at least `min_cases` patients (default 30) against the condition's most common management. Risk difference with Newcombe's hybrid-score CI, risk ratio with a log CI (0.5 continuity correction when a cell is zero), pooled two-proportion z test |
| Health economics | Hospital perspective. Δcost = difference in mean cost per patient. Δeffect = deaths averted per patient (reference mortality minus alternative mortality). Classes: dominant, dominated, more costly and more effective, less costly and less effective. ICER = Δcost / Δeffect in the last two classes. Bed-days difference per patient. Annual budget impact = Δcost × reference patients × 12 / months |
| Department variation | For conditions with at least two departments of `min_cases` patients: chi-square test of homogeneity across departments, and the range |
| Hospital parameters | Spearman correlation between each parameter and each department-month outcome (mortality, readmission, complications, mean stay, mean cost), using department-months with at least 5 cases and at least `min_points` points (default 8). **Within department**: each department's values are centred on its own mean first, so a department with both more staff and sicker patients does not create a spurious association. Fisher-z CI with the Fieller variance 1.06/(n−3) |
| Multiplicity | One Benjamini–Hochberg false-discovery correction across every test in the run (comparisons, variation, associations, trends). Signals need q < `alpha` (default 0.05) |
| Coverage | A condition with at least `high_burden_share` (default 5%) of cases is "high burden". It is covered when a project or open idea carries an ICD-10 code with the same 3-character category |
| Completeness | Department-months observed vs expected, missing months, and the share of cells recording each field |

## Gap rules (`gaps.ts`)

| Gap type | Raised when | Category |
|---|---|---|
| `management_outcome_variation` | A comparison has q < alpha | Clinical effectiveness |
| `cost_effectiveness` | Mean costs differ by at least 10% and the effect on mortality is known | Health economics |
| `department_outcome_variation` | Heterogeneity q < alpha | Quality improvement |
| `parameter_outcome_association` | q < alpha and \|rho\| ≥ 0.3 | Operational |
| `rising_burden` | Share ratio ≥ 1.2 with q < alpha | Epidemiology |
| `high_burden_unstudied` | High burden and no project or idea covers it | Epidemiology |
| `data_completeness` | A field is below 80% complete, or department-months are missing | Operational |

**Priority (0–100)** = 40 × burden (condition share / 10%, capped at 1) + 35 × effect size (risk difference / 10 points, |rho|, log₂ of the share ratio, or cost difference / 30%, each capped at 1) + 25 × evidence (q < 0.001 → 1, < 0.01 → 0.85, < 0.05 → 0.7, otherwise 0.3; 0.4 when no test applies).

Each statement is built from a template filled with the analysis's own numbers. The full statistics are stored with the gap.

## Study ideas (`ideas.ts`)

Each gap type has a deterministic template: title, research question in PICO form, design, population, data sources, primary outcome, comparator, analysis plan, health-economic method and expected output. The templates include propensity-weighted cohorts and target-trial emulation; CHEERS 2022 cost-effectiveness with probabilistic sensitivity analysis and an ISPOR budget-impact analysis; segmented regression; multilevel models with funnel plots; joinpoint regression; and cost-of-illness.

With `INNOVA_ANTHROPIC_API_KEY` set, "Draft with Claude" sends one confirmed gap's statement and statistics to Claude (structured JSON output). The draft is accepted only if it passes the schema and every number in it appears in the gap (common design numbers such as 95, 30 or 2022 are allowed). Otherwise the template is used and the reasons are returned. Either way, the result is a draft idea that the investigator edits and the research office triages.

## Disclosure control in reports

The executive report (for any range of months; data is monthly) suppresses a department's indicator when its numerator or its complement is below the workspace threshold (default 5, set by hospital policy). Missing, unverified, returned, not applicable (zero eligible cases) and suppressed are kept distinct. Target tests use exact integer arithmetic.

The report also gives a hospital-wide rate per indicator, pooled over the reporting departments under the same definition version (`src/reports/disclosure.ts`). It is withheld while any department is missing, unverified or returned (`incomplete`), and suppressed when the total's numerator or complement is below the threshold, or when subtracting the shown departments would leave a remainder whose events or non-events are below it (`differencing`): with one suppressed department the total is always withheld.

Reports cover ranges of months, which can overlap reports already released. Before a figure is shown, it is checked together with every released report (published, superseded or withdrawn) for the same indicator: every block of departments × months that the new figures would make computable — by any linear combination with the released figures, not only one subtraction — is worked out from the figures as published, and a figure is hidden (`overlap`) if any such block has fewer than the threshold of events or non-events. The check covers every group of departments and every set of months when a hospital has up to 7 reporting departments and the reports involved split the months into up to 8 blocks; beyond that it checks single departments, pairs and the whole hospital. Blocks with different months for different departments are not searched. Approval and release re-check the stored snapshot and refuse with `disclosure_risk`; a report released after a draft makes the draft stale, so it is rebuilt against it.

## Limitations to state in every output

- Aggregate, unadjusted associations: they point to questions worth studying and do not estimate causal effects. Case-mix, severity and indication bias are not controlled.
- Costs are means of aggregate sums. Their variance and skew are unknown, so the ICERs have no confidence intervals. That uncertainty is one reason the confirmed gap needs a patient-level study.
- Trends compare halves of the selected window. Coding changes can create apparent trends.
- The thresholds (30 patients per arm, q < 0.05, |rho| ≥ 0.3, 10% cost difference, 5% burden) are defaults. Confirm them with the hospital's methods lead.
