-- Track copied (shared) items/activities: origin_profile + origin_id are NULL for native rows
ALTER TABLE bugout_items ADD COLUMN origin_profile TEXT;
ALTER TABLE bugout_items ADD COLUMN origin_id INTEGER;

ALTER TABLE bugout_activities ADD COLUMN origin_profile TEXT;
ALTER TABLE bugout_activities ADD COLUMN origin_id INTEGER;
