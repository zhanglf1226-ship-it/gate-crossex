CREATE TABLE IF NOT EXISTS protection_book_reconciliations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('MATCH','DIFFERENT','UNCOMPARABLE')),
  confidence TEXT NOT NULL CHECK (confidence IN ('HIGH','LOW')),
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (account_id, evidence_fingerprint),
  FOREIGN KEY (account_id) REFERENCES cloud_accounts(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_protection_reconciliations_account_created
  ON protection_book_reconciliations(account_id, created_at DESC);
