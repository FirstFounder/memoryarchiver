CREATE TABLE IF NOT EXISTS fleet_api_calls (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  vin        TEXT,
  endpoint   TEXT NOT NULL,
  method     TEXT NOT NULL DEFAULT 'GET',
  status     INTEGER,
  called_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_fleet_api_calls_called_at
  ON fleet_api_calls(called_at DESC);
