import unittest
from datetime import date
from hospital import Hub, Rejected


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.hub = Hub(":memory:", today=lambda: date(2026, 11, 5))
        self.addCleanup(self.hub.close)
        self.hub.seed()

    def project(self):
        return self.hub.create_project("demo", "pi", "cardio", "Readmission study", "retrospective")

    def clearance(self, project, expires="2027-10-31"):
        self.hub.record_clearance("demo", "governance", project, "ethics", "approved", "REC-DEMO", expires)
        self.hub.record_clearance("demo", "governance", project, "data", "approved", "DATA-DEMO", expires)

    def test_happy_path_and_audit(self):
        p = self.project()
        self.assertEqual(self.hub.transition("demo", "pi", p, "submitted", 1), 2)
        self.hub.transition("demo", "coordinator", p, "feasibility", 2)
        self.hub.transition("demo", "coordinator", p, "governance", 3)
        self.clearance(p)
        self.hub.transition("demo", "coordinator", p, "active", 4)
        self.assertEqual(self.hub.projects("demo", "director")[0]["stage"], "active")

    def test_role_and_tenant(self):
        p = self.project()
        with self.assertRaises(Rejected):
            self.hub.transition("other", "pi", p, "submitted", 1)
        with self.assertRaises(Rejected):
            self.hub.transition("demo", "director", p, "submitted", 1)
        self.assertEqual(self.hub.projects("other", "pi"), [])

    def test_stale_and_expired_gate(self):
        p = self.project()
        self.hub.transition("demo", "pi", p, "submitted", 1)
        with self.assertRaises(Rejected):
            self.hub.transition("demo", "coordinator", p, "feasibility", 1)
        self.hub.transition("demo", "coordinator", p, "feasibility", 2)
        self.hub.transition("demo", "coordinator", p, "governance", 3)
        self.clearance(p, "2026-11-04")
        with self.assertRaises(Rejected):
            self.hub.transition("demo", "coordinator", p, "active", 4)

    def test_department_scope(self):
        self.project()
        self.assertEqual(self.hub.projects("demo", "icu_pi"), [])
        with self.assertRaises(Rejected):
            self.hub.create_project("demo", "icu_pi", "cardio", "Wrong department", "retrospective")

    def test_report_gaps_and_small_cells(self):
        self.hub.submit_metric("demo", "pi", "cardio", "2026-10", "followup", 2, 12)
        with self.assertRaises(Rejected):
            self.hub.submit_metric("demo", "pi", "cardio", "2026-10", "followup", 9, 8)
        draft = self.hub.draft_report("demo", "coordinator", "2026-10")
        self.assertEqual(draft["snapshot"]["metrics"][0]["status"], "unverified")
        self.hub.verify_metric("demo", "reviewer", "cardio", "2026-10", "followup")
        draft = self.hub.draft_report("demo", "coordinator", "2026-10")
        by_dep = {m["department"]: m for m in draft["snapshot"]["metrics"]}
        self.assertEqual(by_dep["cardio"]["status"], "suppressed")
        self.assertNotIn("numerator", by_dep["cardio"])
        self.assertEqual(by_dep["icu"]["status"], "missing")

    def test_release_requires_fresh_review(self):
        r = self.hub.draft_report("demo", "coordinator", "2026-10")
        with self.assertRaises(Rejected):
            self.hub.publish("demo", "director", r["id"], r["digest"])
        with self.assertRaises(Rejected):
            self.hub.approve("demo", "reviewer", r["id"], "bad")
        self.hub.approve("demo", "reviewer", r["id"], r["digest"])
        self.hub.submit_metric("demo", "pi", "cardio", "2026-10", "followup", 10, 20)
        with self.assertRaises(Rejected):
            self.hub.publish("demo", "director", r["id"], r["digest"])
        r2 = self.hub.draft_report("demo", "coordinator", "2026-10")
        self.hub.approve("demo", "reviewer", r2["id"], r2["digest"])
        self.hub.publish("demo", "director", r2["id"], r2["digest"])
        self.assertEqual(self.hub.released("demo", "director", "2026-10")["id"], r2["id"])

    def test_clearance_revocation_holds_project(self):
        p = self.project()
        for version, target in enumerate(("submitted", "feasibility", "governance"), 1):
            self.hub.transition("demo", "coordinator", p, target, version)
        self.clearance(p)
        self.hub.transition("demo", "coordinator", p, "active", 4)
        self.hub.record_clearance("demo", "governance", p, "data", "revoked", "REVOKE-DEMO", None)
        self.assertEqual(self.hub.projects("demo", "director")[0]["stage"], "on_hold")


if __name__ == "__main__":
    unittest.main()
