import db from '../../db/client.js';
import config from '../../config.js';
import { janusExec } from '../../lib/coopSsh.js';

export default async function coopRoutes(fastify) {
  // All routes gated on coopEnabled; this plugin is only registered when enabled,
  // but guard here too for safety.
  if (!config.coopEnabled) return;

  // ── GET /api/coop/status ───────────────────────────────────────────────────
  fastify.get('/api/coop/status', async (_req, reply) => {
    try {
      const raw    = await janusExec('/opt/coopdoor/app_status.sh', 10_000);
      const status = JSON.parse(raw);
      return reply.send(status);
    } catch (err) {
      return reply.send({ error: 'unreachable', message: err.message.slice(0, 500) });
    }
  });

  // ── POST /api/coop/open ────────────────────────────────────────────────────
  fastify.post('/api/coop/open', async (_req, reply) => {
    try {
      const raw    = await janusExec('/opt/coopdoor/app_door.sh open', 15_000);
      const result = JSON.parse(raw);
      return reply.send(result);
    } catch (err) {
      return reply.send({ error: 'unreachable', message: err.message.slice(0, 500) });
    }
  });

  // ── POST /api/coop/close ───────────────────────────────────────────────────
  fastify.post('/api/coop/close', async (_req, reply) => {
    try {
      const raw    = await janusExec('/opt/coopdoor/app_door.sh close', 15_000);
      const result = JSON.parse(raw);
      return reply.send(result);
    } catch (err) {
      return reply.send({ error: 'unreachable', message: err.message.slice(0, 500) });
    }
  });

  // ── POST /api/coop/scheduler/start ────────────────────────────────────────
  fastify.post('/api/coop/scheduler/start', async (_req, reply) => {
    try {
      await janusExec('systemctl start coopdoor.service', 10_000);
      const raw    = await janusExec('/opt/coopdoor/app_status.sh', 10_000);
      const status = JSON.parse(raw);
      return reply.send(status);
    } catch (err) {
      return reply.send({ error: 'unreachable', message: err.message.slice(0, 500) });
    }
  });

  // ── POST /api/coop/scheduler/stop ─────────────────────────────────────────
  fastify.post('/api/coop/scheduler/stop', async (_req, reply) => {
    try {
      await janusExec('systemctl stop coopdoor.service', 10_000);
      const raw    = await janusExec('/opt/coopdoor/app_status.sh', 10_000);
      const status = JSON.parse(raw);
      return reply.send(status);
    } catch (err) {
      return reply.send({ error: 'unreachable', message: err.message.slice(0, 500) });
    }
  });

  // ── GET /api/coop/last-check ───────────────────────────────────────────────
  fastify.get('/api/coop/last-check', async (_req, reply) => {
    const row = db.prepare(`
      SELECT * FROM coop_checks
      ORDER BY checked_at DESC
      LIMIT 1
    `).get();

    if (!row) return reply.send(null);

    return reply.send({
      id:              row.id,
      checkedAt:       row.checked_at,
      checkType:       row.check_type,
      expectedState:   row.expected_state,
      actualState:     row.actual_state,
      schedulerActive: row.scheduler_active === null ? null : row.scheduler_active === 1,
      openAt:          row.open_at,
      closeAt:         row.close_at,
      mismatch:        row.mismatch === 1,
      alertSent:       row.alert_sent === 1,
      janusError:      row.janus_error,
    });
  });
}
