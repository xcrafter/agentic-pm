-- Workspace settings editable by admins: website, logo, allowed sign-in domains.
ALTER TABLE workspaces ADD COLUMN website TEXT;
ALTER TABLE workspaces ADD COLUMN logo_key TEXT;          -- R2 key of the workspace logo
ALTER TABLE workspaces ADD COLUMN logo_updated_at TEXT;
ALTER TABLE workspaces ADD COLUMN allowed_domains TEXT;   -- comma list; NULL = use ALLOWED_EMAIL_DOMAINS
