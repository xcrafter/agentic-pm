-- Email + password sign-in for people, invite/reset links, and agent ownership.
ALTER TABLE members ADD COLUMN password_hash TEXT;
ALTER TABLE members ADD COLUMN created_by TEXT;

-- One-time links: an invite for a new person, or a password reset for an existing one.
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  member_id TEXT REFERENCES members(id), -- set for password resets
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX invites_workspace ON invites(workspace_id, used_at);
