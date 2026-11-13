-- Iteration 3, stage 2 review fixes (additive only).
--
-- A unit's reviewer registry keeps the unit's own name and number for a
-- person, and whether the unit asked for WhatsApp consent. The account's own
-- name and number are never written by a unit's author (D13). Rows that exist
-- keep an empty display_name and read the account's name.
ALTER TABLE unit_reviewers ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE unit_reviewers ADD COLUMN phone TEXT;
ALTER TABLE unit_reviewers ADD COLUMN consent_requested INTEGER NOT NULL DEFAULT 0;

-- The people list a staged section was redacted with: one list for the whole
-- share (D14).
ALTER TABLE share_staging ADD COLUMN people_hash TEXT NOT NULL DEFAULT '';

CREATE INDEX share_staging_staged_at ON share_staging (staged_at);
CREATE INDEX images_created ON images (created_at);
