# Study workbench and the hospital report cycle

The hospital uploads patient-level Excel sheets into its workspace. InnovaStat works on them inside the workspace. An analyst (or the Claude agent) proposes each step, and the assigned InnovaStat statistician confirms it. The hospital sees nothing of this work until InnovaStat releases a report.

```
Hospital (data steward, coordinator, director)            InnovaStat (analyst, statistician)
──────────────────────────────────────────────            ─────────────────────────────────────────
upload Excel/CSV ─────────────────────────────▶ identifiers removed, record numbers pseudonymised
(sees a receipt only)                           1 data dictionary        agent/rules propose → statistician confirms
                                                2 cleaning + split       code runs           → statistician confirms
                                                3 hypotheses (discovery) rules/agent propose → statistician confirms each
                                                4 analysis plan          template/agent      → statistician locks (hash)
                                                5 result (validation)    code runs           → another statistician accepts
                                                6 research idea          template/agent      → statistician confirms
Gaps & Ideas report ◀─────────────────────────── report drafted → second statistician approves → released (PDF)
director approves or declines each idea ──────▶ approved idea becomes an idea + a study (project) in the hospital
study proceeds: protocol, ethics and data approvals, milestones
Results report ◀───────────────────────────────── accepted results → approved → released
director approves or returns ─────────────────▶ manuscript drafted (template or agent) → approved by another person
manuscript ◀───────────────────────────────────── sent; appears as a study output for submission tracking
director accepts or requests changes
```

## Who does what

| Role | In the workbench |
|---|---|
| InnovaStat analyst (`innovastat_analyst`) | Uploads or receives datasets, runs the agent or rules for each step, edits proposals, drafts plans, runs analyses, drafts reports and manuscripts, releases approved reports |
| InnovaStat statistician (`innovastat_reviewer`) | Confirms the dictionary, cleaning, hypotheses and plans (only the assigned statistician, when one is assigned), accepts results run by someone else, confirms proposals, approves reports and manuscripts written by someone else |
| Hospital data steward or coordinator | Uploads Excel and sees an upload receipt |
| Research director (or hospital admin) | Reads released reports, approves or declines each suggested study, approves or returns results, accepts manuscripts |

## Data protection on upload

- **Before anything is stored:** columns whose header names a direct identifier (name, phone, mobile, email, address, national ID, passport, iqama, including common Arabic headers) are dropped. So are columns whose values look like emails, 14-digit Egyptian or 10-digit Saudi national IDs, or phone numbers. The upload response and the dataset record list each dropped column and the reason.
- A patient record number column (MRN, file number, and similar) is replaced with a keyed pseudonym (HMAC-SHA-256 with `DEID_KEY` and the workspace ID). The same patient gets the same pseudonym within a workspace, so duplicates can still be detected.
- Dates are kept, because the studies need intervals such as length of stay. The dictionary step can drop more columns by marking them `identifier` or `ignore`.
- **The agent never receives patient rows.** It sees column profiles (type, missing and distinct counts, numeric ranges, and value lists only for low-cardinality, non-identifying columns, each value seen at least the workspace's small-cell threshold times), cleaning summaries, discovery-half screening statistics, locked plans and result tables.

## Methods

| Step | What happens |
|---|---|
| Dictionary | Each column gets a role (patient_id, identifier, age, sex, admission and discharge dates, diagnosis, exposure, outcome, time_to_event, cost, los, covariate, ignore), a type, "yes" and "no" values for binary columns, and missing-value codes. Checks: binary columns list both values; cost, los, age and time are numeric; a column that looks identifying must be marked identifier |
| Cleaning | Types are parsed (numbers with thousands separators; dates as ISO, day/month/year or Excel serials); missing codes are applied; values outside the dictionary are recorded as invalid with examples; implausible values (age outside 0–120, negative cost, stay or time) are set missing; length of stay is derived from the dates; duplicates are removed by patient and admission date |
| Split | Patients are assigned to a discovery half or a validation half by a seeded hash of the pseudonym. A patient's admissions stay together, and the split is reproducible |
| Hypotheses (discovery half only) | Within each common diagnosis: every management option is compared with the most common one, for each binary outcome (two proportions) and each continuous outcome (Welch t); Benjamini–Hochberg q < 0.10. Cost-effectiveness candidates arise when mean costs differ by 10% or more (the more costly option is framed as the intervention). Burden hypotheses cover the commonest diagnoses. The agent may add hypotheses that use only known variables and only numbers present in its input |
| Plan | Population filters, exposure (intervention vs reference), outcome (binary, continuous with optional log scale, or time-to-event), covariates, method, optional economic block, split = validation, alpha. Covariates measured after the exposure (outcomes, cost, stay, discharge or event dates) are refused. Locking stores a SHA-256 of the plan; a locked plan cannot change, and only locked plans run |
| Result | Table 1 with standardised mean differences; crude effect (risk difference and ratio, Welch mean difference, or Kaplan–Meier medians with log-rank); adjusted effect from logistic regression (OR), linear regression (difference, or ratio of geometric means on the log scale) or Cox regression (HR, Breslow ties); or inverse-probability weighting (stabilised weights truncated at the 1st and 99th percentiles, weighted model with HC0 robust SEs, balance before and after, effective sample size) |
| Economics | Hospital perspective. Arm means of cost and of the event avoided (IPTW-weighted when the method is IPTW); incremental cost and effect with 1,000 seeded bootstrap replicates resampled within arm (95% percentile intervals); ICER; dominance; share of replicates in each quadrant of the cost-effectiveness plane; cost-effectiveness acceptability curve at the hospital's willingness-to-pay thresholds, or by default at multiples of the reference arm's mean cost |
| Interpretation | A deterministic template; or the agent, accepted only if every number it states appears in the result. A statistician may edit it, under the same number check |

The statistics are validated against statsmodels 0.15 and lifelines 0.30 (`test/models.test.ts`, fixture made by `scripts/make-model-fixture.py`): logistic regression, weighted logistic with HC0 SEs, OLS, weighted least squares with HC0 SEs, Cox regression, the Welch t test and the log-rank test all agree to 1e-6.

## The agent

`src/studies/agent.ts` uses `claude-opus-5-5` (override with `STUDY_AGENT_MODEL`) with structured JSON output and server-side refusal fallback. It has five tasks: dictionary, hypotheses, plan, interpretation and manuscript. Each output is:

1. checked against a schema;
2. checked for meaning (known columns and variables, no post-exposure covariates, only numbers present in its input);
3. used only if both checks pass. Otherwise the rule or template result is used, and the reasons are returned to the analyst.

Every call is logged in `agent_call` (task, model, accepted, problems, tokens). When a reply is turned down, what Claude returned is kept in `rejected_output`, so a statistician can see what was rejected and why: `GET /v1/workspaces/{ws}/studies/agent-calls?rejected=true` lists recent calls and `GET …/studies/agent-calls/{id}` returns one with its rejected output (InnovaStat roles only; the hospital never sees it). Without `INNOVA_ANTHROPIC_API_KEY` the agent buttons are disabled and the rules and templates run.

The number check exempts only the "p < 0.001" threshold and SHA hash names (such as SHA-256). `npm run dev:agent-check` runs the live model through the whole cycle and prints the sentence around each number it rejected.

## Limitations

- One sheet per upload. Joining several sheets (admissions, labs, costs) is not built yet.
- Time-to-event outcomes need a numeric time column. Deriving time from dates is limited to length of stay.
- IPTW is available for binary and continuous outcomes, not for Cox models.
- The economic evaluation is a within-hospital, trial-like comparison. It has no QALYs, discounting or long-term model; those belong in the study the hospital approves.
- Patient-level data in the workspace must be covered by the hospital's data-sharing agreement and ethics approval (Egypt PDPL 151/2020; KSA PDPL), and so must any use of the agent.
