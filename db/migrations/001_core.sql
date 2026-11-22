-- InnovaHospital core schema (PostgreSQL 16).
-- Built from docs/Developer_Handoff.md §3-§6 and the SQLite reference in
-- reference/schema.sql, extended with the hospital-data analytics module
-- (aggregate case data, hospital parameters, analysis runs, research gaps).
--
-- Apply as the migration owner. The runtime role ih_web is not the owner, so
-- FORCE ROW LEVEL SECURITY applies to it. Every tenant query runs inside a
-- transaction that sets app.workspace_id after the API has verified
-- membership through the SECURITY DEFINER auth functions below.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Platform level
-- ---------------------------------------------------------------------------
CREATE TABLE workspace (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  slug text UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  timezone text NOT NULL DEFAULT 'Africa/Cairo',
  locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en','ar')),
  currency text NOT NULL DEFAULT 'EGP' CHECK (currency ~ '^[A-Z]{3}$'),
  -- Disclosure control: aggregate cells below this count are suppressed in
  -- released outputs. Illustrative default; the hospital sets its policy.
  small_cell int NOT NULL DEFAULT 5 CHECK (small_cell BETWEEN 1 AND 100),
  report_day int NOT NULL DEFAULT 1 CHECK (report_day BETWEEN 1 AND 28),
  report_hour int NOT NULL DEFAULT 9 CHECK (report_hour BETWEEN 0 AND 23),
  research_director text,
  privacy_contact text,
  active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_admin (
  issuer text NOT NULL, subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject)
);

-- Built-in sign-in (AUTH_MODE=local). Global, not tenant data.
CREATE TABLE local_account (
  subject              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%'),
  display_name         text CHECK (length(display_name) <= 200),
  password_hash        text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT true,
  password_version     integer NOT NULL DEFAULT 1,
  failed_attempts      integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  disabled_at          timestamptz,
  created_by           text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  password_changed_at  timestamptz NOT NULL DEFAULT now(),
  last_login_at        timestamptz
);

-- ---------------------------------------------------------------------------
-- Tenant: organisation and access
-- ---------------------------------------------------------------------------
CREATE TABLE department (
  workspace_id uuid NOT NULL REFERENCES workspace, id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  site text,
  service_line text,
  lead text,
  active boolean NOT NULL DEFAULT true,
  reporting_inclusion boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, code)
);

-- One row per role grant. department_id NULL = all departments.
CREATE TABLE membership (
  workspace_id uuid NOT NULL REFERENCES workspace, id uuid NOT NULL DEFAULT gen_random_uuid(),
  issuer text NOT NULL, subject text NOT NULL,
  role text NOT NULL CHECK (role IN ('hospital_admin','research_director','department_lead','investigator',
    'coordinator','governance_recorder','data_steward','innovastat_reviewer','executive_reader')),
  department_id uuid,
  display_name text, email text,
  grant_start date NOT NULL DEFAULT current_date,
  grant_end date,
  invited_by text,
  active boolean NOT NULL DEFAULT true,
  revoked_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, department_id) REFERENCES department,
  CHECK (grant_end IS NULL OR grant_end >= grant_start)
);
CREATE UNIQUE INDEX membership_grant_unique ON membership
  (workspace_id, issuer, subject, role, coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX membership_identity_idx ON membership (issuer, subject) WHERE active;

-- Append-only audit trail.
CREATE TABLE audit_event (
  workspace_id uuid NOT NULL REFERENCES workspace, seq bigserial,
  actor text NOT NULL, action text NOT NULL,
  entity_type text NOT NULL, entity_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  correlation_id text, reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, seq)
);
CREATE FUNCTION audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_event is append-only'; END $$;
CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_append_only();

-- Retried create/release actions return the first response.
CREATE TABLE idempotency_key (
  workspace_id uuid NOT NULL REFERENCES workspace,
  scope text NOT NULL, key text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, scope, key)
);

-- ---------------------------------------------------------------------------
-- Hospital data: verified aggregate inputs (no patient-level records)
-- ---------------------------------------------------------------------------
CREATE TABLE data_upload (
  workspace_id uuid NOT NULL REFERENCES workspace, id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('case_aggregates','parameters')),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  source_method text NOT NULL CHECK (length(source_method) BETWEEN 1 AND 1000),
  evidence_reference text,
  attestation boolean NOT NULL CHECK (attestation),
  period_from text NOT NULL, period_to text NOT NULL,
  row_count int NOT NULL CHECK (row_count > 0),
  sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','verified','returned','withdrawn')),
  submitted_by text NOT NULL,
  verified_by text, verified_at timestamptz, review_note text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  CHECK (period_from ~ '^\d{4}-(0[1-9]|1[0-2])$' AND period_to ~ '^\d{4}-(0[1-9]|1[0-2])$' AND period_from <= period_to),
  CHECK (status <> 'verified' OR (verified_by IS NOT NULL AND verified_by <> submitted_by))
);

-- One aggregate cell: patients with a condition, managed one way, in one
-- department and month (optionally one age band / sex stratum).
CREATE TABLE case_aggregate (
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  upload_id uuid NOT NULL,
  period text NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  department_id uuid NOT NULL,
  condition_code text NOT NULL CHECK (condition_code ~ '^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$'),
  condition_label text NOT NULL CHECK (length(condition_label) BETWEEN 1 AND 200),
  management text NOT NULL CHECK (length(management) BETWEEN 1 AND 120),
  age_band text NOT NULL DEFAULT 'all' CHECK (length(age_band) BETWEEN 1 AND 20),
  sex text NOT NULL DEFAULT 'all' CHECK (sex IN ('all','female','male')),
  cases int NOT NULL CHECK (cases >= 0),
  deaths int CHECK (deaths >= 0),
  readmissions_30d int CHECK (readmissions_30d >= 0),
  complications int CHECK (complications >= 0),
  los_days_sum numeric CHECK (los_days_sum >= 0),
  cost_sum numeric CHECK (cost_sum >= 0),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, upload_id) REFERENCES data_upload,
  FOREIGN KEY (workspace_id, department_id) REFERENCES department,
  CHECK (deaths IS NULL OR deaths <= cases),
  CHECK (readmissions_30d IS NULL OR readmissions_30d <= cases),
  CHECK (complications IS NULL OR complications <= cases),
  UNIQUE (workspace_id, upload_id, period, department_id, condition_code, management, age_band, sex)
);
CREATE INDEX case_aggregate_period_idx ON case_aggregate (workspace_id, period);

-- Hospital "aspects and parameters" measured per department and month
-- (staffing ratios, bed occupancy, bundle adherence, door-to-balloon time...).
CREATE TABLE parameter_observation (
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  upload_id uuid NOT NULL,
  period text NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  department_id uuid NOT NULL,
  parameter_code text NOT NULL CHECK (parameter_code ~ '^[a-z][a-z0-9_]{1,62}$'),
  parameter_label text NOT NULL CHECK (length(parameter_label) BETWEEN 1 AND 200),
  value numeric NOT NULL,
  unit text,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, upload_id) REFERENCES data_upload,
  FOREIGN KEY (workspace_id, department_id) REFERENCES department,
  UNIQUE (workspace_id, upload_id, period, department_id, parameter_code)
);

-- Rows of an upload are frozen once written.
CREATE FUNCTION data_rows_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'uploaded rows are immutable; submit a new upload'; END $$;
CREATE TRIGGER case_aggregate_frozen BEFORE UPDATE OR DELETE ON case_aggregate FOR EACH ROW EXECUTE FUNCTION data_rows_frozen();
CREATE TRIGGER parameter_observation_frozen BEFORE UPDATE OR DELETE ON parameter_observation FOR EACH ROW EXECUTE FUNCTION data_rows_frozen();

-- A frozen analysis over verified uploads, with its results and digest.
CREATE TABLE analysis_run (
  workspace_id uuid NOT NULL REFERENCES workspace, id uuid NOT NULL DEFAULT gen_random_uuid(),
  period_from text NOT NULL, period_to text NOT NULL,
  department_ids uuid[] NOT NULL,
  upload_ids uuid[] NOT NULL,
  config jsonb NOT NULL,
  engine_version text NOT NULL,
  results jsonb NOT NULL,
  sha256 text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE TRIGGER analysis_run_frozen BEFORE UPDATE OR DELETE ON analysis_run FOR EACH ROW EXECUTE FUNCTION data_rows_frozen();

-- Research gap register: statistical signals found by the engine, confirmed
-- or rejected by a reviewer other than the person who ran the analysis.
CREATE TABLE research_gap (
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  analysis_id uuid NOT NULL,
  gap_key text NOT NULL,
  gap_type text NOT NULL CHECK (gap_type IN ('management_outcome_variation','department_outcome_variation',
    'parameter_outcome_association','cost_effectiveness','rising_burden','high_burden_unstudied','data_completeness')),
  study_category text NOT NULL CHECK (study_category IN ('clinical_effectiveness','health_economics','epidemiology',
    'quality_improvement','operational')),
  title text NOT NULL,
  statement text NOT NULL,
  condition_code text, condition_label text,
  department_id uuid,
  metrics jsonb NOT NULL,
  priority_score numeric NOT NULL CHECK (priority_score BETWEEN 0 AND 100),
  suggested_designs text[] NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed','rejected','deferred')),
  created_by text NOT NULL,
  decided_by text, decided_at timestamptz, decision_reason text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, analysis_id, gap_key),
  FOREIGN KEY (workspace_id, analysis_id) REFERENCES analysis_run,
  FOREIGN KEY (workspace_id, department_id) REFERENCES department,
  CHECK (status = 'proposed' OR (decided_by IS NOT NULL AND decision_reason IS NOT NULL AND decided_by <> created_by))
);

-- ---------------------------------------------------------------------------
-- Research office: ideas → projects → governance → outputs
-- ---------------------------------------------------------------------------
CREATE TABLE idea (
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  research_question text NOT NULL,
  rationale text NOT NULL,
  design text NOT NULL,
  study_category text NOT NULL CHECK (study_category IN ('clinical_effectiveness','health_economics','epidemiology',
    'quality_improvement','operational','other')),
  population text NOT NULL,
  data_sources text NOT NULL,
  primary_outcome text, comparator text,
  analysis_plan text, economic_method text, expected_output text,
  aggregate_volume int CHECK (aggregate_volume >= 0),
  condition_codes text[] NOT NULL DEFAULT '{}',
  source_gap_id uuid,
  origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','engine','claude')),
  pi text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','returned','feasibility','accepted',
    'deferred','rejected','converted')),
  priority int CHECK (priority BETWEEN 1 AND 5),
  reviewer text, triage_reason text, next_action text,
  project_id uuid,
  version int NOT NULL DEFAULT 1,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, department_id) REFERENCES department,
  FOREIGN KEY (workspace_id, source_gap_id) REFERENCES research_gap
);

CREATE TABLE idea_history (
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  idea_id uuid NOT NULL, from_status text NOT NULL, to_status text NOT NULL,
  actor text NOT NULL, reason text, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, idea_id) REFERENCES idea
);

CREATE TABLE project (
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  idea_id uuid,
  department_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  pi text NOT NULL,
  study_type text NOT NULL,
  study_category text NOT NULL,
  objective text,
  condition_codes text[] NOT NULL DEFAULT '{}',
  protocol_version int NOT NULL DEFAULT 1 CHECK (protocol_version >= 1),
  stage text NOT NULL DEFAULT 'draft' CHECK (stage IN ('draft','submitted','feasibility','governance','active',
    'on_hold','complete','archived')),
  hold_reason text,
  target_end date,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idea_id),
  FOREIGN KEY (workspace_id, department_id) REFERENCES department,
  FOREIGN KEY (workspace_id, idea_id) REFERENCES idea
);
ALTER TABLE idea ADD FOREIGN KEY (workspace_id, project_id) REFERENCES project;

CREATE TABLE project_stage_history (
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL, from_stage text NOT NULL, to_stage text NOT NULL,
  actor text NOT NULL, reason text, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES project
);

-- Official ethics and data decisions, per protocol version. The newest
-- decision of a kind supersedes earlier ones; history is kept.
CREATE TABLE governance_decision (
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ethics','data')),
  authority text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','denied','determination','revoked')),
  reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 200),
  effective_date date NOT NULL,
  expiry_date date,
  protocol_version int NOT NULL,
  permitted_scope text NOT NULL,
  recorder text NOT NULL,
  superseded boolean NOT NULL DEFAULT false,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES project,
  CHECK (expiry_date IS NULL OR expiry_date >= effective_date)
);
CREATE UNIQUE INDEX governance_current ON governance_decision (workspace_id, project_id, kind) WHERE NOT superseded;

CREATE TABLE milestone (
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  owner text NOT NULL,
  due_date date NOT NULL,
  state text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','in_progress','blocked','done','cancelled')),
  completed_date date,
  blocker text,
  version int NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES project,
  CHECK ((state = 'done') = (completed_date IS NOT NULL))
);

CREATE TABLE research_output (
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  output_type text NOT NULL CHECK (output_type IN ('protocol','sap','analysis','manuscript','abstract','poster',
    'economic_model','report')),
  title text NOT NULL,
  lead text NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','qc','approved','submitted',
    'accepted','published','released')),
  venue text, submitted_date date, accepted_date date, published_date date, doi text,
  version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES project
);

CREATE TABLE training_cohort (
  workspace_id uuid NOT NULL REFERENCES workspace, id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL, competencies text[] NOT NULL DEFAULT '{}',
  facilitator text NOT NULL, start_date date NOT NULL, end_date date NOT NULL,
  capacity int CHECK (capacity > 0), method text NOT NULL DEFAULT 'in_person',
  enrolled int NOT NULL DEFAULT 0 CHECK (enrolled >= 0),
  completed int NOT NULL DEFAULT 0 CHECK (completed >= 0 AND completed <= enrolled),
  version int NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, id),
  CHECK (end_date >= start_date)
);

CREATE TABLE partnership (
  workspace_id uuid NOT NULL REFERENCES workspace, id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization text NOT NULL,
  opportunity_type text NOT NULL CHECK (opportunity_type IN ('sponsor','grant','collaboration')),
  stage text NOT NULL DEFAULT 'lead' CHECK (stage IN ('lead','qualified','proposal','contracting','signed','active','closed','lost')),
  owner text NOT NULL, purpose text NOT NULL,
  next_action text, next_date date,
  amount numeric CHECK (amount >= 0), currency text CHECK (currency ~ '^[A-Z]{3}$'),
  version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

-- ---------------------------------------------------------------------------
-- Quality indicators (versioned definitions, verified observations)
-- ---------------------------------------------------------------------------
CREATE TABLE indicator_definition (
  workspace_id uuid NOT NULL REFERENCES workspace, id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,62}$'),
  def_version int NOT NULL DEFAULT 1,
  name text NOT NULL, category text NOT NULL,
  numerator_definition text NOT NULL, denominator_definition text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('higher_better','lower_better')),
  target_bp int CHECK (target_bp BETWEEN 0 AND 10000),
  active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, code, def_version)
);

CREATE TABLE indicator_observation (
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  definition_id uuid NOT NULL, department_id uuid NOT NULL,
  period text NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  numerator int NOT NULL CHECK (numerator >= 0),
  denominator int NOT NULL CHECK (denominator >= numerator),
  evidence_reference text,
  input_version int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','verified','returned')),
  submitted_by text NOT NULL, verified_by text, verified_at timestamptz, note text,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, definition_id, department_id, period),
  FOREIGN KEY (workspace_id, definition_id) REFERENCES indicator_definition,
  FOREIGN KEY (workspace_id, department_id) REFERENCES department,
  CHECK (status <> 'verified' OR (verified_by IS NOT NULL AND verified_by <> submitted_by))
);

-- ---------------------------------------------------------------------------
-- Monthly executive report revisions
-- ---------------------------------------------------------------------------
CREATE TABLE report_revision (
  workspace_id uuid NOT NULL REFERENCES workspace, id uuid NOT NULL DEFAULT gen_random_uuid(),
  period text NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  revision int NOT NULL,
  snapshot jsonb NOT NULL, digest text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','returned','published','superseded','withdrawn')),
  author text NOT NULL,
  reviewer text, review_note text, reviewed_at timestamptz,
  publisher text, published_at timestamptz,
  artifact_key text, artifact_sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, period, revision),
  CHECK (reviewer IS NULL OR reviewer <> author),
  CHECK (publisher IS NULL OR (publisher <> author AND publisher <> reviewer))
);
CREATE UNIQUE INDEX report_current ON report_revision (workspace_id, period) WHERE status = 'published';

-- ---------------------------------------------------------------------------
-- Row-level security on every tenant table
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['department','membership','audit_event','idempotency_key','data_upload','case_aggregate',
    'parameter_observation','analysis_run','research_gap','idea','idea_history','project','project_stage_history',
    'governance_decision','milestone','research_output','training_cohort','partnership','indicator_definition',
    'indicator_observation','report_revision'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid) WITH CHECK (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Restricted cross-tenant paths (SECURITY DEFINER)
-- ---------------------------------------------------------------------------
CREATE FUNCTION auth_memberships(p_issuer text, p_subject text)
RETURNS TABLE (workspace_id uuid, role text, department_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.workspace_id, m.role, m.department_id FROM membership m
  JOIN workspace w ON w.id = m.workspace_id
  WHERE m.issuer = p_issuer AND m.subject = p_subject AND m.active AND w.active
    AND m.grant_start <= current_date AND (m.grant_end IS NULL OR m.grant_end >= current_date)
$$;

CREATE FUNCTION auth_is_platform_admin(p_issuer text, p_subject text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM platform_admin WHERE issuer = p_issuer AND subject = p_subject)
$$;

CREATE FUNCTION provision_workspace(p_issuer text, p_subject text, p_name text, p_slug text, p_country text,
  p_timezone text, p_currency text, p_locale text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE new_id uuid;
BEGIN
  IF NOT auth_is_platform_admin(p_issuer, p_subject) THEN
    RAISE EXCEPTION 'platform admin required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_timezone) THEN
    RAISE EXCEPTION 'unknown timezone %', p_timezone USING ERRCODE = '22023';
  END IF;
  INSERT INTO workspace (name, slug, country, timezone, currency, locale)
  VALUES (p_name, p_slug, p_country, p_timezone, p_currency, p_locale) RETURNING id INTO new_id;
  PERFORM set_config('app.workspace_id', new_id::text, true);
  INSERT INTO audit_event (workspace_id, actor, action, entity_type, entity_id, details)
  VALUES (new_id, p_issuer || '|' || p_subject, 'workspace.provision', 'workspace', new_id::text, jsonb_build_object('slug', p_slug));
  RETURN new_id;
END $$;

-- ---------------------------------------------------------------------------
-- Runtime role. Password is set outside migrations (scripts/db-setup.sh).
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_web') THEN CREATE ROLE ih_web LOGIN; END IF;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ih_web;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ih_web;
GRANT SELECT ON workspace TO ih_web;
GRANT UPDATE (name, timezone, locale, currency, small_cell, report_day, report_hour, research_director, privacy_contact,
  version, updated_at) ON workspace TO ih_web;
GRANT SELECT, INSERT, UPDATE ON local_account TO ih_web;
GRANT SELECT, INSERT, UPDATE ON department, membership, data_upload, research_gap, idea, project, governance_decision,
  milestone, research_output, training_cohort, partnership, indicator_definition, indicator_observation, report_revision TO ih_web;
GRANT SELECT, INSERT ON audit_event, idempotency_key, case_aggregate, parameter_observation, analysis_run,
  idea_history, project_stage_history TO ih_web;
GRANT EXECUTE ON FUNCTION auth_memberships(text,text), auth_is_platform_admin(text,text),
  provision_workspace(text,text,text,text,text,text,text,text) TO ih_web;
