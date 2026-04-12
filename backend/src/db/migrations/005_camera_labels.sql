-- Display labels for camera streams.
-- Keyed on the mediamtx path name (e.g. "live/coopdoor").
-- Seeded automatically by GET /api/hub/cameras on first encounter.
CREATE TABLE IF NOT EXISTS camera_labels (
  path        TEXT PRIMARY KEY,   -- mediamtx path, e.g. "live/coopdoor"
  display     TEXT NOT NULL,      -- user-editable display name
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
