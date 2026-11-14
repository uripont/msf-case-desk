-- Stage 7: a failed notification may be tried again. `retry_at` is the time it
-- becomes claimable again (NULL on a final failure), `last_error` a short
-- reason (never report text). Additive: nothing existing changes.
ALTER TABLE notification_jobs ADD COLUMN retry_at INTEGER;
ALTER TABLE notification_jobs ADD COLUMN last_error TEXT;
