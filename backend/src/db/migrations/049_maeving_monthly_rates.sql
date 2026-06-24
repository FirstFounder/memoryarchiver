CREATE TABLE IF NOT EXISTS maeving_monthly_rates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  rate_month      TEXT NOT NULL UNIQUE, -- 'YYYY-MM' calendar month these rates are effective
  cfra_cents      REAL,                 -- Combined CFRA total (¢/kWh); negative = credit
  cfra_partial    INTEGER NOT NULL DEFAULT 0, -- 1 = CFRMR was TBD; only CFR Adjustment stored
  pea_cents       REAL,                 -- PEA Hourly factor (¢/kWh); negative = credit
  cfra_fetched_at TEXT,                 -- ISO timestamp of last successful CFRA scrape
  pea_fetched_at  TEXT,                 -- ISO timestamp of last successful PEA scrape
  cfra_status     TEXT NOT NULL DEFAULT 'pending', -- 'ok' | 'partial' | 'fail' | 'pending'
  pea_status      TEXT NOT NULL DEFAULT 'pending', -- 'ok' | 'fail' | 'pending'
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Seed the current month with known June 2026 values
INSERT OR IGNORE INTO maeving_monthly_rates
  (rate_month, cfra_cents, cfra_partial, pea_cents, cfra_status, pea_status,
   cfra_fetched_at, pea_fetched_at)
VALUES
  ('2026-06', -1.344, 0, NULL, 'ok', 'pending', datetime('now'), NULL);
