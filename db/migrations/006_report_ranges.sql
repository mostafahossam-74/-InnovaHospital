-- Reports cover a range of months instead of exactly one (data stays monthly). The report
-- key in report_revision.period is 'YYYY-MM' for one month, as before, or
-- 'YYYY-MM_YYYY-MM' for a range (start_end); revisions, the current-release index and
-- supersession stay keyed on it. Existing rows are single months and stay valid.
ALTER TABLE report_revision DROP CONSTRAINT report_revision_period_check;
ALTER TABLE report_revision ADD CONSTRAINT report_revision_period_check
  CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])(_\d{4}-(0[1-9]|1[0-2]))?$'
         AND (length(period) = 7 OR split_part(period, '_', 1) < split_part(period, '_', 2)));
