-- Agentic PM initial schema

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  next_task_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  name TEXT NOT NULL,
  handle TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  active INTEGER NOT NULL DEFAULT 1,
  -- human
  email TEXT,
  google_sub TEXT,
  -- agent
  description TEXT,
  webhook_url TEXT,
  webhook_key_encrypted TEXT,
  wake_on_mention INTEGER NOT NULL DEFAULT 1,
  max_runs_per_hour INTEGER NOT NULL DEFAULT 10,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX members_handle ON members(workspace_id, handle);
CREATE UNIQUE INDEX members_email ON members(workspace_id, email) WHERE email IS NOT NULL;

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  lead_member_id TEXT REFERENCES members(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('backlog', 'todo', 'in_progress', 'waiting_on_human', 'done', 'canceled')),
  priority TEXT NOT NULL DEFAULT 'none' CHECK (priority IN ('none', 'low', 'medium', 'high', 'urgent')),
  assignee_id TEXT REFERENCES members(id),
  project_id TEXT REFERENCES projects(id),
  due_date TEXT,
  position REAL NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE UNIQUE INDEX tasks_number ON tasks(workspace_id, number);
CREATE INDEX tasks_assignee ON tasks(assignee_id, status);
CREATE INDEX tasks_project ON tasks(project_id);

CREATE TABLE thread_entries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  author_id TEXT NOT NULL REFERENCES members(id),
  type TEXT NOT NULL CHECK (type IN ('comment', 'update', 'question', 'answer',
    'note_created', 'checklist_created', 'attachment_added', 'system')),
  body TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  reply_to_id TEXT REFERENCES thread_entries(id),
  created_at TEXT NOT NULL,
  edited_at TEXT
);
CREATE INDEX thread_entries_task ON thread_entries(task_id, created_at);

CREATE TABLE thread_entry_revisions (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES thread_entries(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES members(id),
  updated_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX notes_task ON notes(task_id);

CREATE TABLE note_revisions (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL
);

CREATE TABLE checklists (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  title TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL
);
CREATE INDEX checklists_task ON checklists(task_id);

CREATE TABLE checklist_items (
  id TEXT PRIMARY KEY,
  checklist_id TEXT NOT NULL REFERENCES checklists(id),
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  done_by TEXT REFERENCES members(id),
  done_at TEXT,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX checklist_items_list ON checklist_items(checklist_id, position);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  thread_entry_id TEXT REFERENCES thread_entries(id),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL
);
CREATE INDEX attachments_task ON attachments(task_id);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT NOT NULL REFERENCES members(id),
  trigger TEXT NOT NULL CHECK (trigger IN ('assigned', 'answered', 'mentioned', 'manual', 'followup')),
  trigger_entry_id TEXT REFERENCES thread_entries(id),
  triggered_by TEXT REFERENCES members(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'dispatched', 'active', 'ended', 'failed', 'stale')),
  pending_trigger INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  dismissed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  last_activity_at TEXT,
  ended_at TEXT
);
CREATE INDEX agent_runs_task_agent ON agent_runs(task_id, agent_id, status);
CREATE INDEX agent_runs_status ON agent_runs(status);

CREATE TABLE read_cursors (
  member_id TEXT NOT NULL REFERENCES members(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  last_read_at TEXT NOT NULL,
  PRIMARY KEY (member_id, task_id)
);

CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  actor_id TEXT,
  via TEXT NOT NULL CHECK (via IN ('web', 'mcp', 'system')),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before TEXT,
  after TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX activity_entity ON activity(entity_type, entity_id, created_at);
