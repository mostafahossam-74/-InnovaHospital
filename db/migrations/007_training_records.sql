-- Per-person training records (Developer_Handoff §6 "Training course/cohort" and
-- "Training enrollment", §4 state sequence planned → enrolled → attended → assessed →
-- completed or incomplete, §5 KPI "Training completion").
--
-- A cohort states its completion rule: the share of its sessions a person must attend and,
-- when an assessment is required, the pass score. A person's completion is decided from that
-- rule once the cohort has ended. The cohort's own enrolled/completed counts remain for
-- cohorts recorded before this, without person records.

-- The training manager role (Handoff §3).
ALTER TABLE membership DROP CONSTRAINT membership_role_check;
ALTER TABLE membership ADD CONSTRAINT membership_role_check CHECK (role IN ('hospital_admin','research_director','department_lead',
  'investigator','coordinator','governance_recorder','data_steward','innovastat_reviewer','innovastat_analyst','executive_reader','training_manager'));

ALTER TABLE training_cohort
  ADD COLUMN department_id uuid,
  ADD COLUMN sessions int NOT NULL DEFAULT 1 CHECK (sessions BETWEEN 1 AND 100),
  ADD COLUMN min_attendance_percent int NOT NULL DEFAULT 80 CHECK (min_attendance_percent BETWEEN 0 AND 100),
  ADD COLUMN assessment_required boolean NOT NULL DEFAULT false,
  ADD COLUMN pass_score int CHECK (pass_score BETWEEN 0 AND 100),
  ADD COLUMN language text NOT NULL DEFAULT 'en' CHECK (language IN ('en','ar')),
  ADD COLUMN completion_rule_version int NOT NULL DEFAULT 1 CHECK (completion_rule_version >= 1),
  ADD CONSTRAINT training_cohort_department_fk FOREIGN KEY (workspace_id, department_id) REFERENCES department,
  ADD CONSTRAINT training_cohort_pass_score CHECK (NOT assessment_required OR pass_score IS NOT NULL);

CREATE TABLE training_enrollment (
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  cohort_id uuid NOT NULL,
  participant_name text NOT NULL CHECK (length(participant_name) BETWEEN 1 AND 200),
  participant_email text CHECK (participant_email IS NULL OR participant_email LIKE '%_@_%'),
  department_id uuid,
  member text,                                   -- issuer|subject when the person has an account
  state text NOT NULL DEFAULT 'enrolled' CHECK (state IN ('enrolled','attended','assessed','completed','incomplete','withdrawn')),
  attended_sessions int[] NOT NULL DEFAULT '{}', -- session numbers 1..cohort.sessions
  score int CHECK (score BETWEEN 0 AND 100),
  completion_date date,
  certificate_reference text CHECK (length(certificate_reference) <= 200),
  reviewer text, decided_at timestamptz, rule_version int,
  version int NOT NULL DEFAULT 1,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, cohort_id) REFERENCES training_cohort,
  FOREIGN KEY (workspace_id, department_id) REFERENCES department,
  CHECK ((state IN ('completed','incomplete')) = (reviewer IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (completion_date IS NULL OR state = 'completed'),
  CHECK (certificate_reference IS NULL OR state = 'completed')
);
CREATE UNIQUE INDEX training_enrollment_email ON training_enrollment (workspace_id, cohort_id, lower(participant_email)) WHERE participant_email IS NOT NULL;
CREATE UNIQUE INDEX training_enrollment_member ON training_enrollment (workspace_id, cohort_id, member) WHERE member IS NOT NULL;

ALTER TABLE training_enrollment ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_enrollment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON training_enrollment
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON training_enrollment TO ih_web;
