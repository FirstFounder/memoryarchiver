CREATE TABLE IF NOT EXISTS maeving_charge_curves (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      INTEGER NOT NULL REFERENCES maeving_sessions(id) ON DELETE CASCADE,
  device_id       INTEGER NOT NULL REFERENCES maeving_devices(id),
  recorded_at     TEXT NOT NULL DEFAULT (datetime('now')),

  taper_onset_wh_delivered   REAL,
  taper_onset_soc_pct        REAL,
  taper_onset_watts          REAL,
  taper_onset_minutes        REAL,

  peak_watts_session         REAL,
  readings_count             INTEGER,

  -- Array of {t: minutes_from_start, w: watts} objects, sampled/decimated to <=60 points
  power_timeline_json        TEXT
);

CREATE INDEX IF NOT EXISTS idx_charge_curves_session
  ON maeving_charge_curves(session_id);

CREATE INDEX IF NOT EXISTS idx_charge_curves_device
  ON maeving_charge_curves(device_id, recorded_at DESC);
