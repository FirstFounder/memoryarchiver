CREATE TABLE IF NOT EXISTS maeving_rides (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id      INTEGER NOT NULL REFERENCES maeving_trips(id),
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  duration_min REAL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
