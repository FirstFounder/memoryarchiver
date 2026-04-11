-- Coop scheduled check log
-- One row per automatic post-schedule check (fired 5 minutes after OPEN_AT and CLOSE_AT).
CREATE TABLE IF NOT EXISTS coop_checks (
  id             INTEGER PRIMARY KEY,
  checked_at     TEXT    NOT NULL,   -- ISO timestamp (datetime('now'))
  check_type     TEXT    NOT NULL,   -- 'open_check' | 'close_check'
  expected_state TEXT    NOT NULL,   -- 'open' | 'closed'
  actual_state   TEXT,               -- 'open' | 'closed' | 'moving' | NULL if unreachable
  scheduler_active INTEGER,          -- 1 | 0 | NULL if unreachable
  open_at        TEXT,               -- OPEN_AT read from janus at check time
  close_at       TEXT,               -- CLOSE_AT read from janus at check time
  mismatch       INTEGER NOT NULL DEFAULT 0,  -- 1 if actual_state != expected_state
  alert_sent     INTEGER NOT NULL DEFAULT 0,  -- 1 if email alert was sent
  janus_error    TEXT,               -- error string if SSH or parse failed; NULL on success
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_coop_checks_checked_at
  ON coop_checks (checked_at DESC);
