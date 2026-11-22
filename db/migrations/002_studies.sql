-- Patient-level study workbench (InnovaStat-internal) and the hospital-facing
-- report cycle:
--   hospital uploads Excel → agent + statistician-confirmed steps (dictionary,
--   cleaning, hypotheses, locked plans, results) → Gaps & Ideas report →
--   hospital approves ideas → studies → results report → hospital approves →
--   manuscript.
-- Internal objects are visible only to InnovaStat roles until released.

-- InnovaStat analyst runs the agent; innovastat_reviewer is the statistician.
ALTER TABLE membership DROP CONSTRAINT membership_role_check;
ALTER TABLE membership ADD CONSTRAINT membership_role_check CHECK (role IN ('hospital_admin','research_director','department_lead',
  'investigator','coordinator','governance_recorder','data_steward','innovastat_reviewer','innovastat_analyst','executive_reader'));

CREATE TABLE study_dataset (
  workspace_id uuid NOT NULL REFERENCES workspace, id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  description text,
  file_name text NOT NULL, file_sha256 text NOT NULL, sheet_name text NOT NULL, sheets text[] NOT NULL,
  row_count int NOT NULL CHECK (row_count > 0),
  headers text[] NOT NULL,
  profile jsonb NOT NULL,            -- column profiles after de-identification
  deid_report jsonb NOT NULL,
  statistician text,                 -- assigned InnovaStat statistician (confirms each step)
  dictionary jsonb, dictionary_origin text, dictionary_status text CHECK (dictionary_status IN ('proposed','confirmed')),
  dictionary_confirmed_by text, dictionary_confirmed_at timestamptz,
  cleaning_report jsonb, cleaning_status text CHECK (cleaning_status IN ('proposed','confirmed')),
  cleaning_confirmed_by text, cleaning_confirmed_at timestamptz,
  variables jsonb,
  split_seed int NOT NULL DEFAULT 20261122, discovery_fraction numeric NOT NULL DEFAULT 0.5 CHECK (discovery_fraction BETWEEN 0.2 AND 0.8),
  stage text NOT NULL DEFAULT 'uploaded' CHECK (stage IN ('uploaded','dictionary','cleaning','hypotheses','analysis','archived')),
  uploaded_by text NOT NULL,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, department_id) REFERENCES department
);

-- Rows after upload-time de-identification (raw) and after confirmed cleaning (clean).
CREATE TABLE dataset_row (
  workspace_id uuid NOT NULL, dataset_id uuid NOT NULL, row_no int NOT NULL,
  raw jsonb NOT NULL, clean jsonb,
  PRIMARY KEY (workspace_id, dataset_id, row_no),
  FOREIGN KEY (workspace_id, dataset_id) REFERENCES study_dataset
);

CREATE TABLE study_hypothesis (
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL,
  hypothesis_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('comparative','economic','burden')),
  study_category text NOT NULL,
  title text NOT NULL, statement text NOT NULL,
  variables jsonb NOT NULL, screening jsonb NOT NULL, priority numeric NOT NULL,
  origin text NOT NULL CHECK (origin IN ('rules','claude','manual')),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed','rejected')),
  created_by text NOT NULL, decided_by text, decided_at timestamptz, decision_reason text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id), UNIQUE (workspace_id, dataset_id, hypothesis_key),
  FOREIGN KEY (workspace_id, dataset_id) REFERENCES study_dataset
);

-- A plan is locked (frozen, hashed) by the statistician before it may run.
CREATE TABLE analysis_plan (
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  hypothesis_id uuid NOT NULL, dataset_id uuid NOT NULL,
  plan jsonb NOT NULL, justification text, origin text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','locked','superseded')),
  sha256 text, created_by text NOT NULL, locked_by text, locked_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, hypothesis_id) REFERENCES study_hypothesis,
  FOREIGN KEY (workspace_id, dataset_id) REFERENCES study_dataset,
  CHECK (status = 'draft' OR (sha256 IS NOT NULL AND locked_by IS NOT NULL))
);

CREATE TABLE study_result (
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL, hypothesis_id uuid NOT NULL, dataset_id uuid NOT NULL,
  project_id uuid,
  results jsonb NOT NULL, sha256 text NOT NULL, plan_sha256 text NOT NULL,
  interpretation text NOT NULL, interpretation_origin text NOT NULL,
  status text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','accepted','returned')),
  run_by text NOT NULL, reviewed_by text, reviewed_at timestamptz, review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, plan_id) REFERENCES analysis_plan,
  FOREIGN KEY (workspace_id, project_id) REFERENCES project,
  CHECK (reviewed_by IS NULL OR reviewed_by <> run_by)
);
CREATE TRIGGER study_result_rows_frozen BEFORE DELETE ON study_result FOR EACH ROW EXECUTE FUNCTION data_rows_frozen();

-- Every agent call, kept for review and cost tracking.
CREATE TABLE agent_call (
  workspace_id uuid NOT NULL REFERENCES workspace, id uuid NOT NULL DEFAULT gen_random_uuid(),
  task text NOT NULL, subject_id uuid, model text NOT NULL,
  accepted boolean NOT NULL, problems text[] NOT NULL,
  input_tokens int, output_tokens int,
  requested_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

-- A suggested research idea: internal until released in a Gaps & Ideas report,
-- then decided by the hospital.
CREATE TABLE proposal (
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  dataset_id uuid, hypothesis_id uuid, result_id uuid, gap_id uuid,
  department_id uuid,
  title text NOT NULL, concept jsonb NOT NULL, evidence jsonb NOT NULL,
  study_category text NOT NULL, priority numeric NOT NULL DEFAULT 0,
  origin text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','released','approved','declined','withdrawn')),
  created_by text NOT NULL, confirmed_by text, confirmed_at timestamptz,
  report_id uuid,
  hospital_decided_by text, hospital_decided_at timestamptz, hospital_reason text,
  idea_id uuid, project_id uuid,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, hypothesis_id) REFERENCES study_hypothesis,
  FOREIGN KEY (workspace_id, result_id) REFERENCES study_result,
  FOREIGN KEY (workspace_id, gap_id) REFERENCES research_gap,
  FOREIGN KEY (workspace_id, department_id) REFERENCES department,
  FOREIGN KEY (workspace_id, project_id) REFERENCES project
);

-- Reports sent to the hospital: Gaps & Ideas, and study Results.
CREATE TABLE client_report (
  workspace_id uuid NOT NULL REFERENCES workspace, id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('gaps_ideas','results')),
  project_id uuid, dataset_id uuid,
  title text NOT NULL, revision int NOT NULL,
  snapshot jsonb NOT NULL, digest text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','returned','released','hospital_approved','hospital_returned','superseded','withdrawn')),
  author text NOT NULL,
  approver text, approved_at timestamptz, review_note text,
  released_by text, released_at timestamptz,
  hospital_decided_by text, hospital_decided_at timestamptz, hospital_note text,
  artifact_key text, artifact_sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES project,
  FOREIGN KEY (workspace_id, dataset_id) REFERENCES study_dataset,
  CHECK (approver IS NULL OR approver <> author)
);
ALTER TABLE proposal ADD FOREIGN KEY (workspace_id, report_id) REFERENCES client_report;

CREATE TABLE manuscript (
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL, results_report_id uuid NOT NULL,
  version int NOT NULL DEFAULT 1,
  sections jsonb NOT NULL, origin text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sent','hospital_accepted','hospital_returned')),
  author text NOT NULL, approved_by text, approved_at timestamptz,
  sent_by text, sent_at timestamptz, hospital_decided_by text, hospital_note text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES project,
  FOREIGN KEY (workspace_id, results_report_id) REFERENCES client_report,
  CHECK (approved_by IS NULL OR approved_by <> author)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['study_dataset','dataset_row','study_hypothesis','analysis_plan','study_result','agent_call','proposal','client_report','manuscript'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid) WITH CHECK (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON study_dataset, dataset_row, study_hypothesis, analysis_plan, study_result, proposal, client_report, manuscript TO ih_web;
GRANT SELECT, INSERT ON agent_call TO ih_web;
