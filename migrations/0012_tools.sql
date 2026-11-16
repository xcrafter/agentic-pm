-- Tools directory: useful tools found online, with a short summary and tags (researched by AI / an agent).
CREATE TABLE tools (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',          -- longer markdown: what it's good for, how we'd use it
  tags TEXT NOT NULL DEFAULT '[]',
  category TEXT,
  pricing TEXT,
  icon_url TEXT,
  enriched_by TEXT NOT NULL DEFAULT 'pending'
    CHECK (enriched_by IN ('pending', 'ai', 'agent', 'human', 'failed')),
  research_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  pinned_at TEXT,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX tools_url ON tools(workspace_id, url);
CREATE INDEX tools_workspace ON tools(workspace_id, created_at);
