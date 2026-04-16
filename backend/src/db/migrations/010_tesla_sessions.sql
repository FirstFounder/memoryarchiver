CREATE TABLE IF NOT EXISTS tesla_sessions (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  vin                     TEXT NOT NULL,
  plan_id                 INTEGER REFERENCES tesla_plans(id),
  source                  TEXT NOT NULL DEFAULT 'fleet',
  session_start           INTEGER,
  session_end             INTEGER,
  start_soc               INTEGER,
  end_soc                 INTEGER,
  kwh_added               REAL,
  predicted_cost_dollars  REAL,
  actual_cost_dollars     REAL,
  actual_prices_json      TEXT,
  created_at              INTEGER DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_tesla_sessions_vin
  ON tesla_sessions(vin, session_start DESC);
