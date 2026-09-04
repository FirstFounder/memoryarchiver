import fs from 'fs';
import path from 'path';
import db from '../db/client.js';
import emitter from '../lib/emitter.js';
import config from '../config.js';
import { probe } from './ffprobe.js';
import { runPipeline } from './pipeline.js';
import { runSquatPipeline } from './squatEncoder.js';
import { isWithinNightWindow, reconcileSchedule, formatNight } from '../lib/nightQueue.js';

const POLL_INTERVAL_MS = 3_000;
// The nightly queue is re-packed on this cadence so jobs whose night passed
// while the server was down (or whose night overran its window) roll forward.
const RECONCILE_INTERVAL_MS = 60_000;
let running = false;
let pollTimer = null;
let reconcileTimer = null;

/**
 * On startup, reset any job that was marked 'processing' (i.e. interrupted by
 * a crash or restart) so it will be retried. A job that came from the nightly
 * queue goes back to 'scheduled' rather than 'pending' so a daytime restart
 * doesn't start a night job in the middle of the afternoon.
 */
function resetStalledJobs() {
  const n = db.prepare(`
    UPDATE jobs
       SET status = CASE WHEN scheduled_for IS NULL THEN 'pending' ELSE 'scheduled' END,
           progress = 0, ffmpeg_pid = NULL, updated_at = unixepoch()
     WHERE status = 'processing'
  `).run().changes;
  if (n > 0) console.log(`[worker] Reset ${n} stalled job(s).`);
}

/**
 * The next job eligible to run.
 *
 * Jobs queued for immediate encoding always win. Nightly jobs become eligible
 * once their assigned night has arrived and the clock is still inside the
 * night window — this is what replaces an external scheduler: the poll loop
 * itself is the trigger, so nothing needs a cron or Task Scheduler entry.
 */
function claimableJob() {
  const immediate = db.prepare(`
    SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1
  `).get();
  if (immediate) return immediate;

  if (!isWithinNightWindow()) return null;

  return db.prepare(`
    SELECT * FROM jobs
     WHERE status = 'scheduled' AND scheduled_for <= unixepoch()
     ORDER BY scheduled_for ASC, created_at ASC
     LIMIT 1
  `).get();
}

/**
 * Claim and process the next eligible job.
 */
async function tick() {
  if (running) return;

  const job = claimableJob();

  if (!job) return;

  running = true;
  try {
    await processJob(job);
  } catch (err) {
    console.error('[worker] Unexpected error outside job handler:', err);
  } finally {
    running = false;
  }
}

async function processJob(job) {
  db.prepare(`
    UPDATE jobs SET status = 'processing', updated_at = unixepoch() WHERE id = ?
  `).run(job.id);
  emit(job.id, { status: 'processing', progress: 0, output_filename: job.output_filename });

  try {
    const files = db.prepare(`
      SELECT * FROM job_files WHERE job_id = ? ORDER BY position ASC
    `).all(job.id);

    // Re-probe any files missing metadata (NAS-sourced files aren't probed at browse time)
    const fileMeta = await Promise.all(files.map(async f => {
      if (f.duration != null) return f;
      const meta = await probe(f.src_path);
      db.prepare(`
        UPDATE job_files SET duration=?, width=?, height=?, fps=? WHERE id=?
      `).run(meta.duration, meta.width, meta.height, meta.fps, f.id);
      return { ...f, ...meta };
    }));

    const srcPaths  = fileMeta.map(f => f.src_path);
    const outputFile = path.join(job.output_path, job.output_filename);

    const pipelineFn = config.squatEnabled ? runSquatPipeline : runPipeline;

    await pipelineFn({
      jobId: job.id,
      srcPaths,
      fileMeta,
      outputPath: outputFile,
      longDesc: job.long_desc,
      onProgress(pct) {
        db.prepare(`UPDATE jobs SET progress=?, updated_at=unixepoch() WHERE id=?`)
          .run(pct, job.id);
        emit(job.id, { status: 'processing', progress: pct, output_filename: job.output_filename });
      },
    });

    // Clean up temp upload files (files on the NAS scratch share are NOT deleted)
    const uploadTmp = process.env.UPLOAD_TEMP_DIR;
    if (uploadTmp) {
      for (const f of fileMeta) {
        if (f.src_path.startsWith(uploadTmp)) {
          try { fs.unlinkSync(f.src_path); } catch { /* best-effort */ }
        }
      }
    }

    db.prepare(`
      UPDATE jobs SET status='done', progress=1.0, updated_at=unixepoch() WHERE id=?
    `).run(job.id);
    emit(job.id, { status: 'done', progress: 1.0, output_filename: job.output_filename });

    // ── Auto-queue a file-level sync for the freshly encoded output ───────────
    // src  = the encoded file itself (rsync copies one file into the dest dir)
    // dest = mirror of output_path under SYNC_DEST_ROOT
    //        e.g. /volume1/RFA/Fam/April/2026 → /var/services/homes/noahRFA/Fam/April/2026
    if (config.deviceRole !== 'hub') {
      try {
        const relDir  = path.relative(config.nasOutputRoot, job.output_path);
        const syncSrc  = path.join(job.output_path, job.output_filename);
        const syncDest = path.join(config.syncDestRoot, relDir) + path.sep;

        db.prepare(`
          INSERT INTO sync_jobs (type, src, dest, label, encoding_job_id)
          VALUES ('file', ?, ?, ?, ?)
        `).run(syncSrc, syncDest, job.output_filename, job.id);

        emitter.emit('sync:update', {
          id:       null,   // client will refresh the list on next tick
          status:   'queued',
          label:    job.output_filename,
        });
      } catch (syncErr) {
        console.error('[worker] Failed to queue sync job:', syncErr.message);
      }
    } else {
      console.log(`[worker] Hub role — skipping post-encode sync for job ${job.id}`);
    }

  } catch (err) {
    console.error(`[worker] Job ${job.id} failed:`, err.message);
    db.prepare(`
      UPDATE jobs SET status='error', error_msg=?, updated_at=unixepoch() WHERE id=?
    `).run(err.message.slice(0, 2000), job.id);
    emit(job.id, { status: 'error', errorMsg: err.message.slice(0, 500) });
  }
}

function emit(jobId, payload) {
  emitter.emit('job:update', { id: jobId, ...payload });
}

/**
 * Re-pack the nightly queue and push any moves out over SSE.
 */
function reconcileNightly() {
  try {
    for (const row of reconcileSchedule(db)) {
      console.log(`[worker] Job ${row.id} rescheduled for ${formatNight(row.scheduled_for)}`);
      emit(row.id, { status: 'scheduled', scheduled_for: row.scheduled_for });
    }
  } catch (err) {
    console.error('[worker] Nightly reconcile failed:', err.message);
  }
}

export function startWorker() {
  resetStalledJobs();
  reconcileNightly();
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  reconcileTimer = setInterval(reconcileNightly, RECONCILE_INTERVAL_MS);
  tick(); // kick immediately
  console.log('[worker] Started — polling every', POLL_INTERVAL_MS, 'ms');
}

export function stopWorker() {
  if (pollTimer) clearInterval(pollTimer);
  if (reconcileTimer) clearInterval(reconcileTimer);
}
