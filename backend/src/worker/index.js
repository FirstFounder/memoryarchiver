import fs from 'fs';
import path from 'path';
import db from '../db/client.js';
import emitter from '../lib/emitter.js';
import { probe } from './ffprobe.js';
import { runPipeline } from './pipeline.js';

const POLL_INTERVAL_MS = 3_000;
let running = false;
let pollTimer = null;

/**
 * On startup, reset any job that was marked 'processing' (i.e. interrupted by
 * a crash or restart) back to 'pending' so it will be retried.
 */
function resetStalledJobs() {
  const n = db.prepare(`
    UPDATE jobs SET status = 'pending', progress = 0, ffmpeg_pid = NULL,
                   updated_at = unixepoch()
    WHERE status = 'processing'
  `).run().changes;
  if (n > 0) console.log(`[worker] Reset ${n} stalled job(s) to pending.`);
}

/**
 * Claim and process the oldest pending job.
 */
async function tick() {
  if (running) return;

  const job = db.prepare(`
    SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1
  `).get();

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
  emit(job.id, { status: 'processing', progress: 0 });

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

    await runPipeline({
      srcPaths,
      fileMeta,
      outputPath: outputFile,
      longDesc: job.long_desc,
      onProgress(pct) {
        db.prepare(`UPDATE jobs SET progress=?, updated_at=unixepoch() WHERE id=?`)
          .run(pct, job.id);
        emit(job.id, { status: 'processing', progress: pct });
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
    emit(job.id, { status: 'done', progress: 1.0, outputFilename: job.output_filename });

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

export function startWorker() {
  resetStalledJobs();
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  tick(); // kick immediately
  console.log('[worker] Started — polling every', POLL_INTERVAL_MS, 'ms');
}

export function stopWorker() {
  if (pollTimer) clearInterval(pollTimer);
}
