-- Product ideas: a backlog of feature ideas and concepts that can later become tasks.
CREATE TABLE ideas (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  labels TEXT NOT NULL DEFAULT '[]',           -- JSON array from the fixed label set
  labels_by TEXT NOT NULL DEFAULT 'pending'    -- who set the labels: pending | ai | human | agent | fallback
    CHECK (labels_by IN ('pending', 'ai', 'human', 'agent', 'fallback')),
  suggested_owner_id TEXT REFERENCES members(id),
  owner_reason TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'exploring', 'planned', 'converted', 'parked')),
  source_url TEXT,
  created_by TEXT NOT NULL REFERENCES members(id),
  converted_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ideas_workspace ON ideas(workspace_id, created_at);
