-- Shared by every deployed version. Expand only: see docs/compatibility.md.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX sessions_user_id ON sessions (user_id);

CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  centre TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  summary TEXT NOT NULL,
  scope TEXT NOT NULL,
  risk TEXT NOT NULL,
  urgency TEXT NOT NULL,
  fast_track_signals TEXT NOT NULL DEFAULT '[]',
  channel TEXT,
  details TEXT,
  location TEXT,
  reference TEXT,
  entered_at INTEGER,
  entered_by TEXT REFERENCES users (id),
  schema_version INTEGER
);

CREATE INDEX cases_received_at ON cases (received_at);

CREATE TABLE rule_sets (
  scope TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  p1_min_score INTEGER NOT NULL,
  p2_min_score INTEGER NOT NULL,
  fast_track_hours INTEGER NOT NULL,
  target_hours_p1 INTEGER NOT NULL,
  target_hours_p2 INTEGER NOT NULL,
  target_hours_p3 INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users (id)
);
