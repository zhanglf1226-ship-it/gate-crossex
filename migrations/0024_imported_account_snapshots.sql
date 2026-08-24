CREATE TABLE IF NOT EXISTS imported_account_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  generated_at_ms INTEGER NOT NULL,
  snapshot_fingerprint TEXT NOT NULL,
  positions_json TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE (account_id, generated_at_ms),
  FOREIGN KEY (account_id) REFERENCES cloud_accounts(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_imported_account_snapshots_account_time
  ON imported_account_snapshots(account_id, generated_at_ms DESC);
