"""Local, synthetic-data reference for the InnovaHospital workflow."""
from contextlib import contextmanager
from datetime import date
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from uuid import uuid4


class Rejected(ValueError):
    """An invalid request, forbidden action or workflow conflict."""


STAGES = {
    "draft": {"submitted"},
    "submitted": {"feasibility", "draft"},
    "feasibility": {"governance", "draft"},
    "governance": {"active", "feasibility"},
    "active": {"on_hold", "complete"},
    "on_hold": {"active"},
}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def period_key(period):
    if not re.fullmatch(r"[0-9]{4}-(0[1-9]|1[0-2])", period) or period.startswith("0000"):
        raise Rejected("Use YYYY-MM")
    return period


class Hub:
    def __init__(self, db_path, today=date.today):
        self.db = sqlite3.connect(db_path, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(Path(__file__).with_name("schema.sql").read_text())
        self.today = today

    def close(self):
        self.db.close()

    @contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self.db.rollback()
            raise
        else:
            self.db.commit()

    def seed(self):
        with self.transaction():
            for workspace in ("demo", "other"):
                self.db.execute("INSERT OR IGNORE INTO workspace VALUES (?, ?, 5)",
                                (workspace, f"{workspace.title()} Hospital"))
                self.db.executemany("INSERT OR IGNORE INTO department VALUES (?, ?, ?)",
                                    [(workspace, "cardio", "Cardiology"), (workspace, "icu", "Intensive Care")])
                people = [("pi", "investigator", "cardio"), ("icu_pi", "investigator", "icu"),
                          ("coordinator", "coordinator", None), ("governance", "governance", None),
                          ("reviewer", "reviewer", None), ("director", "director", None)]
                self.db.executemany("INSERT OR IGNORE INTO member VALUES (?, ?, ?, ?)",
                                    [(workspace, *person) for person in people])
                self.db.execute("INSERT OR IGNORE INTO metric_definition VALUES (?, ?, ?, ?)",
                                (workspace, "followup", "Follow-up completion", 8000))

    def member(self, ws, actor, roles=None, department=None):
        row = self.db.execute("SELECT * FROM member WHERE workspace=? AND actor=?", (ws, actor)).fetchone()
        if (row is None or (roles and row["role"] not in roles)
                or (department and row["department"] not in (None, department))):
            raise Rejected("Action forbidden")
        return row

    def log(self, ws, actor, action, entity, details):
        self.db.execute("INSERT INTO audit (workspace,actor,action,entity,detail) VALUES (?,?,?,?,?)",
                        (ws, actor, action, entity, canonical(details)))

    def create_project(self, ws, actor, department, title, design):
        title = title.strip()
        if not title or len(title) > 200 or design not in {"retrospective", "prospective", "review", "quality"}:
            raise Rejected("Invalid title or design")
        with self.transaction():
            self.member(ws, actor, {"investigator"}, department)
            project = str(uuid4())
            self.db.execute("INSERT INTO project VALUES (?,?,?,?,?,'draft',1,?)",
                            (ws, project, department, title, design, actor))
            self.log(ws, actor, "project.created", project, {"stage": "draft"})
        return project

    def projects(self, ws, actor):
        person = self.member(ws, actor)
        rows = self.db.execute("""SELECT id, department, title, design, stage, version FROM project
                                  WHERE workspace=? AND (? IS NULL OR owner=?)
                                  ORDER BY id""", (ws, person["department"], actor))
        return [dict(row) for row in rows]

    def project(self, ws, project):
        row = self.db.execute("SELECT * FROM project WHERE workspace=? AND id=?", (ws, project)).fetchone()
        if row is None:
            raise Rejected("Project unavailable")
        return row

    def transition(self, ws, actor, project, target, expected_version):
        with self.transaction():
            row = self.project(ws, project)
            roles = {"coordinator", "investigator"} if target == "submitted" else {"coordinator"}
            person = self.member(ws, actor, roles, row["department"])
            if person["role"] == "investigator" and actor != row["owner"]:
                raise Rejected("Action forbidden")
            if row["version"] != expected_version or target not in STAGES.get(row["stage"], set()):
                raise Rejected("Stale or invalid stage transition")
            if target == "active":
                valid = {r["kind"] for r in self.db.execute(
                    """SELECT kind FROM clearance WHERE workspace=? AND project=? AND decision='approved'
                       AND (expires IS NULL OR expires>=?)""", (ws, project, self.today().isoformat()))}
                if valid != {"ethics", "data"}:
                    raise Rejected("Valid ethics and data clearances are required")
            self.db.execute("UPDATE project SET stage=?,version=version+1 WHERE workspace=? AND id=?",
                            (target, ws, project))
            self.log(ws, actor, "project.stage", project, {"from": row["stage"], "to": target})
            return expected_version + 1

    def record_clearance(self, ws, actor, project, kind, decision, reference, expires):
        reference = reference.strip()
        if kind not in {"ethics", "data"} or decision not in {"approved", "denied", "revoked"} or not reference:
            raise Rejected("Invalid clearance")
        if expires is not None:
            expires = date.fromisoformat(expires).isoformat()
        with self.transaction():
            self.member(ws, actor, {"governance"})
            row = self.project(ws, project)
            self.db.execute("""INSERT INTO clearance VALUES (?,?,?,?,?,?,?)
                ON CONFLICT (workspace,project,kind) DO UPDATE SET
                decision=excluded.decision,reference=excluded.reference,expires=excluded.expires,actor=excluded.actor""",
                            (ws, project, kind, decision, reference, expires, actor))
            self.log(ws, actor, "clearance.recorded", project,
                     {"kind": kind, "decision": decision, "reference": reference, "expires": expires})
            if row["stage"] == "active" and (decision != "approved" or
                    (expires and expires < self.today().isoformat())):
                self.db.execute("UPDATE project SET stage='on_hold',version=version+1 WHERE workspace=? AND id=?",
                                (ws, project))
                self.log(ws, actor, "project.stage", project, {"from": "active", "to": "on_hold"})

    def submit_metric(self, ws, actor, department, period, metric, numerator, denominator):
        period_key(period)
        if type(numerator) is not int or type(denominator) is not int or not 0 <= numerator <= denominator:
            raise Rejected("Invalid counts")
        with self.transaction():
            self.member(ws, actor, {"investigator", "coordinator"}, department)
            self.db.execute("""INSERT INTO metric VALUES (?,?,?,?,?,?,?,NULL)
                ON CONFLICT (workspace,department,period,metric) DO UPDATE SET
                numerator=excluded.numerator,denominator=excluded.denominator,
                submitted_by=excluded.submitted_by,verified_by=NULL""",
                            (ws, department, period, metric, numerator, denominator, actor))
            self.log(ws, actor, "metric.submitted", f"{department}/{period}/{metric}", {})

    def verify_metric(self, ws, actor, department, period, metric):
        with self.transaction():
            self.member(ws, actor, {"reviewer"}, department)
            change = self.db.execute("""UPDATE metric SET verified_by=?
                WHERE workspace=? AND department=? AND period=? AND metric=? AND submitted_by<>?""",
                                     (actor, ws, department, period, metric, actor))
            if change.rowcount != 1:
                raise Rejected("Metric missing or self-review")
            self.log(ws, actor, "metric.verified", f"{department}/{period}/{metric}", {})

    def snapshot(self, ws, period):
        rows = self.db.execute("""SELECT d.id AS department, def.id AS metric, def.label, def.target_bp,
                m.numerator, m.denominator, m.verified_by, w.small_cell
            FROM department d JOIN workspace w ON w.id=d.workspace
            JOIN metric_definition def ON def.workspace=d.workspace
            LEFT JOIN metric m ON m.workspace=d.workspace AND m.department=d.id AND m.metric=def.id AND m.period=?
            WHERE d.workspace=? ORDER BY d.id, def.id""", (period, ws))
        metrics = []
        for row in rows:
            item = {k: row[k] for k in ("department", "metric", "label")}
            n, d = row["numerator"], row["denominator"]
            if n is None:
                item["status"] = "missing"
            elif row["verified_by"] is None:
                item["status"] = "unverified"
            elif d == 0:
                item["status"] = "not_applicable"
            elif min(n, d - n) < row["small_cell"]:
                item["status"] = "suppressed"
            else:
                target = row["target_bp"]
                item.update(status="verified", numerator=n, denominator=d,
                            percent=round(100 * n / d, 2), target_percent=target / 100,
                            meets_target=n * 10000 >= d * target)
            metrics.append(item)
        counts = [dict(row) for row in self.db.execute(
            """SELECT stage, count(*) AS projects FROM project
               WHERE workspace=? GROUP BY stage ORDER BY stage""", (ws,))]
        actions = [{"department": row["department"], "action": "Complete or verify the period input"}
                   for row in metrics if row["status"] in {"missing", "unverified"}]
        return {"period": period, "metrics": metrics, "portfolio_current": counts, "proposed_actions": actions}

    def draft_report(self, ws, actor, period):
        period_key(period)
        with self.transaction():
            self.member(ws, actor, {"coordinator"})
            snapshot = self.snapshot(ws, period)
            encoded = canonical(snapshot)
            digest = hashlib.sha256(encoded.encode()).hexdigest()
            revision = self.db.execute("SELECT coalesce(max(revision),0)+1 FROM report WHERE workspace=? AND period=?",
                                       (ws, period)).fetchone()[0]
            report = str(uuid4())
            self.db.execute("INSERT INTO report VALUES (?,?,?,?,?,?,'draft',?,NULL,NULL)",
                            (ws, report, period, revision, encoded, digest, actor))
            self.log(ws, actor, "report.drafted", report, {"revision": revision})
            return {"id": report, "revision": revision, "digest": digest, "snapshot": snapshot}

    def advance_report(self, ws, actor, report, digest, publish):
        with self.transaction():
            self.member(ws, actor, {"director"} if publish else {"reviewer"})
            row = self.db.execute("SELECT * FROM report WHERE workspace=? AND id=?", (ws, report)).fetchone()
            prior = "approved" if publish else "draft"
            if row is None or row["status"] != prior or row["digest"] != digest or row["author"] == actor:
                raise Rejected("Missing report, stale snapshot or invalid review state")
            fresh = canonical(self.snapshot(ws, row["period"]))
            if fresh != row["snapshot"]:
                raise Rejected("Report inputs changed. Draft a new revision.")
            if publish:
                current = self.db.execute("SELECT max(revision) FROM report WHERE workspace=? AND period=? AND status IN ('published','superseded')",
                                          (ws, row["period"])).fetchone()[0]
                if current is not None and current >= row["revision"]:
                    raise Rejected("A newer revision was already released")
                self.db.execute("""UPDATE report SET status='superseded'
                    WHERE workspace=? AND period=? AND status='published'""", (ws, row["period"]))
                self.db.execute("UPDATE report SET status='published',released_by=? WHERE workspace=? AND id=?",
                                (actor, ws, report))
            else:
                self.db.execute("UPDATE report SET status='approved',approved_by=? WHERE workspace=? AND id=?",
                                (actor, ws, report))
            self.log(ws, actor, "report.published" if publish else "report.approved", report, {"digest": digest})

    def approve(self, ws, actor, report, digest):
        self.advance_report(ws, actor, report, digest, False)

    def publish(self, ws, actor, report, digest):
        self.advance_report(ws, actor, report, digest, True)

    def released(self, ws, actor, period):
        self.member(ws, actor, {"director", "reviewer", "coordinator"})
        row = self.db.execute("""SELECT id,revision,digest,snapshot FROM report
                                 WHERE workspace=? AND period=? AND status='published'""", (ws, period)).fetchone()
        if row is None:
            raise Rejected("No released report")
        return dict(row) | {"snapshot": json.loads(row["snapshot"])}
