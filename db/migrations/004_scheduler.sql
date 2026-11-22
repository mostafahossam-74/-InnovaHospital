-- Scheduled jobs (Developer_Handoff §5): one row per workspace, job kind and key, so a
-- job can be queued only once. report_draft is keyed by the month it covers (YYYY-MM)
-- and runs at the workspace's report_day/report_hour in its timezone; expiry_check is
-- keyed by the workspace's local date and runs daily.
--
-- The worker (src/worker.ts) runs each job in one transaction that also marks it done,
-- holding the row with FOR UPDATE SKIP LOCKED: a crash rolls everything back and the job
-- stays pending, and two workers never run the same job.
CREATE TABLE scheduled_job (
  workspace_id uuid NOT NULL REFERENCES workspace,
  kind text NOT NULL CHECK (kind IN ('report_draft', 'expiry_check')),
  job_key text NOT NULL CHECK (job_key ~ '^\d{4}-\d{2}(-\d{2})?$'),
  scheduled_at timestamptz NOT NULL,          -- the UTC instant of the local schedule
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  last_error text,
  result jsonb,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, kind, job_key)
);
CREATE INDEX scheduled_job_due ON scheduled_job (workspace_id, next_attempt_at) WHERE status = 'pending';

ALTER TABLE scheduled_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_job FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON scheduled_job
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON scheduled_job TO ih_web;
