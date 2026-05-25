ALTER TABLE maeving_devices ADD COLUMN cost_free INTEGER NOT NULL DEFAULT 0;
UPDATE maeving_devices SET cost_free = 1 WHERE site_key = 'LF';
