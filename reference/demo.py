"""Run a complete synthetic workflow and export the published report."""
import argparse
from datetime import date
import json
from pathlib import Path
from xml.sax.saxutils import escape

import reportlab
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from hospital import Hub


def export_pdf(released, target):
    report = released["snapshot"]
    fonts = Path(reportlab.__file__).parent / "fonts"
    pdfmetrics.registerFont(TTFont("Vera", str(fonts / "Vera.ttf")))
    pdfmetrics.registerFont(TTFont("VeraBold", str(fonts / "VeraBd.ttf")))
    styles = getSampleStyleSheet()
    styles["Title"].fontName = "VeraBold"
    styles["Heading2"].fontName = "VeraBold"
    styles["BodyText"].fontName = "Vera"
    story = []

    def line(value, style="BodyText"):
        story.append(Paragraph(escape(value), styles[style]))

    line("InnovaHospital Executive Report", "Title")
    line(f"Demo Hospital | {report['period']} | Revision {released['revision']}")
    line("SYNTHETIC DEMONSTRATION  •  RELEASED")
    story.append(Spacer(1, 12))
    line("Portfolio at report generation", "Heading2")
    for item in report["portfolio_current"]:
        line(f"{item['stage'].title()}: {item['projects']} project(s)")
    line("Department indicators", "Heading2")
    rows = [["Department", "Indicator", "Status", "Value", "Target"]]
    names = {"cardio": "Cardiology", "icu": "Intensive Care"}
    for item in report["metrics"]:
        valid = item["status"] == "verified"
        status = "Verified" if valid else item["status"].replace("_", " ").capitalize()
        rows.append([names[item["department"]], item["label"], status,
                     f"{item['percent']:g}%" if valid else "—",
                     f"{item['target_percent']:g}%" if valid else "—"])
    table = Table(rows, colWidths=[93, 135, 72, 53, 52], repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Vera"),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#17434B")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.HexColor("#EAF3F3"), colors.white]),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    story.append(table)
    line("Review and next actions", "Heading2")
    for action in report["proposed_actions"]:
        line(f"{names[action['department']]} — {action['action']}")
    line("Scope and limitations", "Heading2")
    line("This report uses synthetic project metadata and aggregate observations. Missing or unverified inputs are omitted from target comparisons.")
    SimpleDocTemplate(str(target), title="InnovaHospital Executive Report").build(story)


def run_demo():
    hub = Hub(":memory:", today=lambda: date(2026, 11, 5))
    try:
        hub.seed()
        project = hub.create_project("demo", "pi", "cardio", "Synthetic readmission study", "retrospective")
        for version, target in enumerate(("submitted", "feasibility", "governance"), 1):
            hub.transition("demo", "coordinator", project, target, version)
        for kind in ("ethics", "data"):
            hub.record_clearance("demo", "governance", project, kind, "approved", "DEMO-" + kind, "2027-01-31")
        hub.transition("demo", "coordinator", project, "active", 4)
        hub.submit_metric("demo", "pi", "cardio", "2026-10", "followup", 32, 40)
        hub.verify_metric("demo", "reviewer", "cardio", "2026-10", "followup")
        draft = hub.draft_report("demo", "coordinator", "2026-10")
        hub.approve("demo", "reviewer", draft["id"], draft["digest"])
        hub.publish("demo", "director", draft["id"], draft["digest"])
        return hub.released("demo", "director", "2026-10")
    finally:
        hub.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("out"))
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    result = run_demo()
    (args.out / "released_report.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    export_pdf(result, args.out / "sample_executive_report.pdf")
