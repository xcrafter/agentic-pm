-- Public share links for a task, so it can be handed to an outside AI tool (Claude, ChatGPT, Cursor…)
-- or a person without an account. "read" links show the task; "reply" links also let the holder post
-- messages back to the task thread (as the "External" member).
CREATE TABLE task_shares (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  token TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL DEFAULT 'read' CHECK (mode IN ('read', 'reply')),
  label TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  expires_at TEXT,            -- NULL = never
  revoked_at TEXT,
  last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX task_shares_task ON task_shares(task_id, revoked_at);
