CREATE TABLE IF NOT EXISTS tesla_config (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  vin                     TEXT NOT NULL UNIQUE,
  nickname                TEXT NOT NULL,
  mode                    TEXT NOT NULL DEFAULT 'connectivity',
  departure_time          TEXT NOT NULL DEFAULT '07:00',
  pack_capacity_kwh       REAL NOT NULL DEFAULT 75.0,
  normal_charge_amps      INTEGER NOT NULL DEFAULT 24,
  last_hpwc_amps          INTEGER NOT NULL DEFAULT 48,
  last_charge_limit_pct   INTEGER NOT NULL DEFAULT 90,
  pack_swap_date          TEXT,
  created_at              INTEGER DEFAULT (unixepoch() * 1000),
  updated_at              INTEGER DEFAULT (unixepoch() * 1000)
);

INSERT OR IGNORE INTO tesla_config (vin, nickname, mode, departure_time, last_hpwc_amps, last_charge_limit_pct)
VALUES
  ('5YJSA1H42FF096078', '2015', 'connectivity', '07:30', 48, 90),
  ('5YJSA1CN8CFP01703', '2012', 'connectivity', '08:00', 80, 85);
