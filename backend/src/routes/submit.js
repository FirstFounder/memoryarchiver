import path from 'path';
import db from '../db/client.js';
import config from '../config.js';
import { isAllowedPath } from '../lib/allowedRoots.js';
import { parseDateComponents, buildFilename, computeNextVersion } from '../lib/version.js';
import { probe } from '../worker/ffprobe.js';

/**
 * POST /api/jobs
 *
 * Body (JSON):
 * {
 *   files: [
 *     {
 *       path: string,         // absolute path — temp upload dir or NAS scratch path
 *       duration?: number,    // seconds (may be omitted for NAS files)
 *       width?: number,
 *       height?: number,
 *       fps?: number,
 *       createdTs?: string    // ISO-8601 local datetime from ffprobe
 *     }
 *   ],
 *   shortDesc:  string,
 *   longDesc:   string,
 *   outputDest: 'fam' | 'vault'
 * }
 *
 * Creates a job row and job_files rows inside a BEGIN EXCLUSIVE transaction
 * to guarantee version number uniqueness.
 */
export default async function submitRoutes(fastify) {
  fastify.post('/api/jobs', {
    schema: {
      body: {
        type: 'object',
        required: ['files', 'shortDesc', 'longDesc', 'outputDest'],
        properties: {
          files:      { type: 'array', minItems: 1 },
          shortDesc:  { type: 'string', minLength: 1, maxLength: 100 },
          longDesc:   { type: 'string', maxLength: 500 },
          outputDest: { type: 'string', enum: ['fam', 'vault'] },
        },
      },
    },
  }, async (req, reply) => {
    const { files, shortDesc, longDesc, outputDest } = req.body;

    // ── Validate all file paths and resolve to absolute ──────────────────────
    // Uploaded files arrive as absolute paths (under UPLOAD_TEMP_DIR).
    // NAS scratch files arrive as subpaths relative to NAS_SCRATCH_ROOT.
    for (const f of files) {
      if (!f.path) return reply.code(400).send({ error: 'Each file entry must include a path.' });

      const absPath = path.isAbsolute(f.path)
        ? f.path
        : path.resolve(config.nasScatchRoot, f.path);

      const isTemp    = absPath.startsWith(path.resolve(config.uploadTempDir) + path.sep)
                     || absPath.startsWith(path.resolve(config.uploadTempDir));
      const isScratch = isAllowedPath(absPath);

      if (!isTemp && !isScratch) {
        return reply.code(403).send({ error: `Path not permitted: ${f.path}` });
      }

      // Normalise to absolute path in-place so the rest of the handler can use it uniformly
      f.path = absPath;
    }

    // ── Probe any files missing metadata (NAS files) ──────────────────────────
    const enriched = await Promise.all(files.map(async (f, idx) => {
      if (f.duration != null) return { ...f, position: idx };
      const meta = await probe(f.path);
      return { ...f, position: idx, ...meta };
    }));

    // ── Find earliest creation timestamp ──────────────────────────────────────
    const timestamps = enriched.map(f => f.createdTs ?? f.createdAt).filter(Boolean);
    const earliestTs = timestamps.sort()[0] ?? new Date().toISOString();

    // ── Assign version + build filename inside an exclusive transaction ────────
    let jobId, outputFilename, outputPath;

    db.transaction(() => {
      const { year, month, day, monthName } = parseDateComponents(earliestTs);
      const version = computeNextVersion(db, year, month, day);

      const treeDir    = outputDest === 'fam' ? 'Fam' : 'Vault';
      outputPath       = path.join(config.nasOutputRoot, treeDir, monthName, String(year));
      outputFilename   = buildFilename({ monthName, year, day, version, shortDesc });

      const result = db.prepare(`
        INSERT INTO jobs
          (status, output_dest, short_desc, long_desc,
           output_filename, output_path, earliest_ts, version)
        VALUES ('pending', ?, ?, ?, ?, ?, ?, ?)
      `).run(outputDest, shortDesc, longDesc, outputFilename, outputPath, earliestTs, version);

      jobId = result.lastInsertRowid;

      const insertFile = db.prepare(`
        INSERT INTO job_files (job_id, position, src_path, duration, width, height, fps, created_ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const f of enriched) {
        insertFile.run(
          jobId, f.position, f.path,
          f.duration ?? null, f.width ?? null, f.height ?? null, f.fps ?? null,
          f.createdTs ?? f.createdAt ?? null,
        );
      }
    })();

    return reply.code(201).send({ jobId, outputFilename });
  });
}
