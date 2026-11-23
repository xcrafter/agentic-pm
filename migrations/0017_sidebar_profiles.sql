-- Sidebar profiles: named sets of hidden sidebar items that admins assign to people.
-- Each person can still show or hide items on top of their profile (members.sidebar_prefs).
CREATE TABLE sidebar_profiles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  hidden TEXT NOT NULL DEFAULT '[]',   -- JSON array of sidebar item keys
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_sidebar_profiles_ws ON sidebar_profiles (workspace_id);
ALTER TABLE members ADD COLUMN sidebar_profile_id TEXT REFERENCES sidebar_profiles(id);
ALTER TABLE members ADD COLUMN sidebar_prefs TEXT;               -- JSON {hidden: [], shown: []}
ALTER TABLE workspaces ADD COLUMN default_sidebar_profile_id TEXT REFERENCES sidebar_profiles(id);
