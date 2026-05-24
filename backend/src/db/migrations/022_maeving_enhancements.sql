-- Trip legs on sessions (fixed columns, 0-4 legs)
ALTER TABLE maeving_sessions ADD COLUMN leg_1_trip_id INTEGER REFERENCES maeving_trips(id);
ALTER TABLE maeving_sessions ADD COLUMN leg_1_duration_min INTEGER;
ALTER TABLE maeving_sessions ADD COLUMN leg_2_trip_id INTEGER REFERENCES maeving_trips(id);
ALTER TABLE maeving_sessions ADD COLUMN leg_2_duration_min INTEGER;
ALTER TABLE maeving_sessions ADD COLUMN leg_3_trip_id INTEGER REFERENCES maeving_trips(id);
ALTER TABLE maeving_sessions ADD COLUMN leg_3_duration_min INTEGER;
ALTER TABLE maeving_sessions ADD COLUMN leg_4_trip_id INTEGER REFERENCES maeving_trips(id);
ALTER TABLE maeving_sessions ADD COLUMN leg_4_duration_min INTEGER;

-- Post-charge calibration
ALTER TABLE maeving_sessions ADD COLUMN actual_soc_pct INTEGER;
ALTER TABLE maeving_sessions ADD COLUMN calibration_complete INTEGER NOT NULL DEFAULT 0;

-- Global config / calibration state (single row, id=1)
CREATE TABLE maeving_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  effective_capacity_wh REAL NOT NULL DEFAULT 2880,
  prev_max_soc_pct INTEGER,              -- last achieved SOC, global across all sites
  prev_session_id INTEGER REFERENCES maeving_sessions(id),
  calibration_mode INTEGER NOT NULL DEFAULT 1,  -- 1 = blocking calibration period
  observation_count INTEGER NOT NULL DEFAULT 0,  -- how many calibration entries recorded
  capacity_history_json TEXT NOT NULL DEFAULT '[]'  -- JSON array of {session_id, observed_wh, soc_delta, updated_at}
);

INSERT INTO maeving_config (id) VALUES (1);

-- Taper readings for 100% target sessions (separate high-resolution table)
CREATE TABLE maeving_taper_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES maeving_sessions(id),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  apower REAL NOT NULL,
  aenergy_total REAL NOT NULL,
  estimated_soc REAL  -- computed: soc_start + (wh_since_start / effective_capacity) * 100
);
