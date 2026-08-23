CREATE UNIQUE INDEX IF NOT EXISTS target_shadow_plans_id_account_idx
  ON target_shadow_plans(id, account_id);

CREATE TABLE IF NOT EXISTS target_shadow_comparisons (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  shadow_plan_id TEXT NOT NULL,
  bridge_audit_path TEXT NOT NULL,
  bridge_audit_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('MATCH', 'DIFFERENT', 'UNCOMPARABLE')),
  confidence TEXT NOT NULL CHECK (confidence IN ('LOW', 'HIGH')),
  comparison_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (shadow_plan_id, account_id) REFERENCES target_shadow_plans(id, account_id) ON DELETE CASCADE,
  UNIQUE (account_id, shadow_plan_id, bridge_audit_fingerprint)
);

CREATE INDEX IF NOT EXISTS target_shadow_comparisons_account_created_idx
  ON target_shadow_comparisons(account_id, created_at DESC);
