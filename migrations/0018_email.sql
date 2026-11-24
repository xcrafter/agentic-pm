-- Email notifications: each person's choices, and a log of what was sent (for admins to check delivery).
ALTER TABLE members ADD COLUMN email_prefs TEXT; -- JSON {"off": ["assigned", ...]}; NULL = everything on

CREATE TABLE email_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  member_id TEXT,
  to_email TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL, -- sent | failed | skipped
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_email_log_ws ON email_log (workspace_id, created_at DESC);
