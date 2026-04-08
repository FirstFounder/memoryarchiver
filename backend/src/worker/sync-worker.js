import db from '../db/client.js';
import emitter from '../lib/emitter.js';
import { runRsync } from './rsync.js';
import { writeManifest } from '../lib/manifest.js';

const POLL_INTERVAL_MS = 3_000;
let running = false;
let pollTimer = null;

/**
 * Reset any sync_job left in 'syncing' state (e.g. from a crash/restart)
 * back to 'pending' so it will be retried automatically.
 */
function resetStalledSyncJobs() {
  const n = db.prepare(`
    UPDATE sync_jobs
    SET status = 'pending', progress = 0, updated_at = unixepoch()
    WHERE status = 'syncing'
  `).run().changes;
  if (n > 0) console.log(`[sync-worker] Reset ${n} stalled sync job(s) to pending.`);
}

async function tick() {
  if (running) return;

  const job = db.prepare(`
    SELECT * FROM sync_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1
  `).get();

  if (!job) return;

  running = true;
  try {
    await processSyncJob(job);
  } catch (err) {
    console.error('[sync-worker] Unexpected error outside job handler:', err);
  } finally {
    running = false;
  }
}

async function processSyncJob(job) {
  db.prepare(`
    UPDATE sync_jobs SET status = 'syncing', updated_at = unixepoch() WHERE id = ?
  `).run(job.id);
  emit(job.id, { status: 'syncing', progress: 0, label: job.label, type: job.type });

  try {
    await runRsync({
      src:  job.src,
      dest: job.dest,
      onProgress(pct) {
        db.prepare(`UPDATE sync_jobs SET progress = ?, updated_at = unixepoch() WHERE id = ?`)
          .run(pct, job.id);
        emit(job.id, { status: 'syncing', progress: pct, label: job.label, type: job.type });
      },
    });

    db.prepare(`
      UPDATE sync_jobs SET status = 'done', progress = 1.0, updated_at = unixepoch() WHERE id = ?
    `).run(job.id);
    emit(job.id, { status: 'done', progress: 1.0, label: job.label, type: job.type });

    // Write inbound manifest for iolo/jaana so the hub worker can skip unnecessary
    // outbound syncs when noah's tree already reflects what the remote pushed.
    // src uses rsync remote syntax (e.g. "iolo:/volume1/RFA/") — extract hostname.
    const inboundHost = extractRsyncHost(job.src);
    if (inboundHost && ['iolo', 'jaana'].includes(inboundHost)) {
      try {
        await writeManifest({
          sourcePath: '/volume1/RFA',
          outputPath: `/volume1/RFA/scratch/${inboundHost}Manifest.txt`,
        });
      } catch (err) {
        console.warn(`[sync-worker] writeManifest failed for inbound job ${job.id}:`, err.message);
        // non-fatal: inbound sync succeeded; manifest is a convenience for hub worker
      }
    }

  } catch (err) {
    console.error(`[sync-worker] Sync job ${job.id} failed:`, err.message);
    db.prepare(`
      UPDATE sync_jobs SET status = 'error', error_msg = ?, updated_at = unixepoch() WHERE id = ?
    `).run(err.message.slice(0, 2000), job.id);
    emit(job.id, { status: 'error', errorMsg: err.message.slice(0, 500), label: job.label, type: job.type });
  }
}

function emit(syncJobId, payload) {
  emitter.emit('sync:update', { id: syncJobId, ...payload });
}

export function startSyncWorker() {
  resetStalledSyncJobs();
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  tick();
  console.log('[sync-worker] Started — polling every', POLL_INTERVAL_MS, 'ms');
}

export function stopSyncWorker() {
  if (pollTimer) clearInterval(pollTimer);
}

/**
 * Extract the hostname from an rsync remote-syntax source path.
 * Matches: [user@]host:/path  →  host (lowercase)
 * Returns null for plain local paths.
 */
function extractRsyncHost(src) {
  const m = src?.match(/^(?:[^@/]+@)?([a-zA-Z0-9_.-]+):/);
  return m ? m[1].toLowerCase() : null;
}
