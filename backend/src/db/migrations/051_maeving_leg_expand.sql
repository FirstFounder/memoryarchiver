-- Migration: expand maeving_sessions leg slots from 8 to 16
-- Matches column set/typing introduced for legs 5-8

ALTER TABLE maeving_sessions ADD COLUMN leg_9_trip_id INTEGER REFERENCES maeving_trips(id);
ALTER TABLE maeving_sessions ADD COLUMN leg_9_duration_min REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_9_rebel_cost REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_9_wh_per_mile REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_9_start_soc_pct REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_9_end_soc_pct REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_9_started_at TEXT;
ALTER TABLE maeving_sessions ADD COLUMN leg_9_ride_id INTEGER;

ALTER TABLE maeving_sessions ADD COLUMN leg_10_trip_id INTEGER REFERENCES maeving_trips(id);
ALTER TABLE maeving_sessions ADD COLUMN leg_10_duration_min REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_10_rebel_cost REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_10_wh_per_mile REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_10_start_soc_pct REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_10_end_soc_pct REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_10_started_at TEXT;
ALTER TABLE maeving_sessions ADD COLUMN leg_10_ride_id INTEGER;

ALTER TABLE maeving_sessions ADD COLUMN leg_11_trip_id INTEGER REFERENCES maeving_trips(id);
ALTER TABLE maeving_sessions ADD COLUMN leg_11_duration_min REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_11_rebel_cost REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_11_wh_per_mile REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_11_start_soc_pct REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_11_end_soc_pct REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_11_started_at TEXT;
ALTER TABLE maeving_sessions ADD COLUMN leg_11_ride_id INTEGER;

ALTER TABLE maeving_sessions ADD COLUMN leg_12_trip_id INTEGER REFERENCES maeving_trips(id);
ALTER TABLE maeving_sessions ADD COLUMN leg_12_duration_min REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_12_rebel_cost REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_12_wh_per_mile REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_12_start_soc_pct REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_12_end_soc_pct REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_12_started_at TEXT;
ALTER TABLE maeving_sessions ADD COLUMN leg_12_ride_id INTEGER;

ALTER TABLE maeving_sessions ADD COLUMN leg_13_trip_id INTEGER REFERENCES maeving_trips(id);
ALTER TABLE maeving_sessions ADD COLUMN leg_13_duration_min REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_13_rebel_cost REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_13_wh_per_mile REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_13_start_soc_pct REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_13_end_soc_pct REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_13_started_at TEXT;
ALTER TABLE maeving_sessions ADD COLUMN leg_13_ride_id INTEGER;

ALTER TABLE maeving_sessions ADD COLUMN leg_14_trip_id INTEGER REFERENCES maeving_trips(id);
ALTER TABLE maeving_sessions ADD COLUMN leg_14_duration_min REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_14_rebel_cost REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_14_wh_per_mile REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_14_start_soc_pct REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_14_end_soc_pct REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_14_started_at TEXT;
ALTER TABLE maeving_sessions ADD COLUMN leg_14_ride_id INTEGER;

ALTER TABLE maeving_sessions ADD COLUMN leg_15_trip_id INTEGER REFERENCES maeving_trips(id);
ALTER TABLE maeving_sessions ADD COLUMN leg_15_duration_min REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_15_rebel_cost REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_15_wh_per_mile REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_15_start_soc_pct REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_15_end_soc_pct REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_15_started_at TEXT;
ALTER TABLE maeving_sessions ADD COLUMN leg_15_ride_id INTEGER;

ALTER TABLE maeving_sessions ADD COLUMN leg_16_trip_id INTEGER REFERENCES maeving_trips(id);
ALTER TABLE maeving_sessions ADD COLUMN leg_16_duration_min REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_16_rebel_cost REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_16_wh_per_mile REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_16_start_soc_pct REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_16_end_soc_pct REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_16_started_at TEXT;
ALTER TABLE maeving_sessions ADD COLUMN leg_16_ride_id INTEGER;
