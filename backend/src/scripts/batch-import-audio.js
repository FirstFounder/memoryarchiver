/**
 * batch-import-audio.js
 *
 * One-time batch import of existing .m4a files from /volume1/RFA/Audio/ (flat).
 *
 * Usage:
 *   node src/scripts/batch-import-audio.js              # ingest all files (Phase 1)
 *   node src/scripts/batch-import-audio.js --queue-all  # queue all pending (Phase 2)
 *
 * Run as root on iolo from the backend/ directory.
 * Safe to re-run — idempotent based on original_name.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

// Import DB and config after dotenv is loaded
import db from '../db/client.js';
import config from '../config.js';

const execFileAsync = promisify(execFile);

const SOURCE_DIR = '/volume1/RFA/Audio';   // flat directory of original .m4a files

// ── ffprobe for audio ─────────────────────────────────────────────────────────
async function probeAudio(filePath) {
  const { stdout } = await execFileAsync(config.ffprobePath, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    filePath,
  ]);

  const data = JSON.parse(stdout);
  const fmt  = data.format ?? {};
  const tags = fmt.tags ?? {};

  const duration = parseFloat(fmt.duration ?? '0');
  const bitRate  = parseInt(fmt.bit_rate ?? '0', 10);
  const fileSize = parseInt(fmt.size ?? '0', 10);

  const location =
    tags['com.apple.quicktime.location.ISO6709'] ??
    tags['location'] ??
    null;

  return {
    duration_sec:      Number.isFinite(duration) && duration > 0 ? duration : null,
    bit_rate:          bitRate > 0 ? bitRate : null,
    file_size:         fileSize > 0 ? fileSize : null,
    created_at_source: tags['creation_time'] ?? null,
    title:             tags['title'] ?? null,
    location,
    encoder:           tags['encoder'] ?? tags['com.apple.quicktime.software'] ?? null,
    ffprobe_raw:       fmt,
  };
}

// ── Phase 1: ingest ───────────────────────────────────────────────────────────
async function ingestAll() {
  if (!fs.existsSync(SOURCE_DIR)) {
    console.error(`Source directory not found: ${SOURCE_DIR}`);
    process.exit(1);
  }

  fs.mkdirSync(config.audioRawDir,  { recursive: true });
  fs.mkdirSync(config.audioMetaDir, { recursive: true });

  const files = fs.readdirSync(SOURCE_DIR)
    .filter(f => f.toLowerCase().endsWith('.m4a') && !f.startsWith('.'));

  if (files.length === 0) {
    console.log('No .m4a files found in', SOURCE_DIR);
    return;
  }

  console.log(`Found ${files.length} .m4a file(s) in ${SOURCE_DIR}`);

  let ingested = 0;
  let skipped  = 0;
  let errors   = 0;

  for (const filename of files) {
    // Idempotent: skip if already imported
    const existing = db.prepare(
      'SELECT id FROM audio_files WHERE original_name = ?'
    ).get(filename);

    if (existing) {
      console.log(`  SKIP (already imported): ${filename}`);
      skipped++;
      continue;
    }

    const srcPath = path.join(SOURCE_DIR, filename);

    try {
      const id       = crypto.randomUUID();
      const rawPath  = path.join(config.audioRawDir,  `${id}.m4a`);
      const metaPath = path.join(config.audioMetaDir, `${id}.json`);

      // Copy (not move) — original preserved until batch is verified
      fs.copyFileSync(srcPath, rawPath);
      fs.chmodSync(rawPath, 0o664);

      const meta = await probeAudio(rawPath);

      const sidecar = {
        id,
        original_name:     filename,
        imported_at:       new Date().toISOString(),
        file_size:         meta.file_size,
        duration_sec:      meta.duration_sec,
        bit_rate:          meta.bit_rate,
        created_at_source: meta.created_at_source,
        title:             meta.title,
        location:          meta.location,
        encoder:           meta.encoder,
        ffprobe_raw:       meta.ffprobe_raw,
        transcription:     null,
      };
      fs.writeFileSync(metaPath, JSON.stringify(sidecar, null, 2), 'utf8');

      db.prepare(`
        INSERT INTO audio_files
          (id, original_name, file_path, meta_path,
           duration_sec, bit_rate, file_size, created_at_source,
           title, location, encoder, raw_meta_json,
           transcript_status)
        VALUES
          (?, ?, ?, ?,
           ?, ?, ?, ?,
           ?, ?, ?, ?,
           'pending')
      `).run(
        id, filename, rawPath, metaPath,
        meta.duration_sec, meta.bit_rate, meta.file_size, meta.created_at_source,
        meta.title, meta.location, meta.encoder, JSON.stringify(meta.ffprobe_raw),
      );

      console.log(`  INGESTED: ${filename} → ${id}`);
      ingested++;
    } catch (err) {
      console.error(`  ERROR: ${filename} — ${err.message}`);
      errors++;
    }
  }

  console.log(`\nDone. Ingested: ${ingested}  Skipped: ${skipped}  Errors: ${errors}`);
  console.log('\nReview the output above, then run with --queue-all to start transcription.');
}

// ── Phase 2: queue all pending ────────────────────────────────────────────────
function queueAll() {
  const result = db.prepare(`
    UPDATE audio_files
    SET transcript_status = 'queued'
    WHERE transcript_status = 'pending'
  `).run();

  console.log(`Queued ${result.changes} file(s) for transcription.`);
  console.log('The audio worker will pick them up one at a time.');
}

// ── Main ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes('--queue-all')) {
  queueAll();
} else {
  await ingestAll();
}
