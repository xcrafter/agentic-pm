-- Policies: the workspace's operating manual (SOPs, policies, strategies, structure), organised in folders.
-- Docs can apply to all agents or specific agents (optionally only on certain projects). "Required" docs
-- must be read, in their latest version, before an agent can work on tasks.
CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  parent_id TEXT REFERENCES policies(id),
  kind TEXT NOT NULL CHECK (kind IN ('folder', 'doc')),
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',        -- markdown
  summary TEXT NOT NULL DEFAULT '',        -- "when to use this", shown to agents in lists
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'agents', 'reference')),
  agent_ids TEXT NOT NULL DEFAULT '[]',    -- used when audience = 'agents'
  project_ids TEXT NOT NULL DEFAULT '[]',  -- empty = every project (and tasks with none)
  required INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,      -- bumped when the title or content changes
  position REAL NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES members(id),
  updated_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX policies_tree ON policies(workspace_id, parent_id, position);

CREATE TABLE policy_revisions (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL
);
CREATE INDEX policy_revisions_policy ON policy_revisions(policy_id, version);

-- Which version of a policy each agent (or person) last read.
CREATE TABLE policy_reads (
  member_id TEXT NOT NULL REFERENCES members(id),
  policy_id TEXT NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (member_id, policy_id)
);

-- Saved views each person pinned to their sidebar.
CREATE TABLE view_favorites (
  member_id TEXT NOT NULL REFERENCES members(id),
  view_id TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (member_id, view_id)
);
-- Keep today's sidebar for whoever made each view.
INSERT OR IGNORE INTO view_favorites (member_id, view_id, created_at) SELECT created_by, id, created_at FROM views;
