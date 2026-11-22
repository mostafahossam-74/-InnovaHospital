-- What Claude returned when a call was turned down (failed the schema or the number
-- check, or was not valid JSON), so a statistician can see what was rejected.
-- Accepted output is already stored in the row it became; this stays null for it.
ALTER TABLE agent_call ADD COLUMN rejected_output jsonb;
