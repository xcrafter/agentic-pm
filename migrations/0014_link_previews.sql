-- What link-preview bots (WhatsApp, Slack…) see for app task links (/t/IMP-12). Off by default:
-- bots aren't signed in, so anything shown here is readable by anyone who guesses a task key.
ALTER TABLE workspaces ADD COLUMN link_previews TEXT NOT NULL DEFAULT 'off' CHECK (link_previews IN ('off', 'title', 'full'));
