ALTER TABLE tesla_sessions ADD COLUMN avg_charger_voltage REAL;
ALTER TABLE tesla_sessions ADD COLUMN max_charger_voltage REAL;
ALTER TABLE tesla_sessions ADD COLUMN avg_charger_current REAL;
ALTER TABLE tesla_sessions ADD COLUMN max_charger_current REAL;
ALTER TABLE tesla_sessions ADD COLUMN hourly_cost_dollars REAL;
ALTER TABLE tesla_sessions ADD COLUMN fixed_rate_cost_dollars REAL;
ALTER TABLE tesla_sessions ADD COLUMN hourly_savings_dollars REAL;
ALTER TABLE tesla_sessions ADD COLUMN mqtt_detected INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS tesla_readings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vin         TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  voltage     REAL,
  current_a   REAL,
  power_kw    REAL
);

CREATE INDEX IF NOT EXISTS idx_tesla_readings_vin_recorded
  ON tesla_readings(vin, recorded_at);
