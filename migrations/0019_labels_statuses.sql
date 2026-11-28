-- Task labels: a workspace-wide set, any number per task.
CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX labels_name ON labels(workspace_id, name COLLATE NOCASE);

CREATE TABLE task_labels (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  label_id TEXT NOT NULL REFERENCES labels(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, label_id)
);
CREATE INDEX task_labels_label ON task_labels(label_id);

-- Task statuses each workspace can customise. The six built-in statuses keep their keys (agents,
-- automations and reports rely on them) but can be renamed, recoloured and reordered; they only get a
-- row here once someone changes them. Custom statuses each sit in one built-in "category"
-- (e.g. "In review" behaves like in_progress): tasks.status keeps the category, so everything that
-- reacts to done / canceled / waiting_on_human keeps working, and tasks.status_key names the custom one.
CREATE TABLE task_statuses (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('backlog', 'todo', 'in_progress', 'waiting_on_human', 'done', 'canceled')),
  position REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

ALTER TABLE tasks ADD COLUMN status_key TEXT;
