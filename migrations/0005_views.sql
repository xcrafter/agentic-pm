-- Saved task views (filters + sort + layout), shared across the workspace.
CREATE TABLE views (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL REFERENCES members(id),
  position REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX views_workspace ON views(workspace_id, position);

-- Runs left open on tasks that were already finished: close them so they don't show as working / gone quiet.
UPDATE agent_runs SET status = 'ended', ended_at = COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE status IN ('queued', 'dispatched', 'active', 'stale')
  AND task_id IN (SELECT id FROM tasks WHERE status IN ('done', 'canceled'));

-- The PM stays idle unless an agent is assigned or @mentioned: waking it for new unassigned tasks
-- ("triage") is now opt-in. Turn it off and close any triage runs still open.
UPDATE workspaces SET pm_triage = 0;
UPDATE agent_runs SET status = 'ended', ended_at = COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE trigger = 'triage' AND status IN ('queued', 'dispatched', 'active', 'stale');
