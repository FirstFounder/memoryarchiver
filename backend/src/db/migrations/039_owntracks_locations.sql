CREATE TABLE IF NOT EXISTS owntracks_locations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id        INTEGER NOT NULL REFERENCES maeving_rides(id) ON DELETE CASCADE,
  tst            INTEGER NOT NULL,          -- OwnTracks unix timestamp (device time)
  lat            REAL    NOT NULL,
  lon            REAL    NOT NULL,
  alt            REAL,                      -- altitude meters
  acc            REAL,                      -- horizontal accuracy meters
  vel            REAL,                      -- velocity kph (OwnTracks omits when 0)
  cog            REAL,                      -- course over ground degrees (0–360)
  batt           INTEGER,                   -- phone battery %
  bs             INTEGER,                   -- battery state (1=unplugged, 2=charging)
  conn           TEXT,                      -- connection type: 'm'=cellular, 'w'=wifi
  motion         TEXT,                      -- primary motion activity (automotive/walking/stationary)
  ot_mode        INTEGER,                   -- OwnTracks monitoring mode (1=Significant, 2=Move)
  -- weather (fetched from Open-Meteo current API at ping time)
  temp_f         REAL,                      -- temperature °F
  wind_speed_mph REAL,                      -- wind speed mph (converted from km/h)
  wind_dir_deg   REAL,                      -- wind direction degrees (meteorological)
  recorded_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_owntracks_ride_id ON owntracks_locations(ride_id);
CREATE INDEX IF NOT EXISTS idx_owntracks_tst     ON owntracks_locations(tst);
