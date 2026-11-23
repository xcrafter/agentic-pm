-- Tasks are archived with their project: hidden from task lists, agents aren't woken on them.
-- Restoring the project brings them back. Status is untouched, so nothing is lost either way.
ALTER TABLE tasks ADD COLUMN archived_at TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks (workspace_id, archived_at);
