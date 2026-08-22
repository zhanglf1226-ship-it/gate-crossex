CREATE TABLE IF NOT EXISTS target_shadow_plans (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  creator_user_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  position_fingerprint TEXT NOT NULL,
  plan_fingerprint TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  target_state_json TEXT NOT NULL,
  compiled_plan_json TEXT NOT NULL,
  execution_allowed INTEGER NOT NULL DEFAULT 0 CHECK (execution_allowed = 0),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS target_shadow_plans_account_fingerprint_idx
  ON target_shadow_plans(account_id, plan_fingerprint);

CREATE UNIQUE INDEX IF NOT EXISTS target_shadow_plans_idempotency_idx
  ON target_shadow_plans(account_id, request_hash, position_fingerprint, compiler_version);

CREATE INDEX IF NOT EXISTS target_shadow_plans_account_created_idx
  ON target_shadow_plans(account_id, created_at DESC);
