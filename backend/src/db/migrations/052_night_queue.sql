-- Nightly encode queue.
--
-- Jobs submitted with the "tonight" option are stored with status 'scheduled'
-- and a scheduled_for timestamp: the unix epoch of the NIGHT_QUEUE_START_HOUR
-- boundary (1:00 AM America/Chicago by default) of the night they were
-- assigned to.  The worker promotes them once that boundary has passed and the
-- current time is still inside the night window.
--
--   scheduled_for IS NULL  → run as soon as the worker is free (old behaviour)
--   status 'scheduled'     → waiting for its night
--
-- scheduled_for is kept after a job starts so the night it consumed a slot on
-- remains countable (see lib/nightQueue.js).
ALTER TABLE jobs ADD COLUMN scheduled_for INTEGER;

CREATE INDEX IF NOT EXISTS idx_jobs_scheduled ON jobs(status, scheduled_for);
