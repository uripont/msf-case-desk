-- 16 Nov: one permission per top tab of the app. `admin` is split into
-- `people` (accounts, units, permissions, links) and `theme`; `operator` is
-- gone (deploy, backup and the first administrator are CLI operations).
--
-- capability_grants allows only 'admin', 'template_editor' and 'author' in a
-- CHECK, and SQLite cannot change a CHECK in place. Expand only: a new table
-- with no list of values (the code decides which names it knows, and ignores
-- the rest when reading), and a copy of every grant into it, each `admin`
-- becoming `people` plus `theme`. capability_grants stays as it was, unused.
-- No frozen version reads either table.
CREATE TABLE IF NOT EXISTS permission_grants (
  user_id TEXT NOT NULL REFERENCES users (id),
  capability TEXT NOT NULL,
  unit_id TEXT NOT NULL DEFAULT '',
  granted_by TEXT REFERENCES users (id),
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, capability, unit_id),
  CHECK ((capability = 'author') = (unit_id <> ''))
);

CREATE INDEX IF NOT EXISTS permission_grants_unit ON permission_grants (unit_id, capability);

INSERT INTO permission_grants (user_id, capability, unit_id, granted_by, granted_at)
  SELECT user_id, 'people', '', granted_by, granted_at FROM capability_grants
  WHERE capability = 'admin'
  ON CONFLICT DO NOTHING;

INSERT INTO permission_grants (user_id, capability, unit_id, granted_by, granted_at)
  SELECT user_id, 'theme', '', granted_by, granted_at FROM capability_grants
  WHERE capability = 'admin'
  ON CONFLICT DO NOTHING;

INSERT INTO permission_grants (user_id, capability, unit_id, granted_by, granted_at)
  SELECT user_id, capability, unit_id, granted_by, granted_at FROM capability_grants
  WHERE capability IN ('template_editor', 'author')
  ON CONFLICT DO NOTHING;
