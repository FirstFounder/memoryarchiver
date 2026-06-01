-- Auto-probe: if true, scheduler turns plug on at 2 AM CT, probes for load,
-- creates a session if charging detected, shuts off if not.
ALTER TABLE maeving_devices ADD COLUMN auto_probe INTEGER NOT NULL DEFAULT 0;
-- Default overnight SOC target used when auto-probe creates a session.
-- Also used by the frontend SITE_DEFAULT_SOC map (replaces hardcoded constant).
ALTER TABLE maeving_devices ADD COLUMN default_soc_target INTEGER NOT NULL DEFAULT 95;
-- Set auto_probe=1 for BG and MH; LF stays at 0.
UPDATE maeving_devices SET auto_probe = 1 WHERE site_key IN ('BG', 'MH');
-- Per-site default SOC targets: BG=40, MH=95, LF=95
UPDATE maeving_devices SET default_soc_target = 40 WHERE site_key = 'BG';
UPDATE maeving_devices SET default_soc_target = 95 WHERE site_key = 'MH';
UPDATE maeving_devices SET default_soc_target = 95 WHERE site_key = 'LF';
