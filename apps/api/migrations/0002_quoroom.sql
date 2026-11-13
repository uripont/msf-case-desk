-- Iteration 3 (Quoroom). New tables only: users, sessions, cases and
-- rule_sets are untouched, so the frozen iter1 and iter2 keep working on the
-- shared database. Expand only: see docs/compatibility.md.
-- JSON is stored as text. Times are milliseconds since the epoch.
-- No triggers: every atomic step is a guarded batch (apps/api/src/sql.ts).

-- ---- Units, accounts, links ----------------------------------------------

CREATE TABLE units (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- unit_id is '' for the deployment-wide capabilities, so the primary key
-- also stops a duplicate (SQLite treats NULLs in a key as distinct).
CREATE TABLE capability_grants (
  user_id TEXT NOT NULL REFERENCES users (id),
  capability TEXT NOT NULL CHECK (capability IN ('admin', 'template_editor', 'author')),
  unit_id TEXT NOT NULL DEFAULT '',
  granted_by TEXT REFERENCES users (id),
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, capability, unit_id),
  CHECK ((capability = 'author') = (unit_id <> ''))
);

CREATE INDEX capability_grants_unit ON capability_grants (unit_id, capability);

CREATE TABLE account_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users (id),
  phone TEXT,
  whatsapp_consent INTEGER NOT NULL DEFAULT 0,
  whatsapp_consent_at INTEGER,
  notify_on_approval INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  password_set_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users (id),
  purpose TEXT NOT NULL CHECK (purpose IN ('activate', 'reset')),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  issued_by TEXT REFERENCES users (id),
  created_at INTEGER NOT NULL
);

CREATE INDEX invitations_user ON invitations (user_id);

CREATE TABLE sign_in_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  ip TEXT NOT NULL,
  at INTEGER NOT NULL,
  succeeded INTEGER NOT NULL
);

CREATE INDEX sign_in_attempts_email ON sign_in_attempts (email, at);
CREATE INDEX sign_in_attempts_ip ON sign_in_attempts (ip, at);

CREATE TABLE theme (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  settings TEXT NOT NULL,
  logo_image_id TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users (id)
);

-- ---- Images (D5): chunks of base64 text, below 1 MB per row --------------

CREATE TABLE images (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('report', 'theme')),
  owner_id TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT NOT NULL REFERENCES users (id),
  mime TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  chunks_received INTEGER NOT NULL DEFAULT 0,
  stored_bytes INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX images_owner ON images (owner_kind, owner_id);

CREATE TABLE image_chunks (
  image_id TEXT NOT NULL REFERENCES images (id),
  idx INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (image_id, idx)
);

-- A running total of stored image text: the cheap check behind the 400 MB
-- guard (reading the size of the database costs a scan).
CREATE TABLE storage_stats (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

INSERT INTO storage_stats (key, value) VALUES ('image_bytes', 0);

-- ---- Templates ------------------------------------------------------------

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users (id),
  created_at INTEGER NOT NULL
);

CREATE TABLE template_versions (
  template_id TEXT NOT NULL REFERENCES templates (id),
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'published', 'retired')),
  definition TEXT NOT NULL,
  created_by TEXT REFERENCES users (id),
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  published_by TEXT REFERENCES users (id),
  changes TEXT,
  retired_at INTEGER,
  PRIMARY KEY (template_id, version)
);

CREATE INDEX template_versions_state ON template_versions (state, template_id);

-- ---- Committees, case files, reports --------------------------------------

CREATE TABLE unit_reviewers (
  unit_id TEXT NOT NULL REFERENCES units (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  added_by TEXT REFERENCES users (id),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (unit_id, user_id)
);

CREATE INDEX unit_reviewers_user ON unit_reviewers (user_id);

CREATE TABLE committees (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id),
  name TEXT NOT NULL,
  created_by TEXT REFERENCES users (id),
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  UNIQUE (unit_id, name)
);

CREATE TABLE committee_members (
  committee_id TEXT NOT NULL REFERENCES committees (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (committee_id, user_id)
);

CREATE INDEX committee_members_user ON committee_members (user_id);

CREATE TABLE case_files (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id),
  reference TEXT NOT NULL,
  title TEXT NOT NULL,
  created_by TEXT REFERENCES users (id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (unit_id, reference)
);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  case_file_id TEXT NOT NULL REFERENCES case_files (id),
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('drafting', 'in_review', 'decided', 'concluding', 'archived')),
  deadline_at INTEGER,
  deadline_zone TEXT,
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (template_id, template_version) REFERENCES template_versions (template_id, version)
);

CREATE INDEX reports_case_file ON reports (case_file_id);
CREATE INDEX reports_state ON reports (state);

CREATE TABLE report_members (
  report_id TEXT NOT NULL REFERENCES reports (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  role_id TEXT NOT NULL,
  added_by TEXT REFERENCES users (id),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (report_id, user_id)
);

CREATE INDEX report_members_user ON report_members (user_id);

-- ---- Working copies (private) ----------------------------------------------

CREATE TABLE working_copies (
  report_id TEXT NOT NULL REFERENCES reports (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  base_draft INTEGER NOT NULL,
  save_counter INTEGER NOT NULL DEFAULT 0,
  people TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_saved_at INTEGER NOT NULL,
  PRIMARY KEY (report_id, user_id)
);

-- One row per section: a save sends one section (spike 3). save_counter is
-- the working copy's counter at the time the section was written.
CREATE TABLE working_copy_sections (
  report_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  save_counter INTEGER NOT NULL,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (report_id, user_id, section_id),
  FOREIGN KEY (report_id, user_id) REFERENCES working_copies (report_id, user_id)
);

-- ---- Shared drafts (immutable) -------------------------------------------

CREATE TABLE drafts (
  report_id TEXT NOT NULL REFERENCES reports (id),
  number INTEGER NOT NULL,
  base_number INTEGER,
  author_id TEXT REFERENCES users (id),
  shared_at INTEGER NOT NULL,
  share_id TEXT NOT NULL,
  people TEXT NOT NULL,
  case_title_redacted TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (report_id, number),
  UNIQUE (report_id, share_id)
);

CREATE TABLE draft_sections (
  report_id TEXT NOT NULL,
  draft_number INTEGER NOT NULL,
  section_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  content TEXT NOT NULL,
  redacted_content TEXT NOT NULL,
  redacted_hash TEXT NOT NULL,
  PRIMARY KEY (report_id, draft_number, section_id),
  FOREIGN KEY (report_id, draft_number) REFERENCES drafts (report_id, number)
);

-- Which images a draft references and whether each is safe to share in it
-- (reading an image is one query on this table, D5).
CREATE TABLE draft_images (
  report_id TEXT NOT NULL,
  draft_number INTEGER NOT NULL,
  image_id TEXT NOT NULL REFERENCES images (id),
  safe INTEGER NOT NULL,
  PRIMARY KEY (report_id, draft_number, image_id),
  FOREIGN KEY (report_id, draft_number) REFERENCES drafts (report_id, number)
);

CREATE INDEX draft_images_image ON draft_images (image_id);

CREATE TABLE redaction_confirmations (
  report_id TEXT NOT NULL,
  draft_number INTEGER NOT NULL,
  confirmed_by TEXT NOT NULL REFERENCES users (id),
  confirmed_at INTEGER NOT NULL,
  PRIMARY KEY (report_id, draft_number),
  FOREIGN KEY (report_id, draft_number) REFERENCES drafts (report_id, number)
);

-- Sections staged by ShareSection until FinishShare builds the draft in SQL.
CREATE TABLE share_staging (
  share_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  content TEXT NOT NULL,
  redacted_content TEXT NOT NULL,
  redacted_hash TEXT NOT NULL,
  image_refs TEXT NOT NULL,
  staged_at INTEGER NOT NULL,
  PRIMARY KEY (share_id, section_id)
);

CREATE INDEX share_staging_owner ON share_staging (report_id, user_id);

-- ---- Revisions, rounds, reviews ---------------------------------------------

CREATE TABLE revisions (
  report_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  draft_number INTEGER NOT NULL,
  closing INTEGER NOT NULL DEFAULT 0,
  published_by TEXT NOT NULL REFERENCES users (id),
  published_at INTEGER NOT NULL,
  PRIMARY KEY (report_id, number),
  FOREIGN KEY (report_id, draft_number) REFERENCES drafts (report_id, number)
);

CREATE TABLE review_rounds (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  closing INTEGER NOT NULL DEFAULT 0,
  deadline_at INTEGER NOT NULL,
  deadline_zone TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'superseded', 'decided')),
  decided_by TEXT CHECK (decided_by IN ('rule_met', 'deadline')),
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (report_id, revision_number),
  FOREIGN KEY (report_id, revision_number) REFERENCES revisions (report_id, number)
);

CREATE INDEX review_rounds_open ON review_rounds (report_id, state);

CREATE TABLE round_participants (
  round_id TEXT NOT NULL REFERENCES review_rounds (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  role_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  removed_at INTEGER,
  removed_by TEXT REFERENCES users (id),
  PRIMARY KEY (round_id, user_id)
);

CREATE INDEX round_participants_user ON round_participants (user_id, removed_at);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES review_rounds (id),
  reviewer_id TEXT NOT NULL REFERENCES users (id),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'request_changes', 'comment')),
  has_comments INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL
);

CREATE INDEX reviews_round ON reviews (round_id, reviewer_id);

CREATE TABLE pending_reviews (
  round_id TEXT NOT NULL REFERENCES review_rounds (id),
  reviewer_id TEXT NOT NULL REFERENCES users (id),
  decision TEXT CHECK (decision IN ('approve', 'request_changes', 'comment')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (round_id, reviewer_id)
);

-- One table for comments on drafts and on revisions. review_id is NULL while
-- a reviewer's comment is pending.
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports (id),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('draft', 'revision')),
  target_number INTEGER NOT NULL,
  round_id TEXT REFERENCES review_rounds (id),
  section_id TEXT NOT NULL,
  item_id TEXT,
  range_from INTEGER,
  range_to INTEGER,
  quoted TEXT,
  body TEXT NOT NULL,
  redacted_body TEXT,
  author_id TEXT NOT NULL REFERENCES users (id),
  visibility TEXT NOT NULL CHECK (visibility IN ('authors', 'committee')),
  resolved INTEGER NOT NULL DEFAULT 0,
  review_id TEXT REFERENCES reviews (id),
  created_at INTEGER NOT NULL
);

CREATE INDEX comments_target ON comments (report_id, target_kind, target_number);
CREATE INDEX comments_pending ON comments (round_id, author_id, review_id);

CREATE TABLE comment_replies (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments (id),
  author_id TEXT NOT NULL REFERENCES users (id),
  body TEXT NOT NULL,
  redacted_body TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX comment_replies_comment ON comment_replies (comment_id, created_at);

-- ---- Notifications, events, audit ---------------------------------------------

CREATE TABLE notification_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  report_id TEXT NOT NULL REFERENCES reports (id),
  round_id TEXT REFERENCES review_rounds (id),
  recipient_id TEXT REFERENCES users (id),
  kind TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  deadline INTEGER,
  subject TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('inbox', 'whatsapp')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'done', 'skipped', 'failed')),
  claimed_by TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  delivery_status TEXT,
  created_at INTEGER NOT NULL,
  done_at INTEGER,
  read_at INTEGER
);

CREATE INDEX notification_jobs_due ON notification_jobs (state, due_at);
CREATE INDEX notification_jobs_inbox ON notification_jobs (recipient_id, channel, state, due_at);
CREATE INDEX notification_jobs_round ON notification_jobs (round_id, state);
CREATE INDEX notification_jobs_report ON notification_jobs (report_id);

-- The facts of a report that the shared tables do not already hold: who
-- opened what, and when someone was told or reminded (the grid reads these).
CREATE TABLE report_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT NOT NULL REFERENCES reports (id),
  kind TEXT NOT NULL CHECK (kind IN ('draft_read', 'read', 'whatsapp_opened', 'notified', 'reminded')),
  account_id TEXT NOT NULL REFERENCES users (id),
  draft_number INTEGER,
  revision_number INTEGER,
  at INTEGER NOT NULL,
  detail TEXT
);

CREATE INDEX report_events_report ON report_events (report_id, at);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_id TEXT,
  report_id TEXT,
  template_id TEXT,
  draft_number INTEGER,
  revision_number INTEGER,
  action TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX audit_events_report ON audit_events (report_id, at);
CREATE INDEX audit_events_template ON audit_events (template_id, at);
