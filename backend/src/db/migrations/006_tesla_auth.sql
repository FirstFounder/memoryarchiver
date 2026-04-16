CREATE TABLE IF NOT EXISTS tesla_auth (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  client_id               TEXT,
  client_secret           TEXT,
  access_token            TEXT,
  refresh_token           TEXT,
  access_token_expires_at INTEGER,
  updated_at              INTEGER DEFAULT (unixepoch() * 1000)
);

INSERT OR IGNORE INTO tesla_auth (id) VALUES (1);
