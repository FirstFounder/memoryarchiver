CREATE TABLE IF NOT EXISTS bugout_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  profile     TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  tags        TEXT DEFAULT '',        -- comma-delimited
  is_overnight INTEGER NOT NULL DEFAULT 0,  -- 1 = auto-populate when overnight activity selected
  is_hidden   INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bugout_items_profile
  ON bugout_items(profile, is_hidden, sort_order);

CREATE TABLE IF NOT EXISTS bugout_activities (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  profile      TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  tags         TEXT DEFAULT '',       -- comma-delimited
  is_overnight INTEGER NOT NULL DEFAULT 0,  -- 1 = this is an overnight activity
  is_hidden    INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bugout_activities_profile
  ON bugout_activities(profile, is_hidden, sort_order);

-- Persisted checklist state per profile
CREATE TABLE IF NOT EXISTS bugout_checklist (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  profile       TEXT NOT NULL,
  entity_type   TEXT NOT NULL CHECK(entity_type IN ('item', 'activity')),
  entity_id     INTEGER NOT NULL,
  is_checked    INTEGER NOT NULL DEFAULT 1,
  source        TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'auto'
  auto_from_activity_id INTEGER,                 -- activity that triggered auto-population
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(profile, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_bugout_checklist_profile
  ON bugout_checklist(profile, entity_type);
