CREATE TABLE maeving_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  ip TEXT NOT NULL,
  mqtt_prefix TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE maeving_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES maeving_devices(id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  soc_start_pct INTEGER,
  soc_target_pct INTEGER,
  wh_delivered REAL,
  peak_watts REAL,
  avg_watts REAL,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE maeving_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES maeving_devices(id),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  apower REAL,
  current REAL,
  voltage REAL,
  aenergy_total REAL
);

INSERT INTO maeving_devices (site_key, label, ip, mqtt_prefix) VALUES
  ('BG', 'Buffalo Grove', '192.168.106.148', 'BG-ShellyG4-Maeving1'),
  ('MH', 'McHenry',       '192.168.104.0',   'MH-ShellyG4-Maeving1'),
  ('LF', 'Lake Forest',   '192.168.21.0',    'LF-ShellyG4-Maeving1');
