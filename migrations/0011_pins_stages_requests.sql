-- Ideas: a stage on top of the working status — backlog (being considered/built), live (shipped), archived.
ALTER TABLE ideas ADD COLUMN stage TEXT NOT NULL DEFAULT 'backlog' CHECK (stage IN ('backlog', 'live', 'archived'));
ALTER TABLE ideas ADD COLUMN live_at TEXT;
-- Pinned ideas (shared across the workspace) float to the top.
ALTER TABLE ideas ADD COLUMN pinned_at TEXT;
ALTER TABLE ideas ADD COLUMN pinned_by TEXT REFERENCES members(id);
-- "Parked" ideas become archived; ideas whose task is already done are live.
UPDATE ideas SET stage = 'archived' WHERE status = 'parked';
UPDATE ideas SET stage = 'live', live_at = (SELECT completed_at FROM tasks t WHERE t.id = ideas.converted_task_id)
  WHERE converted_task_id IN (SELECT id FROM tasks WHERE status = 'done');

-- Customer requests: how many times this customer asked, and whether it's still open, now live, or archived.
ALTER TABLE idea_requests ADD COLUMN times INTEGER NOT NULL DEFAULT 1;
ALTER TABLE idea_requests ADD COLUMN status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'live', 'archived'));
ALTER TABLE idea_requests ADD COLUMN pinned_at TEXT;
ALTER TABLE idea_requests ADD COLUMN updated_at TEXT;
UPDATE idea_requests SET status = (SELECT CASE i.stage WHEN 'live' THEN 'live' WHEN 'archived' THEN 'archived' ELSE 'open' END FROM ideas i WHERE i.id = idea_requests.idea_id);
