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
  fastify.post('/api/upload', async (req, reply) => {
    fs.mkdirSync(config.uploadTempDir, { recursive: true });

    const results = [];

    const parts = req.parts();
    for await (const part of parts) {
      if (part.type !== 'file') continue;

      const ext  = path.extname(part.filename).toLowerCase();
      if (ext !== '.mov') {
        await part.file.resume(); // drain the stream
        return reply.code(400).send({ error: `Only .MOV files are accepted; got: ${part.filename}` });
      }

      const tmpName = `${Date.now()}-${Math.random().toString(36).slice(2)}.mov`;
      const tmpPath = path.join(config.uploadTempDir, tmpName);

      await pipeline(part.file, fs.createWriteStream(tmpPath));

      try {
        const meta = await probe(tmpPath);
        results.push({
          tempPath:  tmpPath,
          origName:  part.filename,
          duration:  meta.duration,
          width:     meta.width,
          height:    meta.height,
          fps:       meta.fps,
          createdTs: meta.createdTs,
        });
      } catch (err) {
        fs.unlinkSync(tmpPath);
        return reply.code(422).send({ error: `Could not probe ${part.filename}: ${err.message}` });
      }
    }

    if (results.length === 0) {
      return reply.code(400).send({ error: 'No .MOV files received.' });
    }

    return reply.send(results);
  });
}
