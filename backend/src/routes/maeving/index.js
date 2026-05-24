import config from '../../config.js';
import db from '../../db/client.js';
import { getAllDeviceStates, getDeviceState } from '../../lib/maevingMqtt.js';
import { setPlugState } from '../../lib/maevingControl.js';

function readingsStats(deviceId, startedAt) {
  const rows = db.prepare(`
    SELECT apower, aenergy_total
    FROM maeving_readings
    WHERE device_id = ? AND recorded_at >= ?
    ORDER BY recorded_at ASC
  `).all(deviceId, startedAt);

  if (rows.length < 2) return { wh_delivered: null, peak_watts: null, avg_watts: null, reading_count: rows.length };

  const first = rows[0];
  const last = rows[rows.length - 1];
  const delta = last.aenergy_total - first.aenergy_total;
  const wh_delivered = delta >= 0 ? delta : 0;

  const charging = rows.filter(r => (r.apower ?? 0) > 10);
  const peak_watts = charging.length ? Math.max(...charging.map(r => r.apower)) : null;
  const avg_watts = charging.length
    ? charging.reduce((sum, r) => sum + r.apower, 0) / charging.length
    : null;

  return { wh_delivered, peak_watts, avg_watts, reading_count: rows.length };
}

export default async function maevingRoutes(fastify) {
  if (!config.maevingEnabled) return;

  // GET /api/maeving/devices
  fastify.get('/api/maeving/devices', async (_req, reply) => {
    const devices = db.prepare('SELECT * FROM maeving_devices').all();
    const allStates = getAllDeviceStates();
    return reply.send(devices.map(d => ({ ...d, live: allStates[d.id] ?? null })));
  });

  // GET /api/maeving/devices/:id/state
  fastify.get('/api/maeving/devices/:id/state', async (req, reply) => {
    const device = db.prepare('SELECT * FROM maeving_devices WHERE id = ?').get(req.params.id);
    if (!device) return reply.code(404).send({ error: 'not found' });
    return reply.send(getDeviceState(device.id));
  });

  // GET /api/maeving/sessions
  fastify.get('/api/maeving/sessions', async (req, reply) => {
    const { device_id, status } = req.query;
    let sql = 'SELECT * FROM maeving_sessions WHERE 1=1';
    const params = [];
    if (device_id) { sql += ' AND device_id = ?'; params.push(device_id); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY started_at DESC LIMIT 50';
    return reply.send(db.prepare(sql).all(...params));
  });

  // GET /api/maeving/sessions/:id
  fastify.get('/api/maeving/sessions/:id', async (req, reply) => {
    const session = db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    return reply.send({
      ...session,
      readings_summary: readingsStats(session.device_id, session.started_at),
    });
  });

  // POST /api/maeving/sessions
  fastify.post('/api/maeving/sessions', async (req, reply) => {
    const { device_id, soc_start_pct, soc_target_pct, started_at } = req.body ?? {};
    if (!device_id) return reply.code(400).send({ error: 'device_id required' });

    const active = db.prepare(
      "SELECT id FROM maeving_sessions WHERE device_id = ? AND status = 'active'",
    ).get(device_id);
    if (active) return reply.code(409).send({ error: 'active session exists', session_id: active.id });

    const now = started_at ?? new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO maeving_sessions (device_id, started_at, soc_start_pct, soc_target_pct, status)
      VALUES (?, ?, ?, ?, 'active')
    `).run(device_id, now, soc_start_pct ?? null, soc_target_pct ?? null);

    return reply.code(201).send(
      db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(result.lastInsertRowid),
    );
  });

  // PATCH /api/maeving/sessions/:id
  fastify.patch('/api/maeving/sessions/:id', async (req, reply) => {
    const session = db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'not found' });

    const { notes, soc_start_pct, soc_target_pct, ended_at, status } = req.body ?? {};
    db.prepare(`
      UPDATE maeving_sessions
      SET notes          = COALESCE(?, notes),
          soc_start_pct  = COALESCE(?, soc_start_pct),
          soc_target_pct = COALESCE(?, soc_target_pct),
          ended_at       = COALESCE(?, ended_at),
          status         = COALESCE(?, status)
      WHERE id = ?
    `).run(notes ?? null, soc_start_pct ?? null, soc_target_pct ?? null, ended_at ?? null, status ?? null, session.id);

    return reply.send(db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(session.id));
  });

  // POST /api/maeving/sessions/:id/stop
  fastify.post('/api/maeving/sessions/:id/stop', async (req, reply) => {
    const session = db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'not found' });

    const device = db.prepare('SELECT * FROM maeving_devices WHERE id = ?').get(session.device_id);

    try {
      await setPlugState(device.ip, false);
    } catch (err) {
      fastify.log.warn({ err }, 'Maeving: failed to cut power for device %d — still closing session', device.id);
    }

    const now = new Date().toISOString();
    const stats = readingsStats(session.device_id, session.started_at);

    db.prepare(`
      UPDATE maeving_sessions
      SET ended_at    = ?,
          status      = 'complete',
          wh_delivered = COALESCE(?, wh_delivered),
          peak_watts   = COALESCE(?, peak_watts),
          avg_watts    = COALESCE(?, avg_watts)
      WHERE id = ?
    `).run(now, stats.wh_delivered, stats.peak_watts, stats.avg_watts, session.id);

    return reply.send(db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(session.id));
  });
}
