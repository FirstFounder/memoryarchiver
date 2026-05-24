CREATE TABLE maeving_trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT NOT NULL,
  distance_miles REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE maeving_sessions ADD COLUMN trip_id INTEGER REFERENCES maeving_trips(id);
ALTER TABLE maeving_sessions ADD COLUMN trip_duration_min INTEGER;
ALTER TABLE maeving_sessions ADD COLUMN charge_mode TEXT NOT NULL DEFAULT 'now';
ALTER TABLE maeving_sessions ADD COLUMN scheduled_start_at TEXT;
ALTER TABLE maeving_sessions ADD COLUMN departure_time TEXT;
ALTER TABLE maeving_sessions ADD COLUMN estimated_cost_dollars REAL;
ALTER TABLE maeving_sessions ADD COLUMN actual_cost_dollars REAL;
ALTER TABLE maeving_sessions ADD COLUMN price_window_avg_cents REAL;
