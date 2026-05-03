-- Audio file records: one row per imported .m4a voice memo
CREATE TABLE IF NOT EXISTS audio_files (
  id                  TEXT PRIMARY KEY,
  original_name       TEXT NOT NULL,
  file_path           TEXT NOT NULL UNIQUE,   -- /volume1/RFA/Audio/raw/<uuid>.m4a
  meta_path           TEXT NOT NULL UNIQUE,   -- /volume1/RFA/Audio/meta/<uuid>.json

  -- ffprobe-extracted fields
  duration_sec        REAL,
  bit_rate            INTEGER,
  file_size           INTEGER,
  created_at_source   TEXT,                   -- format_tags.creation_time (ISO 8601 UTC)
  title               TEXT,                   -- format_tags.title (user-named in Voice Memos)
  location            TEXT,                   -- ISO 6709 string e.g. "+41.8781-087.6298/"
  encoder             TEXT,                   -- format_tags.encoder

  raw_meta_json       TEXT NOT NULL,          -- full ffprobe format JSON blob

  -- transcription state
  transcript_status   TEXT NOT NULL DEFAULT 'pending',
  -- pending | queued | processing | done | error
  transcript_text     TEXT,                   -- plain-text copy for FTS indexing
  transcript_model    TEXT,
  transcribed_at      TEXT,
  transcript_error    TEXT,

  imported_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- FTS5 full-text search over transcript text and file metadata
CREATE VIRTUAL TABLE IF NOT EXISTS audio_fts USING fts5(
  id UNINDEXED,
  original_name,
  title,
  transcript_text,
  content='audio_files',
  content_rowid='rowid'
);

-- Keep FTS index in sync with audio_files via triggers
CREATE TRIGGER IF NOT EXISTS audio_fts_insert AFTER INSERT ON audio_files BEGIN
  INSERT INTO audio_fts(rowid, id, original_name, title, transcript_text)
  VALUES (new.rowid, new.id, new.original_name, new.title, new.transcript_text);
END;

CREATE TRIGGER IF NOT EXISTS audio_fts_update AFTER UPDATE ON audio_files BEGIN
  INSERT INTO audio_fts(audio_fts, rowid, id, original_name, title, transcript_text)
  VALUES ('delete', old.rowid, old.id, old.original_name, old.title, old.transcript_text);
  INSERT INTO audio_fts(rowid, id, original_name, title, transcript_text)
  VALUES (new.rowid, new.id, new.original_name, new.title, new.transcript_text);
END;

CREATE TRIGGER IF NOT EXISTS audio_fts_delete AFTER DELETE ON audio_files BEGIN
  INSERT INTO audio_fts(audio_fts, rowid, id, original_name, title, transcript_text)
  VALUES ('delete', old.rowid, old.id, old.original_name, old.title, old.transcript_text);
END;
