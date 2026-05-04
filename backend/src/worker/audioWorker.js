import fs from 'fs';
import db from '../db/client.js';
import emitter from '../lib/emitter.js';
import config from '../config.js';

const POLL_INTERVAL_MS  = 10_000;
const STATUS_POLL_MS    = 5_000;
const TIMEOUT_MS        = 3 * 60 * 60 * 1000;  // 3 hours max per file

const NAS_ROOT    = '/volume1/RFA';
const SQUAT_MOUNT = '/Volumes/iloRFA';

// Model ID must match the HuggingFace repo used by mlx-whisper on squat.
// Overridable via WHISPER_MODEL in backend/.env.
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? 'mlx-community/whisper-large-v3-mlx';

let running   = false;
let pollTimer = null;

function toSquatAudioPath(ioloPath) {
  if (!ioloPath.startsWith(NAS_ROOT)) {
    throw new Error(`Path not on RFA share: ${ioloPath}`);
  }
  return SQUAT_MOUNT + ioloPath.slice(NAS_ROOT.length);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function emitAudio(id, transcriptStatus, extra = {}) {
  emitter.emit('audio-transcript', { id, transcript_status: transcriptStatus, ...extra });
}

async function fetchSquatStatus() {
  const { squatHost: host, squatPort: port } = config;
  const res = await fetch(`http://${host}:${port}/status`, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`Squat /status returned ${res.status}`);
  return res.json();
}

async function dispatchTranscription(row) {
  const { squatHost: host, squatPort: port } = config;
  const squatPath = toSquatAudioPath(row.file_path);

  const res = await fetch(`http://${host}:${port}/transcribe`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      jobId:     row.id,
      audioPath: squatPath,
      model:     WHISPER_MODEL,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 409) {
    return false;  // slot busy — caller will retry on next poll
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Squat /transcribe rejected (${res.status}): ${text}`);
  }
  return true;
}

async function waitForResult(rowId) {
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(STATUS_POLL_MS);

    let status;
    try {
      status = await fetchSquatStatus();
    } catch (err) {
      console.warn(`[audioWorker] Status poll error for ${rowId}: ${err.message}`);
      continue;
    }

    if (status.status === 'idle' && status.jobId === rowId) {
      // Transcription complete — result lives in the status body
      return status.result ?? null;
    }

    if (status.status === 'error' && status.jobId === rowId) {
      throw new Error(`Squat transcription error: ${status.errorMsg}`);
    }

    // still transcribing — keep polling
  }

  throw new Error(`Audio transcription timed out after ${TIMEOUT_MS / 3600000}h`);
}

function updateMetaJson(metaPath, transcription) {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.transcription = transcription;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[audioWorker] Could not update meta JSON at ${metaPath}: ${err.message}`);
  }
}

async function processRow(row) {
  console.log(`[audioWorker] Processing ${row.id} (${row.original_name})`);

  // Check if squat is currently occupied by an encode or another transcription job
  let squatStatus;
  try {
    squatStatus = await fetchSquatStatus();
  } catch (err) {
    console.warn(`[audioWorker] Could not reach squat: ${err.message} — will retry`);
    return;
  }

  if (squatStatus.status !== 'idle') {
    console.log(`[audioWorker] Squat busy (${squatStatus.status}) — deferring ${row.id}`);
    return;
  }

  // Mark processing
  db.prepare(`
    UPDATE audio_files
    SET transcript_status = 'processing', transcript_error = NULL
    WHERE id = ?
  `).run(row.id);
  emitAudio(row.id, 'processing');

  try {
    const dispatched = await dispatchTranscription(row);
    if (!dispatched) {
      // 409 — squat became busy between our status check and POST; reset to queued
      db.prepare(`UPDATE audio_files SET transcript_status = 'queued' WHERE id = ?`).run(row.id);
      emitAudio(row.id, 'queued');
      return;
    }

    const result = await waitForResult(row.id);

    if (!result || !result.text) {
      throw new Error('Squat returned no transcript text');
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE audio_files
      SET transcript_status  = 'done',
          transcript_text    = ?,
          transcript_model   = ?,
          transcribed_at     = ?,
          transcript_error   = NULL
      WHERE id = ?
    `).run(result.text, WHISPER_MODEL, now, row.id);

    updateMetaJson(row.meta_path, {
      model:          WHISPER_MODEL,
      transcribed_at: now,
      text:           result.text,
      segments:       result.segments ?? [],
    });

    console.log(`[audioWorker] Done ${row.id} — ${result.text.length} chars`);
    emitAudio(row.id, 'done');

  } catch (err) {
    console.error(`[audioWorker] Failed ${row.id}: ${err.message}`);
    db.prepare(`
      UPDATE audio_files
      SET transcript_status = 'error',
          transcript_error  = ?
      WHERE id = ?
    `).run(err.message.slice(0, 2000), row.id);
    emitAudio(row.id, 'error', { error: err.message.slice(0, 500) });
  }
}

async function tick() {
  if (running) return;

  const row = db.prepare(`
    SELECT * FROM audio_files
    WHERE transcript_status = 'queued'
    ORDER BY imported_at ASC
    LIMIT 1
  `).get();

  if (!row) return;

  running = true;
  try {
    await processRow(row);
  } catch (err) {
    console.error('[audioWorker] Unexpected error:', err);
  } finally {
    running = false;
  }
}

function resetStalledRows() {
  const n = db.prepare(`
    UPDATE audio_files
    SET transcript_status = 'queued'
    WHERE transcript_status = 'processing'
  `).run().changes;
  if (n > 0) console.log(`[audioWorker] Reset ${n} stalled row(s) to queued.`);
}

export function startAudioWorker() {
  resetStalledRows();
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  tick();  // kick immediately
  console.log('[audioWorker] Started — polling every', POLL_INTERVAL_MS, 'ms');
}

export function stopAudioWorker() {
  if (pollTimer) clearInterval(pollTimer);
}
