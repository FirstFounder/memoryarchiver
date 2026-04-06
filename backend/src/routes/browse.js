import fs from 'fs';
import path from 'path';
import config from '../config.js';
import { SCRATCH_DIRS, ALLOWED_ROOTS, isAllowedPath } from '../lib/allowedRoots.js';

/**
 * GET /api/browse
 *
 * Query params:
 *   subpath  — path relative to NAS_SCRATCH_ROOT (omit for root listing)
 *
 * Returns:
 * {
 *   currentPath: string,          // subpath value echoed back
 *   breadcrumbs: string[],        // path segments for navigation
 *   entries: [
 *     { name, type: 'dir'|'file', subpath, selectable: boolean }
 *   ]
 * }
 *
 * Security: any requested path is resolved and checked against ALLOWED_ROOTS
 * before any filesystem access.  Only .MOV files have selectable: true.
 * Directories are navigable but not selectable (cannot be submitted as jobs).
 */
export default async function browseRoutes(fastify) {
  fastify.get('/api/browse', async (req, reply) => {
    const subpath = (req.query.subpath ?? '').replace(/^\/+/, '');

    // ── Root listing: return the five person-directories ─────────────────────
    if (!subpath) {
      return reply.send({
        currentPath:  '',
        breadcrumbs:  [],
        entries: SCRATCH_DIRS.map(d => ({
          name:       d,
          type:       'dir',
          subpath:    d,
          selectable: false,
        })),
      });
    }

    // ── Subdirectory listing ──────────────────────────────────────────────────
    const absPath = path.resolve(config.nasScatchRoot, subpath);

    if (!isAllowedPath(absPath)) {
      return reply.code(403).send({ error: 'Path is outside the allowed browse roots.' });
    }

    let dirents;
    try {
      dirents = fs.readdirSync(absPath, { withFileTypes: true });
    } catch {
      return reply.code(404).send({ error: 'Directory not found.' });
    }

    const entries = dirents
      .filter(d => d.isDirectory() || d.name.toLowerCase().endsWith('.mov'))
      .map(d => {
        const isDir  = d.isDirectory();
        const relPath = path.relative(config.nasScatchRoot, path.join(absPath, d.name));
        return {
          name:       d.name,
          type:       isDir ? 'dir' : 'file',
          subpath:    relPath,
          selectable: !isDir,
        };
      })
      .sort((a, b) => {
        // Directories first, then files; both alpha-sorted
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });

    // Build breadcrumb segment list
    const breadcrumbs = subpath.split(path.sep).filter(Boolean);

    return reply.send({ currentPath: subpath, breadcrumbs, entries });
  });
}
