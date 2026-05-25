-- Hypothetical hourly cost for cost_free (LF) sessions — what it would have
-- cost at home on the ComEd hourly plan. NULL for BG/MH sessions.
ALTER TABLE maeving_sessions ADD COLUMN lf_equivalent_cost_dollars REAL;

-- Hypothetical fixed-rate cost for LF sessions. NULL for BG/MH sessions.
ALTER TABLE maeving_sessions ADD COLUMN lf_equivalent_fixed_dollars REAL;

-- Running accumulated savings in maeving_config.
-- BG/MH contribution: (fixed_rate_cost_dollars - actual_cost_dollars) per session,
-- floor at zero per session before adding.
-- LF contribution: lf_equivalent_cost_dollars per session (always >= 0 since actual = $0).
-- Floor: the running total never goes below 0.
ALTER TABLE maeving_config ADD COLUMN running_savings_dollars REAL NOT NULL DEFAULT 0;
