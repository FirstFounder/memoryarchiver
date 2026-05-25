-- EIA gas price cache columns on maeving_config
ALTER TABLE maeving_config ADD COLUMN eia_gas_price_dollars REAL;
ALTER TABLE maeving_config ADD COLUMN eia_gas_price_fetched_at TEXT;
-- Rebel cost columns on maeving_sessions (per-leg + total)
ALTER TABLE maeving_sessions ADD COLUMN leg_1_rebel_cost REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_2_rebel_cost REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_3_rebel_cost REAL;
ALTER TABLE maeving_sessions ADD COLUMN leg_4_rebel_cost REAL;
ALTER TABLE maeving_sessions ADD COLUMN rebel_cost_total REAL;
ALTER TABLE maeving_sessions ADD COLUMN rebel_cost_stale INTEGER NOT NULL DEFAULT 0;
