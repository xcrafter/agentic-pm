-- Workspace feed: short updates from people and agents (not tied to one task), with reactions.
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  author_id TEXT NOT NULL REFERENCES members(id),
  kind TEXT NOT NULL DEFAULT 'update' CHECK (kind IN ('update', 'done', 'blocker')),
  body TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  link_url TEXT,
  routine TEXT,              -- e.g. "daily-blog": groups recurring work for consistency reporting
  auto INTEGER NOT NULL DEFAULT 0, -- 1 = posted by the platform (e.g. task completed)
  created_at TEXT NOT NULL,
  edited_at TEXT
);
CREATE INDEX posts_workspace ON posts(workspace_id, created_at);
CREATE INDEX posts_author ON posts(author_id, created_at);
CREATE INDEX posts_routine ON posts(workspace_id, routine, created_at);

CREATE TABLE post_reactions (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id),
  emoji TEXT NOT NULL CHECK (emoji IN ('👍', '🎉', '👀', '❤️')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, member_id, emoji)
);
