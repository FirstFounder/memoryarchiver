PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  status          TEXT    NOT NULL DEFAULT 'pending',
  -- 'pending' | 'processing' | 'done' | 'error'
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  output_dest     TEXT    NOT NULL,   -- 'fam' | 'vault'
  short_desc      TEXT    NOT NULL,
  long_desc       TEXT    NOT NULL DEFAULT '',
  output_filename TEXT,               -- set at job creation once version is known
  output_path     TEXT,               -- full directory path (not including filename)
  earliest_ts     TEXT,               -- ISO-8601 local datetime of earliest clip
  version         INTEGER,            -- VV (0-based; 00 in filename)
  progress        REAL    NOT NULL DEFAULT 0.0,  -- 0.0 – 1.0
  error_msg       TEXT,
  ffmpeg_pid      INTEGER
);

CREATE TABLE IF NOT EXISTS job_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,       -- display / encode order (0-based)
  src_path    TEXT    NOT NULL,       -- absolute path on the NAS filesystem
  duration    REAL,                   -- seconds from ffprobe
  width       INTEGER,
  height      INTEGER,
  fps         REAL,
  created_ts  TEXT                    -- ISO-8601 local datetime from MOV metadata
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
