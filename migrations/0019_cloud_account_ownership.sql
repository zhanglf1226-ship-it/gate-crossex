CREATE TABLE IF NOT EXISTS cloud_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  credential_profile_id TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_account_grants (
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  access_level TEXT NOT NULL CHECK (access_level IN ('view', 'plan', 'approve', 'admin', 'audit')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, account_id),
  FOREIGN KEY (account_id) REFERENCES cloud_accounts(id) ON DELETE CASCADE
);

ALTER TABLE order_previews ADD COLUMN account_id TEXT;
ALTER TABLE order_previews ADD COLUMN creator_user_id TEXT;
ALTER TABLE order_previews ADD COLUMN approver_user_id TEXT;

CREATE INDEX IF NOT EXISTS order_previews_account_created_idx
  ON order_previews(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cloud_account_grants_account_idx
  ON cloud_account_grants(account_id, access_level);
