-- Iteration 3, stage 5 review fixes (additive only).
--
-- The case reference a redacted reader sees is stored redacted at share time,
-- next to the redacted case title (D14). Drafts that exist keep an empty
-- twin: a redacted reader of those sees no reference.
ALTER TABLE drafts ADD COLUMN case_reference_redacted TEXT NOT NULL DEFAULT '';
