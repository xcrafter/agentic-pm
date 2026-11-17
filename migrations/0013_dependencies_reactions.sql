-- Task dependencies: task_id can't really start until depends_on_id is done ("blocked by").
CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id != depends_on_id)
);
CREATE INDEX task_dependencies_rev ON task_dependencies(depends_on_id);

-- Emoji reactions on thread messages (comments, updates, answers, share-link reports).
-- 👍 means "acknowledged".
CREATE TABLE entry_reactions (
  entry_id TEXT NOT NULL REFERENCES thread_entries(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id),
  emoji TEXT NOT NULL CHECK (emoji IN ('👍', '🎉', '👀', '❤️')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (entry_id, member_id, emoji)
);
