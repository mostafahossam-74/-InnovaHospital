# Local reference walkthrough

Use Python 3.10 or later. From this directory:

```bash
python -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python -m unittest -v
python demo.py --out out
```

Open out/sample_executive_report.pdf and out/released_report.json. The walkthrough starts an in-memory database, creates two synthetic hospital workspaces, takes one cardiology study through activation, verifies a 32/40 aggregate observation, flags the absent ICU input, and publishes the approved snapshot. It uses distinct coordinator, reviewer and director actors. The test suite runs with the Python standard library. ReportLab is needed only for PDF export.

Files:

- hospital.py implements the reference service and transaction boundaries.
- schema.sql is executed automatically when a database is opened.
- demo.py shows the service calls and exports a PDF from the released record.
- test_hospital.py checks tenant and department scope, clearances, concurrency preconditions, indicator privacy and report release.

This is a local workflow reference. Use synthetic data only. Actor strings are demo fixtures and must be replaced by authenticated identities in production. The example records a narrow pair of governance decisions, supports a single rate metric per synthetic department and makes an executive report. Production work includes versioned protocol-specific decisions, multi-grant access, automatic expiry handling, a cutoff-aware event history, department reports and the remaining modules in the developer handoff.
