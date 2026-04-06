import path from 'path';
import db from '../db/client.js';
import config from '../config.js';

/**
 * GET  /api/sync-jobs              — list all sync jobs (newest first)
 * POST /api/sync-jobs/trigger      — queue a manual full-tree sync
 * DELETE /api/sync-jobs/:id        — remove a pending or failed sync job
 */
export default async function syncRoutes(fastify) {

  fastify.get('/api/sync-jobs', async (_req, reply) => {
    const jobs = db.prepare(`
      SELECT id, status, type, label, src, dest,
             progress, error_msg, created_at, updated_at, encoding_job_id
      FROM sync_jobs
      ORDER BY created_at DESC
      LIMIT 100
    `).all();
    return reply.send(jobs);
  });

  /**
   * Manually trigger a full-archive rsync.
   * Syncs /volume1/RFA/ → SYNC_DEST_ROOT/ in one pass.
   * Returns 409 if a tree sync is already pending or running.
   */
  fastify.post('/api/sync-jobs/trigger', async (_req, reply) => {
    const existing = db.prepare(`
      SELECT id FROM sync_jobs
      WHERE type = 'tree' AND status IN ('pending', 'syncing')
    `).get();

    if (existing) {
      return reply.code(409).send({ error: 'A full-archive sync is already queued or running.' });
    }

    // Trailing slash on src tells rsync to sync the CONTENTS (not the dir itself)
    const src  = config.nasOutputRoot.replace(/\/?$/, '/');
    const dest = config.syncDestRoot.replace(/\/?$/, '/');

    const result = db.prepare(`
      INSERT INTO sync_jobs (type, src, dest, label)
      VALUES ('tree', ?, ?, 'Full Archive Sync')
    `).run(src, dest);

    return reply.code(201).send({ syncJobId: result.lastInsertRowid });
  });

  fastify.delete('/api/sync-jobs/:id', async (req, reply) => {
    const job = db.prepare(`SELECT status FROM sync_jobs WHERE id = ?`).get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'Sync job not found.' });
    if (job.status === 'syncing') {
      return reply.code(409).send({ error: 'Cannot delete a sync job that is currently running.' });
    }
    db.prepare(`DELETE FROM sync_jobs WHERE id = ?`).run(req.params.id);
    return reply.send({ ok: true });
  });
}
