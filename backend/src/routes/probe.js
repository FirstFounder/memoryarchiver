import path from 'path';
import config from '../config.js';
import { isAllowedPath } from '../lib/allowedRoots.js';
import { probe } from '../worker/ffprobe.js';

/**
 * POST /api/probe
 *
 * Accepts an array of NAS subpaths (relative to NAS_SCRATCH_ROOT), resolves
 * them to absolute paths, validates they are within the allowed roots, then
 * runs ffprobe on each and returns the same metadata shape as POST /api/upload.
 *
 * Request body: { paths: string[] }
 *
 * Response: Array<{
 *   path:      string,   // the subpath echoed back (used as the file key)
 *   origName:  string,
 *   duration:  number,
 *   width:     number,
 *   height:    number,
 *   fps:       number,
 *   createdTs: string,
 * }>
 */
export default async function probeRoutes(fastify) {
  fastify.post('/api/probe', {
    schema: {
      body: {
        type: 'object',
        required: ['paths'],
        properties: {
          paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 },
        },
      },
    },
  }, async (req, reply) => {
    const { paths: subpaths } = req.body;

    // Resolve and validate every path before probing any of them
    const resolved = [];
    for (const subpath of subpaths) {
      const absPath = path.isAbsolute(subpath)
        ? subpath
        : path.resolve(config.nasScatchRoot, subpath);

      if (!isAllowedPath(absPath)) {
        return reply.code(403).send({ error: `Path not permitted: ${subpath}` });
      }

      resolved.push({ subpath, absPath, origName: path.basename(absPath) });
    }

    // Probe all files
    const results = [];
    for (const { subpath, absPath, origName } of resolved) {
      try {
        const meta = await probe(absPath);
        results.push({
          path:      subpath,
          origName,
          duration:  meta.duration,
          width:     meta.width,
          height:    meta.height,
          fps:       meta.fps,
          createdTs: meta.createdTs,
        });
      } catch (err) {
        return reply.code(422).send({ error: `Could not probe ${origName}: ${err.message}` });
      }
    }

    return reply.send(results);
  });
}
