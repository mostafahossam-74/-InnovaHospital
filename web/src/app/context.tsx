import { createContext, useContext } from "react";
import type { Api } from "@/lib/api";

export type Role = "hospital_admin" | "research_director" | "department_lead" | "investigator" | "coordinator"
  | "governance_recorder" | "data_steward" | "innovastat_reviewer" | "innovastat_analyst" | "executive_reader";
export const ROLE_LABEL: Record<Role, string> = {
  hospital_admin: "Hospital administrator", research_director: "Research director", department_lead: "Department lead",
  investigator: "Principal investigator", coordinator: "Research coordinator", governance_recorder: "Governance recorder",
  data_steward: "Data steward", innovastat_reviewer: "InnovaStat statistician", innovastat_analyst: "InnovaStat analyst", executive_reader: "Executive reader",
};
export type Grant = { role: Role; department_id: string | null };
export type Me = { issuer: string; subject: string; email: string | null; name: string | null; platform_admin: boolean;
  workspaces: { id: string; name: string; country: string; currency: string; locale: string; roles: Role[]; grants: Grant[] }[] };
export type Settings = { id: string; name: string; slug: string; country: string; timezone: string; locale: string; currency: string;
  small_cell: number; report_day: number; report_hour: number; research_director: string | null; privacy_contact: string | null; version: number };
export type Department = { id: string; code: string; name: string };

export type Ctx = {
  api: Api; me: Me; ws: Settings; wp: string; actor: string;
  roles: Set<Role>; grants: Grant[]; departments: Department[];
  staff: boolean;
  /** InnovaStat analyst or statistician: sees the internal workbench. */
  internal: boolean;
  has: (...roles: Role[]) => boolean;
  /** Departments where one of `roles` is granted. */
  deptsFor: (...roles: Role[]) => Department[];
  go: (view: string, param?: string) => void;
  refreshWorkspace: () => void;
};

export const WorkspaceContext = createContext<Ctx | null>(null);
export function useWs(): Ctx {
  const c = useContext(WorkspaceContext);
  if (!c) throw new Error("useWs outside workspace");
  return c;
}
