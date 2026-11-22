-- Notification outbox (Developer_Handoff §5 step 6: "notify via an authenticated portal
-- link"). A notice is written in the same transaction as the event it reports, one row
-- per recipient, and the scheduler worker delivers it. dedupe_key stops a retried action
-- from notifying anyone twice. The message holds a sign-in link, never report data; the
-- recipient's email address is looked up at delivery, from their active membership.
CREATE TABLE notification (
  workspace_id uuid NOT NULL REFERENCES workspace, id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('report_review_needed', 'report_release_needed', 'report_returned', 'project_on_hold', 'scheduler_job_failed')),
  recipient text NOT NULL,                 -- actor id: issuer|subject
  entity_type text NOT NULL, entity_id text NOT NULL,
  link_path text NOT NULL CHECK (link_path ~ '^/#/w/'),
  params jsonb NOT NULL DEFAULT '{}',      -- non-sensitive words for the message, such as the period
  dedupe_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  sent_to text, provider_message_id text, sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, dedupe_key)
);
CREATE INDEX notification_due ON notification (workspace_id, next_attempt_at) WHERE status = 'pending';

ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON notification
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON notification TO ih_web;
