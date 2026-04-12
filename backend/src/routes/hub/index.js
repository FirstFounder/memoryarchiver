/**
 * Hub API routes — registered only when DEVICE_ROLE=hub.
 *
 * GET    /api/hub/destinations
 * PATCH  /api/hub/destinations/:id
 * POST   /api/hub/destinations/:id/sync
 * GET    /api/hub/destinations/:id/status
 * GET    /api/hub/sync-history
 */

import db from '../../db/client.js';
import { triggerSync, reloadDestinationSchedule } from '../../worker/hub-worker.js';
import camerasRoutes from './cameras.js';

// ── Schedule helpers ──────────────────────────────────────────────────────────

const SCHEDULE_PRESETS = {
  '30 23 * * *': 'Nightly at 11:30 PM',
  '30 23 * * 0': 'Weekly — Sunday at 11:30 PM',
  '30 23 1 * *': 'Monthly — 1st at 11:30 PM',
};

function computeNextRunAt(cronExpr) {
  const now = new Date();

  if (cronExpr === '30 23 * * *') {
    // Nightly: next 23:30 today or tomorrow
    const next = new Date(now);
    next.setHours(23, 30, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }

  if (cronExpr === '30 23 * * 0') {
    // Weekly: next Sunday at 23:30
    const next = new Date(now);
    next.setHours(23, 30, 0, 0);
    const day = next.getDay(); // 0 = Sunday
    if (day === 0 && next > now) {
      // already Sunday and hasn't fired yet
    } else {
      next.setDate(next.getDate() + ((7 - day) % 7 || 7));
    }
    return next.toISOString();
  }

  if (cronExpr === '30 23 1 * *') {
    // Monthly: next 1st-of-month at 23:30
    const next = new Date(now);
    next.setDate(1);
    next.setHours(23, 30, 0, 0);
    if (next <= now) {
      next.setMonth(next.getMonth() + 1, 1);
      next.setHours(23, 30, 0, 0);
    }
    return next.toISOString();
  }

  return null; // custom schedule — not computable from presets
}

function formatDestination(row) {
  const scheduleEditable = Object.prototype.hasOwnProperty.call(SCHEDULE_PRESETS, row.schedule);
  return {
    id:              row.id,
    hostname:        row.hostname,
    ip:              row.ip,
    enabled:         row.enabled === 1,
    schedule:        row.schedule,
    scheduleHuman:   SCHEDULE_PRESETS[row.schedule] ?? `Custom (${row.schedule})`,
    scheduleEditable,
    nextRunAt:       row.enabled ? computeNextRunAt(row.schedule) : null,
    bwlimit:         row.bwlimit,
    parallel:        row.parallel === 1,
    sshKeyPath:      row.ssh_key_path,
    lastSyncAt:      row.last_sync_at,
    lastError:       row.last_error,
    lastAttempt:     row.last_attempt,
  };
}

// ── Route registration ────────────────────────────────────────────────────────

export default async function hubRoutes(fastify) {

  await fastify.register(camerasRoutes);

  // GET /api/hub/destinations
  fastify.get('/api/hub/destinations', async (_req, reply) => {
    const rows = db.prepare('SELECT * FROM hub_destinations ORDER BY id').all();
    return reply.send(rows.map(formatDestination));
  });

  // PATCH /api/hub/destinations/:id
  fastify.patch('/api/hub/destinations/:id', {
    schema: {
      body: {
        type: 'object',
        properties: {
          enabled:  { type: 'boolean' },
          schedule: { type: 'string', minLength: 1 },
          bwlimit:  { type: ['integer', 'null'], minimum: 1 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    const dest = db.prepare('SELECT * FROM hub_destinations WHERE id = ?').get(id);
    if (!dest) return reply.code(404).send({ error: 'Destination not found' });

    const { enabled, schedule, bwlimit } = req.body;

    // Build update from provided fields only
    const updates = [];
    const values  = [];

    if (enabled !== undefined) { updates.push('enabled = ?');  values.push(enabled ? 1 : 0); }
    if (schedule !== undefined) { updates.push('schedule = ?'); values.push(schedule); }
    if (bwlimit  !== undefined) { updates.push('bwlimit = ?');  values.push(bwlimit); }

    if (updates.length === 0) {
      return reply.code(400).send({ error: 'No updatable fields provided' });
    }

    values.push(id);
    db.prepare(`UPDATE hub_destinations SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    // Hot-reload the cron schedule if enabled or schedule changed
    if (enabled !== undefined || schedule !== undefined) {
      reloadDestinationSchedule(id);
    }

    const updated = db.prepare('SELECT * FROM hub_destinations WHERE id = ?').get(id);
    return reply.send(formatDestination(updated));
  });

  // POST /api/hub/destinations/:id/sync
  fastify.post('/api/hub/destinations/:id/sync', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    const dest = db.prepare('SELECT id, hostname, enabled FROM hub_destinations WHERE id = ?').get(id);
    if (!dest) return reply.code(404).send({ error: 'Destination not found' });
    if (!dest.enabled) return reply.code(409).send({ error: `${dest.hostname} is disabled` });

    const jobId = await triggerSync(id);
    if (jobId === null) {
      return reply.code(409).send({ error: `${dest.hostname} already has a sync in progress` });
    }

    return reply.code(202).send({
      jobId,
      destinationId: id,
      hostname: dest.hostname,
      status: 'pending',
    });
  });

  // GET /api/hub/destinations/:id/status
  fastify.get('/api/hub/destinations/:id/status', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    const dest = db.prepare('SELECT * FROM hub_destinations WHERE id = ?').get(id);
    if (!dest) return reply.code(404).send({ error: 'Destination not found' });
    return reply.send(formatDestination(dest));
  });

  // GET /api/hub/sync-history
  fastify.get('/api/hub/sync-history', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          destination_id: { type: 'integer' },
          status:         { type: 'string' },
          limit:          { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          offset:         { type: 'integer', minimum: 0, default: 0 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const { destination_id, status, limit = 50, offset = 0 } = req.query;

    const conditions = [];
    const params = [];

    if (destination_id !== undefined) { conditions.push('j.destination_id = ?'); params.push(destination_id); }
    if (status)                        { conditions.push('j.status = ?');         params.push(status); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const total = db.prepare(
      `SELECT COUNT(*) AS n FROM hub_sync_jobs j ${where}`,
    ).get(...params).n;

    const rows = db.prepare(`
      SELECT j.*, d.hostname
      FROM hub_sync_jobs j
      JOIN hub_destinations d ON d.id = j.destination_id
      ${where}
      ORDER BY j.started_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return reply.send({
      total,
      limit,
      offset,
      rows: rows.map(r => ({
        id:              r.id,
        destinationId:   r.destination_id,
        hostname:        r.hostname,
        startedAt:       r.started_at,
        finishedAt:      r.finished_at,
        status:          r.status,
        skippedReason:   r.skipped_reason,
        progress:        r.progress,
        famBytes:        r.fam_bytes,
        vaultBytes:      r.vault_bytes,
        famStatus:       r.fam_status,
        vaultStatus:     r.vault_status,
        errorMsg:        r.error_msg,
        durationSeconds: r.duration_seconds,
        avgBitrateKbps:  r.avg_bitrate_kbps,
      })),
    });
  });
}
