-- Rebuild owntracks_locations with ON DELETE SET NULL instead of CASCADE
ALTER TABLE owntracks_locations RENAME TO owntracks_locations_old;

CREATE TABLE owntracks_locations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id        INTEGER REFERENCES maeving_rides(id) ON DELETE SET NULL,
  tst            INTEGER NOT NULL,
  lat            REAL    NOT NULL,
  lon            REAL    NOT NULL,
  alt            REAL,
  acc            REAL,
  vel            REAL,
  cog            REAL,
  batt           INTEGER,
  bs             INTEGER,
  conn           TEXT,
  motion         TEXT,
  ot_mode        INTEGER,
  temp_f         REAL,
  wind_speed_mph REAL,
  wind_dir_deg   REAL,
  recorded_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO owntracks_locations SELECT * FROM owntracks_locations_old;

DROP TABLE owntracks_locations_old;

CREATE INDEX IF NOT EXISTS idx_owntracks_ride_id ON owntracks_locations(ride_id);
CREATE INDEX IF NOT EXISTS idx_owntracks_tst     ON owntracks_locations(tst);

-- Add leg_N_ride_id columns to maeving_sessions (no FK — ride row may already be deleted)
ALTER TABLE maeving_sessions ADD COLUMN leg_1_ride_id INTEGER;
ALTER TABLE maeving_sessions ADD COLUMN leg_2_ride_id INTEGER;
ALTER TABLE maeving_sessions ADD COLUMN leg_3_ride_id INTEGER;
ALTER TABLE maeving_sessions ADD COLUMN leg_4_ride_id INTEGER;
ALTER TABLE maeving_sessions ADD COLUMN leg_5_ride_id INTEGER;
ALTER TABLE maeving_sessions ADD COLUMN leg_6_ride_id INTEGER;
ALTER TABLE maeving_sessions ADD COLUMN leg_7_ride_id INTEGER;
ALTER TABLE maeving_sessions ADD COLUMN leg_8_ride_id INTEGER;
