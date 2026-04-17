CREATE TABLE IF NOT EXISTS tesla_settings (
  id                           INTEGER PRIMARY KEY CHECK (id = 1),
  variance_threshold_cents     REAL    NOT NULL DEFAULT 1.5,
  burst_pref_threshold_dollars REAL    NOT NULL DEFAULT 0.50,
  winter_temp_high_f           REAL    NOT NULL DEFAULT 40.0,
  winter_temp_low_f            REAL    NOT NULL DEFAULT 25.0,
  winter_min_amps_mid          INTEGER NOT NULL DEFAULT 8,
  winter_min_amps_cold         INTEGER NOT NULL DEFAULT 16,
  soc_drop_reset_pct           INTEGER NOT NULL DEFAULT 5,
  early_window_open_hour       INTEGER NOT NULL DEFAULT 22,
  eval_cron                    TEXT    NOT NULL DEFAULT '45 21 * * *',
  updated_at                   INTEGER DEFAULT (unixepoch() * 1000)
);

INSERT OR IGNORE INTO tesla_settings (id) VALUES (1);
