CREATE TABLE IF NOT EXISTS order_previews (
  id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  canonical_order_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED')),
  idempotency_key TEXT,
  planned_order_id TEXT,
  planned_client_order_id TEXT,
  execution_order_id TEXT,
  failure_code TEXT,
  consumed_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (execution_order_id) REFERENCES execution_orders(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS order_previews_idempotency_idx
  ON order_previews(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS order_previews_expiry_status_idx
  ON order_previews(status, expires_at);
