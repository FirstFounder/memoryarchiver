CREATE TABLE IF NOT EXISTS tesla_plans (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  vin                        TEXT NOT NULL,
  computed_at                INTEGER NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'active',
  selected_strategy          TEXT,
  eligible_window_start      TEXT,
  window_start               TEXT,
  window_end                 TEXT,
  charge_amps                INTEGER,
  kwh_needed                 REAL,
  kwh_available              REAL,
  price_window_avg_cents     REAL,
  price_full_night_avg_cents REAL,
  cost_strategy_a_dollars    REAL,
  cost_strategy_b_dollars    REAL,
  overnight_low_f            REAL,
  min_rate_amps              INTEGER,
  alert                      TEXT,
  day_ahead_prices_json      TEXT,
  soc_at_set_time            INTEGER,
  charge_limit_at_set_time   INTEGER,
  scheduled_start_pushed     TEXT,
  charge_amps_pushed         INTEGER,
  created_at                 INTEGER DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_tesla_plans_vin_computed
  ON tesla_plans(vin, computed_at DESC);
