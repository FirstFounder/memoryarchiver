import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import config from '../config.js';
import { probe } from '../worker/ffprobe.js';

/**
 * POST /api/upload
 *
 * Accepts one or more .MOV files as multipart/form-data.
 * Saves them to the temp directory and runs ffprobe on each.
 * Returns metadata the client needs to display and later submit as a job.
 *
 * The client should follow up with POST /api/jobs once the user has
 * filled in the description fields and chosen Fam/Vault.
 */
export default async function uploadRoutes(fastify) {
  // bodyTimeout: 0 disables the per-route body receive timeout so that large
  // files uploaded over slow connections (wifi, WAN) are not killed mid-stream.
  // Fastify's default is 10 s, which is far too short for multi-GB uploads.
  fastify.post('/api/upload', { bodyTimeout: 0 }, async (req, reply) => {
    fs.mkdirSync(config.uploadTempDir, { recursive: true });

    // Staged files — populated as each multipart part is received.
    const staged = []; // { tmpPath, origName }
    let earlyError = null; // set on the first validation failure

    // Consume every part before sending any reply.  Returning from inside a
    // `for await` loop over req.parts() without draining the remaining parts
    // leaves the multipart stream in a broken state and can prevent the client
    // from receiving the response.  We also deliberately do NOT call probe()
    // here — running ffprobe while the multipart stream is only half-read
    // stalls the server-side read, which can fill the TCP receive buffer and
    // cause the client's upload to hang.
    try {
      for await (const part of req.parts()) {
        if (part.type !== 'file') continue;

        if (earlyError) {
          // Already failed — drain remaining parts so the stream closes cleanly.
          await part.file.resume();
          continue;
        }

        const ext = path.extname(part.filename).toLowerCase();
        if (ext !== '.mov') {
          await part.file.resume();
          earlyError = {
            code: 400,
            message: `Only .MOV files are accepted; got: ${part.filename}`,
          };
          continue;
        }

        const tmpName = `${Date.now()}-${Math.random().toString(36).slice(2)}.mov`;
        const tmpPath = path.join(config.uploadTempDir, tmpName);

        await pipeline(part.file, fs.createWriteStream(tmpPath));
        staged.push({ tmpPath, origName: part.filename });
      }
    } catch (err) {
      // Stream or I/O error while receiving — clean up and report.
      for (const { tmpPath } of staged) fs.unlink(tmpPath, () => {});
      return reply.code(500).send({ error: `Upload failed while receiving data: ${err.message}` });
    }

    // All parts fully consumed — safe to respond now.

    if (earlyError) {
      for (const { tmpPath } of staged) fs.unlink(tmpPath, () => {});
      return reply.code(earlyError.code).send({ error: earlyError.message });
    }

    if (staged.length === 0) {
      return reply.code(400).send({ error: 'No .MOV files received.' });
    }

    // Probe all staged files now that the multipart stream is closed.
    const results = [];
    for (const { tmpPath, origName } of staged) {
      try {
        const meta = await probe(tmpPath);
        results.push({
          tempPath:  tmpPath,
          origName,
          duration:  meta.duration,
          width:     meta.width,
          height:    meta.height,
          fps:       meta.fps,
          createdTs: meta.createdTs,
        });
      } catch (err) {
        // Clean up every staged file on probe failure.
        for (const { tmpPath: p } of staged) fs.unlink(p, () => {});
        return reply.code(422).send({ error: `Could not probe ${origName}: ${err.message}` });
      }
    }

    return reply.send(results);
  });
}
