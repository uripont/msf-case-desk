-- Iteration 3, stage 3 review fix (additive only).
--
-- Each file written by `pnpm grant-admin` carries a unique import id. Its
-- statements run only while that id is absent, and the last one records it, so
-- the import applies once: running the file again (a redeploy, a restart of
-- workerd) never re-grants a capability that an administrator has revoked.
CREATE TABLE IF NOT EXISTS applied_imports (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
