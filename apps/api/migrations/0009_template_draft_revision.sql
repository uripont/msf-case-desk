-- Stage 8 and 9 review: a template draft counts its saves, so a save or a
-- publish that was made from an older copy is refused instead of overwriting.
-- Additive: one column with a default.
ALTER TABLE template_versions ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 0;
