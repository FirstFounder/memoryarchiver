-- Add mid-session adjustment log column to plans
ALTER TABLE tesla_plans ADD COLUMN mid_session_adjustments_json TEXT;

-- Add adjuster settings to tesla_settings
ALTER TABLE tesla_settings ADD COLUMN intra_adjust_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tesla_settings ADD COLUMN intra_adjust_threshold_amps INTEGER NOT NULL DEFAULT 2;
ALTER TABLE tesla_settings ADD COLUMN intra_adjust_cron TEXT NOT NULL DEFAULT '0 22-23,0-7 * * *';
