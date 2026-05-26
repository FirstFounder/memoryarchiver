ALTER TABLE maeving_sessions ADD COLUMN leg_5_trip_id INTEGER REFERENCES maeving_trips(id);
ALTER TABLE maeving_sessions ADD COLUMN leg_5_duration_min REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_5_rebel_cost REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_5_wh_per_mile REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_5_start_soc_pct REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_5_end_soc_pct REAL;

ALTER TABLE maeving_sessions ADD COLUMN leg_6_trip_id INTEGER REFERENCES maeving_trips(id);
ALTER TABLE maeving_sessions ADD COLUMN leg_6_duration_min REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_6_rebel_cost REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_6_wh_per_mile REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_6_start_soc_pct REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_6_end_soc_pct REAL;

ALTER TABLE maeving_sessions ADD COLUMN leg_7_trip_id INTEGER REFERENCES maeving_trips(id);
ALTER TABLE maeving_sessions ADD COLUMN leg_7_duration_min REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_7_rebel_cost REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_7_wh_per_mile REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_7_start_soc_pct REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_7_end_soc_pct REAL;

ALTER TABLE maeving_sessions ADD COLUMN leg_8_trip_id INTEGER REFERENCES maeving_trips(id);
ALTER TABLE maeving_sessions ADD COLUMN leg_8_duration_min REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_8_rebel_cost REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_8_wh_per_mile REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_8_start_soc_pct REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_8_end_soc_pct REAL;
