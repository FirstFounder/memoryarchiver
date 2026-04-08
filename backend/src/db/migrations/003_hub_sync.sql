-- Hub destination host registry
CREATE TABLE IF NOT EXISTS hub_destinations (
  id               INTEGER PRIMARY KEY,
  hostname         TEXT    NOT NULL UNIQUE,
  ip               TEXT    NOT NULL,
  mount_points     TEXT    NOT NULL,   -- JSON array; see mount_points schema in HUB_API_DESIGN.md
  mount_options    TEXT    NOT NULL,   -- full NFS mount option string
  enabled          INTEGER NOT NULL DEFAULT 1,
  schedule         TEXT    NOT NULL,   -- cron expression, America/Chicago
  bwlimit          INTEGER,            -- KB/s per rsync process; NULL = uncapped
  parallel         INTEGER NOT NULL DEFAULT 0, -- 1 = parallel rsync (bang); 0 = sequential
  ssh_key_path     TEXT,               -- NULL unless post-sync SSH needed (bang)
  last_sync_at     TEXT,               -- ISO timestamp of last successful sync
  last_error       TEXT,               -- last error message; NULL if last run succeeded
  last_attempt     TEXT,               -- ISO timestamp of last attempt (any outcome)
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Hub sync job history (one row per destination per scheduled or manual run)
CREATE TABLE IF NOT EXISTS hub_sync_jobs (
  id               INTEGER PRIMARY KEY,
  destination_id   INTEGER NOT NULL REFERENCES hub_destinations(id),
  started_at       TEXT    NOT NULL,
  finished_at      TEXT,               -- NULL while running
  status           TEXT    NOT NULL DEFAULT 'pending',
                                       -- pending | running | done | error | skipped
  skipped_reason   TEXT,               -- 'manifest_match' when status = 'skipped'
  progress         INTEGER,            -- 0–100 for sequential; NULL for bang (parallel)
  fam_bytes        INTEGER,
  vault_bytes      INTEGER,
  fam_status       TEXT,               -- 'done' | 'error'
  vault_status     TEXT,               -- 'done' | 'error'
  error_msg        TEXT,
  duration_seconds INTEGER,
  avg_bitrate_kbps INTEGER,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_hub_sync_jobs_destination
  ON hub_sync_jobs (destination_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_hub_sync_jobs_status
  ON hub_sync_jobs (status);

CREATE INDEX IF NOT EXISTS idx_hub_sync_jobs_started_at
  ON hub_sync_jobs (started_at DESC);

-- Seed destinations
-- mount_points includes dest_subdir per HUB_UI_DESIGN.md Session 4 decision:
--   bang: dest_subdir = null (mount point IS the tree root)
--   iolo/jaana/iron: dest_subdir = "Fam" or "Vault" (shared mount, subdirectory per tree)

INSERT OR IGNORE INTO hub_destinations
  (hostname, ip, mount_points, mount_options, enabled, schedule, bwlimit, parallel, ssh_key_path)
VALUES
  (
    'bang',
    '192.168.161.10',
    '[{"tree":"fam","remote":"bang:/mnt/sda3/RFA","local":"/mnt/hub/bang/fam","dest_subdir":null,"src":"/volume1/RFA/Fam/"},{"tree":"vault","remote":"bang:/mnt/sdb3/RFA","local":"/mnt/hub/bang/vault","dest_subdir":null,"src":"/volume1/RFA/Vault/"}]',
    'vers=3,rw,noatime,nolock,intr,tcp,actimeo=180,soft,timeo=30,retrans=3',
    1,
    '30 23 1 * *',
    5120,
    1,
    '/root/.ssh/hub_bang'
  ),
  (
    'iolo',
    '192.168.106.6',
    '[{"tree":"fam","remote":"iolo:/volume1/RFA","local":"/mnt/hub/iolo","dest_subdir":"Fam","src":"/volume1/RFA/Fam/"},{"tree":"vault","remote":"iolo:/volume1/RFA","local":"/mnt/hub/iolo","dest_subdir":"Vault","src":"/volume1/RFA/Vault/"}]',
    'vers=3,rw,noatime,intr,tcp,actimeo=180,soft,timeo=30,retrans=3',
    1,
    '30 23 * * *',
    NULL,
    0,
    NULL
  ),
  (
    'jaana',
    '192.168.121.6',
    '[{"tree":"fam","remote":"jaana:/volume1/RFA","local":"/mnt/hub/jaana","dest_subdir":"Fam","src":"/volume1/RFA/Fam/"},{"tree":"vault","remote":"jaana:/volume1/RFA","local":"/mnt/hub/jaana","dest_subdir":"Vault","src":"/volume1/RFA/Vault/"}]',
    'vers=3,rw,noatime,intr,tcp,actimeo=180,soft,timeo=30,retrans=3',
    1,
    '30 23 * * *',
    NULL,
    0,
    NULL
  ),
  (
    'iron',
    '192.168.104.6',
    '[{"tree":"fam","remote":"iron:/mnt/fats/RFA","local":"/mnt/hub/iron","dest_subdir":"Fam","src":"/volume1/RFA/Fam/"},{"tree":"vault","remote":"iron:/mnt/fats/RFA","local":"/mnt/hub/iron","dest_subdir":"Vault","src":"/volume1/RFA/Vault/"}]',
    'vers=3,rw,noatime,intr,tcp,actimeo=180,soft,timeo=30,retrans=3',
    1,
    '30 23 * * 0',
    640,
    0,
    NULL
  );
