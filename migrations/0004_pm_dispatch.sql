-- Workspace PM (dispatcher) agent: its webhook is the workspace-wide wake-up for agents
-- without their own webhook, and it can be woken to assign new unassigned tasks ("triage").
ALTER TABLE workspaces ADD COLUMN pm_agent_id TEXT REFERENCES members(id);
ALTER TABLE workspaces ADD COLUMN pm_triage INTEGER NOT NULL DEFAULT 1;

-- Allow the 'triage' trigger (SQLite can't alter a CHECK, so rebuild the table).
CREATE TABLE agent_runs_new (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT NOT NULL REFERENCES members(id),
  trigger TEXT NOT NULL CHECK (trigger IN ('assigned', 'answered', 'mentioned', 'manual', 'followup', 'triage')),
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
INSERT INTO agent_runs_new SELECT id, task_id, agent_id, trigger, trigger_entry_id, triggered_by, status, pending_trigger,
  attempts, last_error, dismissed, created_at, dispatched_at, last_activity_at, ended_at FROM agent_runs;
DROP TABLE agent_runs;
ALTER TABLE agent_runs_new RENAME TO agent_runs;
CREATE INDEX agent_runs_task_agent ON agent_runs(task_id, agent_id, status);
CREATE INDEX agent_runs_status ON agent_runs(status);
