-- Stage 7 review: a pass that was stopped halfway, or a storage error, is not a
-- failed attempt. `deferrals` counts those separately from `attempts`, which
-- now counts failures of the channel only. The partial index serves the unread
-- count polled by every open tab. Additive: nothing existing changes.
ALTER TABLE notification_jobs ADD COLUMN deferrals INTEGER NOT NULL DEFAULT 0;
CREATE INDEX notification_jobs_unread ON notification_jobs (recipient_id)
  WHERE channel = 'inbox' AND state = 'done' AND read_at IS NULL;
