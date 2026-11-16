-- Customers and their feature requests. A request links a customer to an idea (one row per customer per idea),
-- so several customers can ask for the same feature, or a feature can come from a single customer.
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  domain TEXT,          -- store or company domain, e.g. brand.myshopify.com
  email TEXT,
  plan TEXT,            -- e.g. Free, Growth, Scale
  mrr REAL,             -- monthly revenue from this customer (any currency, used for weighting)
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX customers_name ON customers(workspace_id, name COLLATE NOCASE);

CREATE TABLE idea_requests (
  id TEXT PRIMARY KEY,
  idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',      -- what they said, in their words
  requested_at TEXT NOT NULL,         -- YYYY-MM-DD
  added_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  UNIQUE (idea_id, customer_id)
);
CREATE INDEX idea_requests_customer ON idea_requests(customer_id);
