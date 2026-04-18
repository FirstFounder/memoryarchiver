ALTER TABLE tesla_sessions ADD COLUMN charger_voltage REAL;
ALTER TABLE tesla_sessions ADD COLUMN charger_actual_current REAL;
ALTER TABLE tesla_sessions ADD COLUMN charger_power REAL;
ALTER TABLE tesla_sessions ADD COLUMN charger_phases INTEGER;
ALTER TABLE tesla_sessions ADD COLUMN charge_energy_added REAL;
ALTER TABLE tesla_sessions ADD COLUMN kwh_used REAL;
ALTER TABLE tesla_sessions ADD COLUMN efficiency_pct REAL;
ALTER TABLE tesla_sessions ADD COLUMN battery_heater_on INTEGER;
ALTER TABLE tesla_sessions ADD COLUMN overnight_low_f REAL;
ALTER TABLE tesla_sessions ADD COLUMN suspect INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tesla_sessions ADD COLUMN suspect_reason TEXT;

ALTER TABLE tesla_settings ADD COLUMN morning_cron TEXT NOT NULL DEFAULT '30 9 * * *';
ALTER TABLE tesla_settings ADD COLUMN min_sessions_for_capacity INTEGER NOT NULL DEFAULT 5;
ALTER TABLE tesla_settings ADD COLUMN capacity_update_interval INTEGER NOT NULL DEFAULT 10;

UPDATE tesla_config
SET pack_swap_date = '2025-10-17'
WHERE vin = '5YJSA1CN8CFP01703';
