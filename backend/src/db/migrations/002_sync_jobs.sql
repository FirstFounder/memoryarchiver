CREATE TABLE IF NOT EXISTS sync_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  status          TEXT    NOT NULL DEFAULT 'pending',
  -- 'pending' | 'syncing' | 'done' | 'error'
  type            TEXT    NOT NULL DEFAULT 'file',
  -- 'file'  — single encoded output file, auto-queued after encode
  -- 'tree'  — full /volume1/RFA → noahRFA sync, manually triggered
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  src             TEXT    NOT NULL,   -- rsync source path
  dest            TEXT    NOT NULL,   -- rsync destination path
  label           TEXT    NOT NULL,   -- display name shown in UI
  encoding_job_id INTEGER,            -- FK to jobs(id), NULL for manual tree syncs
  progress        REAL    NOT NULL DEFAULT 0.0,  -- 0.0 – 1.0
  error_msg       TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_status ON sync_jobs(status);
