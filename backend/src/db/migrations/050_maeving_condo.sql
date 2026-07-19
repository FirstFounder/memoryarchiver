-- Per-session cost_free override: NULL = inherit device default, 0 = Hourly, 1 = Free
ALTER TABLE maeving_sessions ADD COLUMN cost_free INTEGER;

-- Insert Condo (AB) device: user selects Free or Hourly per session, no auto-probe, 95% SOC default
INSERT INTO maeving_devices (site_key, label, ip, mqtt_prefix, enabled, cost_free, auto_probe, default_soc_target)
VALUES ('AB', 'Condo', '192.168.215.99', 'AB-ShellyG4-Maeving1', 1, 0, 0, 95);
