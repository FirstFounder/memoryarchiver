CREATE TABLE IF NOT EXISTS tesla_manual_entries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  vin               TEXT NOT NULL,
  soc_pct           INTEGER NOT NULL,
  charge_limit_pct  INTEGER NOT NULL,
  hpwc_amps         INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  created_at        INTEGER DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_tesla_manual_entries_vin_status
  ON tesla_manual_entries(vin, status, created_at DESC);
