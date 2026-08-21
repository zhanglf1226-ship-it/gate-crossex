CREATE TABLE IF NOT EXISTS execution_risk_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  kill_switch INTEGER NOT NULL CHECK (kill_switch IN (0, 1)),
  close_only INTEGER NOT NULL CHECK (close_only IN (0, 1)),
  max_order_notional TEXT NOT NULL,
  max_order_quantity TEXT NOT NULL,
  max_daily_notional TEXT NOT NULL,
  allowed_symbols_json TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO execution_risk_guard
  (id, kill_switch, close_only, max_order_notional, max_order_quantity,
   max_daily_notional, allowed_symbols_json, updated_by, updated_at)
VALUES (1, 1, 1, '1000', '1', '5000', '[]', NULL, '1970-01-01T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS execution_risk_reservations (
  reservation_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('preview', 'order')),
  account_id TEXT NOT NULL,
  notional TEXT NOT NULL,
  utc_day TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS execution_risk_reservations_account_day_idx
  ON execution_risk_reservations(account_id, utc_day);

CREATE INDEX IF NOT EXISTS order_previews_account_consumed_idx
  ON order_previews(account_id, consumed_at)
  WHERE consumed_at IS NOT NULL;
