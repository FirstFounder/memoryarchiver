import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import db from '../../db/client.js';
import emitter from '../../lib/emitter.js';
import config from '../../config.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ALLOWED_EXT  = new Set(['.m4a']);
const ALLOWED_MIME = new Set(['audio/x-m4a', 'audio/mp4', 'audio/m4a', 'video/mp4']);

// ── ffprobe for audio files ───────────────────────────────────────────────────
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

  // iOS Voice Memos may carry location in a non-standard tag; try both
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

function rowToRecord(row) {
  return {
    id:                row.id,
    original_name:     row.original_name,
    file_path:         row.file_path,
    meta_path:         row.meta_path,
    duration_sec:      row.duration_sec,
    bit_rate:          row.bit_rate,
    file_size:         row.file_size,
    created_at_source: row.created_at_source,
    title:             row.title,
    location:          row.location,
    encoder:           row.encoder,
    transcript_status: row.transcript_status,
    transcript_model:  row.transcript_model,
    transcribed_at:    row.transcribed_at,
    transcript_error:  row.transcript_error,
    imported_at:       row.imported_at,
  };
}

export default async function audioRoutes(fastify) {

  // ── POST /api/audio/ingest ─────────────────────────────────────────────────
  fastify.post('/api/audio/ingest', {
    config: { bodyTimeout: 0 },
  }, async (req, reply) => {
    fs.mkdirSync(config.audioRawDir,  { recursive: true });
    fs.mkdirSync(config.audioMetaDir, { recursive: true });

    let fileBuffer = null;
    let origName   = null;
    let mimeType   = null;

    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const chunks = [];
        for await (const chunk of part.file) chunks.push(chunk);
        fileBuffer = Buffer.concat(chunks);
        origName   = part.filename;
        mimeType   = part.mimetype;
      } else {
        await part.value;
      }
    }

    if (!fileBuffer || !origName) {
      return reply.code(400).send({ error: 'No file uploaded' });
    }

    const ext = path.extname(origName).toLowerCase();
    if (!ALLOWED_EXT.has(ext) && !ALLOWED_MIME.has(mimeType)) {
      return reply.code(400).send({ error: 'Only .m4a files are accepted' });
    }

    const id       = crypto.randomUUID();
    const rawPath  = path.join(config.audioRawDir,  `${id}.m4a`);
    const metaPath = path.join(config.audioMetaDir, `${id}.json`);

    fs.writeFileSync(rawPath, fileBuffer);
    fs.chmodSync(rawPath, 0o664);

    let meta;
    try {
      meta = await probeAudio(rawPath);
    } catch (err) {
      fs.unlinkSync(rawPath);
      return reply.code(422).send({ error: `ffprobe failed: ${err.message}` });
    }

    const sidecar = {
      id,
      original_name:     origName,
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
      id, origName, rawPath, metaPath,
      meta.duration_sec, meta.bit_rate, meta.file_size, meta.created_at_source,
      meta.title, meta.location, meta.encoder, JSON.stringify(meta.ffprobe_raw),
    );

    const row = db.prepare('SELECT * FROM audio_files WHERE id = ?').get(id);
    return reply.code(201).send(rowToRecord(row));
  });

  // ── GET /api/audio/files ───────────────────────────────────────────────────
  fastify.get('/api/audio/files', async (req, reply) => {
    const { status } = req.query;
    const rows = status
      ? db.prepare(`SELECT * FROM audio_files WHERE transcript_status = ? ORDER BY imported_at DESC`).all(status)
      : db.prepare(`SELECT * FROM audio_files ORDER BY imported_at DESC`).all();
    return reply.send(rows.map(rowToRecord));
  });

  // ── GET /api/audio/files/:id ───────────────────────────────────────────────
  fastify.get('/api/audio/files/:id', async (req, reply) => {
    const row = db.prepare('SELECT * FROM audio_files WHERE id = ?').get(req.params.id);
    if (!row) return reply.code(404).send({ error: 'Not found' });
    return reply.send(rowToRecord(row));
  });

  // ── POST /api/audio/files/:id/queue ───────────────────────────────────────
  fastify.post('/api/audio/files/:id/queue', async (req, reply) => {
    const row = db.prepare('SELECT * FROM audio_files WHERE id = ?').get(req.params.id);
    if (!row) return reply.code(404).send({ error: 'Not found' });

    if (!['pending', 'error'].includes(row.transcript_status)) {
      return reply.code(409).send({ error: `Cannot queue from status '${row.transcript_status}'` });
    }

    db.prepare(`
      UPDATE audio_files
      SET transcript_status = 'queued', transcript_error = NULL
      WHERE id = ?
    `).run(req.params.id);

    emitter.emit('audio-transcript', { id: req.params.id, transcript_status: 'queued' });
    return reply.send({ id: req.params.id, transcript_status: 'queued' });
  });

  // ── GET /api/audio/search ──────────────────────────────────────────────────
  fastify.get('/api/audio/search', async (req, reply) => {
    const q = (req.query.q ?? '').trim();
    if (!q) return reply.send([]);

    const rows = db.prepare(`
      SELECT af.*
      FROM audio_fts
      JOIN audio_files af ON af.rowid = audio_fts.rowid
      WHERE audio_fts MATCH ?
      ORDER BY rank
    `).all(q);

    return reply.send(rows.map(rowToRecord));
  });

  // ── GET /api/audio/files/:id/export ───────────────────────────────────────
  fastify.get('/api/audio/files/:id/export', async (req, reply) => {
    const row = db.prepare(
      'SELECT transcript_text, original_name FROM audio_files WHERE id = ?'
    ).get(req.params.id);

    if (!row) return reply.code(404).send({ error: 'Not found' });
    if (!row.transcript_text) return reply.code(409).send({ error: 'No transcript available' });

    const baseName = row.original_name.replace(/\.m4a$/i, '');
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${baseName}.txt"`);
    return reply.send(row.transcript_text);
  });

  // ── GET /api/audio/files/:id/stream ───────────────────────────────────────
  // Streams the raw .m4a for the inline HTML audio player.
  fastify.get('/api/audio/files/:id/stream', async (req, reply) => {
    const row = db.prepare('SELECT file_path, file_size FROM audio_files WHERE id = ?').get(req.params.id);
    if (!row) return reply.code(404).send({ error: 'Not found' });

    if (!fs.existsSync(row.file_path)) {
      return reply.code(404).send({ error: 'Audio file not found on disk' });
    }

    const stat = fs.statSync(row.file_path);
    reply.header('Content-Type', 'audio/mp4');
    reply.header('Content-Length', stat.size);
    reply.header('Accept-Ranges', 'bytes');
    return reply.send(fs.createReadStream(row.file_path));
  });

  // ── POST /api/audio/batch-import ──────────────────────────────────────────
  // Spawns the batch-import script detached. Returns 202 immediately.
  fastify.post('/api/audio/batch-import', async (req, reply) => {
    const scriptPath = path.resolve(__dirname, '../../scripts/batch-import-audio.js');
    const { queueAll } = req.body ?? {};
    const args = queueAll ? ['--queue-all'] : [];

    const proc = spawn(process.execPath, [scriptPath, ...args], {
      detached: true,
      stdio:    'ignore',
    });
    proc.unref();

    return reply.code(202).send({ accepted: true, queueAll: !!queueAll });
  });
}
