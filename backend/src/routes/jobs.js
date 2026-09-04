import db from '../db/client.js';
import emitter from '../lib/emitter.js';
import {
  nextAvailableNight,
  reconcileSchedule,
  formatNight,
} from '../lib/nightQueue.js';

/**
 * Re-pack the nightly queue after a change and push the moves out over SSE.
 */
function reconcileAndEmit() {
  for (const row of reconcileSchedule(db)) {
    emitter.emit('job:update', {
      id: row.id, status: 'scheduled', scheduled_for: row.scheduled_for,
    });
  }
}

/**
 * GET    /api/jobs                — list all jobs (newest first, limit 100)
 * GET    /api/jobs/:id            — single job with its file list
 * PATCH  /api/jobs/:id/schedule   — move a job between the nightly queue and now
 * DELETE /api/jobs/:id            — remove a pending, scheduled or failed job
 */
export default async function jobsRoutes(fastify) {
  fastify.get('/api/jobs', async (_req, reply) => {
    const jobs = db.prepare(`
      SELECT id, status, output_dest, short_desc, long_desc,
             output_filename, output_path, progress, error_msg,
             created_at, updated_at, earliest_ts, version, scheduled_for
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

  // Body: { mode: 'now' | 'night' }
  //   now   — pull a scheduled job out of the nightly queue and run it next
  //   night — park a queued job on the first night with a free slot
  fastify.patch('/api/jobs/:id/schedule', {
    schema: {
      body: {
        type: 'object',
        required: ['mode'],
        properties: { mode: { type: 'string', enum: ['now', 'night'] } },
      },
    },
  }, async (req, reply) => {
    const { mode } = req.body;
    const job = db.prepare(`SELECT id, status FROM jobs WHERE id = ?`).get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'Job not found.' });

    if (!['pending', 'scheduled'].includes(job.status)) {
      return reply.code(409).send({
        error: `Cannot reschedule a job that is ${job.status}.`,
      });
    }

    let status, scheduledFor;

    if (mode === 'now') {
      status = 'pending';
      scheduledFor = null;
      db.prepare(`
        UPDATE jobs SET status = 'pending', scheduled_for = NULL, updated_at = unixepoch()
        WHERE id = ?
      `).run(job.id);
    } else {
      status = 'scheduled';
      db.transaction(() => {
        scheduledFor = nextAvailableNight(db);
        db.prepare(`
          UPDATE jobs SET status = 'scheduled', scheduled_for = ?, updated_at = unixepoch()
          WHERE id = ?
        `).run(scheduledFor, job.id);
      })();
    }

    emitter.emit('job:update', { id: job.id, status, scheduled_for: scheduledFor });
    // Freeing (or taking) a slot can shift the rest of the queue.
    reconcileAndEmit();

    const current = db.prepare(`SELECT scheduled_for FROM jobs WHERE id = ?`).get(job.id);
    return reply.send({
      id:             job.id,
      status,
      scheduledFor:   current.scheduled_for,
      scheduledLabel: current.scheduled_for == null ? null : formatNight(current.scheduled_for),
    });
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
    // The deleted job may have been holding a slot on a night — close the gap.
    reconcileAndEmit();
    return reply.send({ ok: true });
  });
}
