// SYNTHETIC patient-level workbook for demos and tests. Every value is
// generated; names, national IDs and phone numbers are fake and exist only so
// the de-identification step has something to remove. Planted effects:
//   AMI: primary PCI lowers mortality vs thrombolysis, at higher cost;
//   sepsis: a bundle within 1 hour lowers mortality;
//   heart failure: guideline therapy lowers 30-day readmission.
// Older and sicker patients more often get the less aggressive option
// (confounding by indication), so crude and adjusted estimates differ.
import ExcelJS from "exceljs";
import { prng } from "../stats/models.ts";

const FIRST = ["Ahmed", "Mohamed", "Fatma", "Mona", "Omar", "Sara", "Youssef", "Nour", "Khaled", "Hana", "Ali", "Aya"];
const LAST = ["Hassan", "Ibrahim", "Mahmoud", "Saleh", "Farouk", "Nabil", "Adel", "Samir"];

export async function syntheticWorkbook(n = 2400, seed = 7): Promise<Buffer> {
  const r = prng(seed);
  const norm = () => { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Admissions");
  ws.addRow(["SYNTHETIC DATA – InnovaHospital demonstration workbook"]);
  ws.addRow(["Patient Name", "National ID", "Mobile", "MRN", "Age", "Sex", "Admission Date", "Discharge Date", "Diagnosis", "Treatment",
    "Diabetes", "Hypertension", "Severity Score", "Died", "Readmitted 30 days", "Complication", "Total Cost (EGP)"]);
  for (let i = 0; i < n; i++) {
    const u = r();
    const diagnosis = u < 0.4 ? "Acute myocardial infarction" : u < 0.7 ? "Sepsis" : "Heart failure";
    const age = Math.round(Math.max(25, Math.min(95, 62 + 13 * norm())));
    const sex = r() < 0.58 ? "Male" : "Female";
    const diabetes = r() < 0.35 ? "Yes" : "No", htn = r() < 0.5 ? "Yes" : "No";
    const severity = Math.round(Math.max(0, Math.min(10, 4 + 2 * norm() + (age - 62) / 15)) * 10) / 10;
    const logit = (x: number) => 1 / (1 + Math.exp(-x));
    const sick = (age - 62) / 10 + (severity - 4) / 2;
    let treatment: string, mort: number, readm: number, comp: number, los: number, cost: number;
    if (diagnosis === "Acute myocardial infarction") {
      const pci = r() < logit(0.8 - 0.6 * sick); treatment = pci ? "Primary PCI" : "Thrombolysis";
      mort = logit(-3.0 + 0.6 * sick + (pci ? -0.8 : 0)); readm = logit(-2.3 + 0.2 * sick); comp = logit(-2.2 + 0.3 * sick + (pci ? 0.1 : 0.3));
      los = 4 + 1.2 * sick + (pci ? -0.5 : 1); cost = (pci ? 90000 : 32000) + 6000 * sick;
    } else if (diagnosis === "Sepsis") {
      const early = r() < logit(0.3 - 0.4 * sick); treatment = early ? "Bundle within 1 hour" : "Delayed bundle";
      mort = logit(-1.4 + 0.6 * sick + (early ? -0.6 : 0)); readm = logit(-2.0 + 0.1 * sick); comp = logit(-1.2 + 0.3 * sick + (early ? -0.3 : 0));
      los = 9 + 2 * sick + (early ? -1.5 : 0); cost = 45000 + 7000 * sick + (early ? 3000 : 6000);
    } else {
      const gdmt = r() < logit(0.4 - 0.3 * sick); treatment = gdmt ? "Guideline-directed therapy" : "Standard care";
      mort = logit(-2.8 + 0.5 * sick); readm = logit(-1.2 + 0.3 * sick + (gdmt ? -0.7 : 0)); comp = logit(-2.4 + 0.2 * sick);
      los = 6 + 1.5 * sick; cost = (gdmt ? 26000 : 21000) + 4000 * sick;
    }
    if (diabetes === "Yes") { mort *= 1.15; cost *= 1.08; }
    const died = r() < mort, admit = new Date(Date.UTC(2025, 0, 1) + Math.floor(r() * 640) * 86400000);
    const stay = Math.max(1, Math.round(los * (0.6 + 0.8 * r())));
    const discharge = new Date(admit.getTime() + stay * 86400000);
    ws.addRow([`${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}`,
      String(29000000000000 + Math.floor(r() * 999999999999)), `01${Math.floor(100000000 + r() * 899999999)}`, `MRN-${100000 + i}`,
      age, sex, admit, discharge, diagnosis, treatment, diabetes, htn, severity,
      died ? "Yes" : "No", died ? "" : r() < readm ? "Yes" : "No", r() < comp ? "Yes" : "No", Math.round(cost * (0.75 + 0.5 * r()))]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
