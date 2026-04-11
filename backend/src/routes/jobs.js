import db from '../db/client.js';

/**
 * GET  /api/jobs          — list all jobs (newest first, limit 100)
 * GET  /api/jobs/:id      — single job with its file list
 * DELETE /api/jobs/:id    — remove a pending or failed job
 */
export default async function jobsRoutes(fastify) {
  fastify.get('/api/jobs', async (_req, reply) => {
    const jobs = db.prepare(`
      SELECT id, status, output_dest, short_desc, long_desc,
             output_filename, output_path, progress, error_msg,
             created_at, updated_at, earliest_ts, version
      FROM jobs
      ORDER BY created_at DESC
      LIMIT 100
    `).all();
    return reply.send(jobs);
  });

  fastify.get('/api/jobs/:id', async (req, reply) => {
    const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'Job not found.' });

    const files = db.prepare(`
      SELECT id, position, src_path, duration, width, height, fps, created_ts
      FROM job_files WHERE job_id = ? ORDER BY position ASC
    `).all(job.id);

    return reply.send({ ...job, files });
  });

  fastify.delete('/api/jobs/:id', async (req, reply) => {
    const job = db.prepare(`SELECT status, ffmpeg_pid FROM jobs WHERE id = ?`).get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'Job not found.' });
    if (job.status === 'processing') {
      if (job.ffmpeg_pid) {
        try {
          process.kill(job.ffmpeg_pid, 0);
          // Process is alive — refuse deletion
          return reply.code(409).send({ error: 'Cannot delete a job that is currently encoding.' });
        } catch {
          // Process is dead — fall through to delete
        }
      }
      // PID absent or dead — mark cancelled before deleting
      db.prepare(`UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ?`)
        .run(Math.floor(Date.now() / 1000), req.params.id);
    }
    db.prepare(`DELETE FROM jobs WHERE id = ?`).run(req.params.id);
    return reply.send({ ok: true });
  });
}
