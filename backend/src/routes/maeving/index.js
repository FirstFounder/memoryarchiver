import config from '../../config.js';
import db from '../../db/client.js';
import { getAllDeviceStates, getDeviceState } from '../../lib/maevingMqtt.js';
import { setPlugState } from '../../lib/maevingControl.js';
import {
  computeOvernightStart,
  getFallbackScheduledStartAt,
  scheduleOvernightRetry,
} from '../../lib/maevingScheduler.js';

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

  // ── Devices ───────────────────────────────────────────────────────────────────

  fastify.get('/api/maeving/devices', async (_req, reply) => {
    const devices = db.prepare('SELECT * FROM maeving_devices').all();
    const allStates = getAllDeviceStates();
    return reply.send(devices.map(d => ({ ...d, live: allStates[d.id] ?? null })));
  });

  fastify.get('/api/maeving/devices/:id/state', async (req, reply) => {
    const device = db.prepare('SELECT * FROM maeving_devices WHERE id = ?').get(req.params.id);
    if (!device) return reply.code(404).send({ error: 'not found' });
    return reply.send(getDeviceState(device.id));
  });

  // ── Trips ─────────────────────────────────────────────────────────────────────

  fastify.get('/api/maeving/trips', async (_req, reply) => {
    return reply.send(
      db.prepare('SELECT * FROM maeving_trips ORDER BY description ASC').all(),
    );
  });

  fastify.post('/api/maeving/trips', async (req, reply) => {
    const { description, distance_miles } = req.body ?? {};
    if (!description) return reply.code(400).send({ error: 'description required' });
    if (distance_miles == null) return reply.code(400).send({ error: 'distance_miles required' });

    const result = db.prepare(`
      INSERT INTO maeving_trips (description, distance_miles)
      VALUES (?, ?)
    `).run(description, distance_miles);

    return reply.code(201).send(
      db.prepare('SELECT * FROM maeving_trips WHERE id = ?').get(result.lastInsertRowid),
    );
  });

  fastify.patch('/api/maeving/trips/:id', async (req, reply) => {
    const trip = db.prepare('SELECT * FROM maeving_trips WHERE id = ?').get(req.params.id);
    if (!trip) return reply.code(404).send({ error: 'not found' });

    const { description, distance_miles } = req.body ?? {};
    db.prepare(`
      UPDATE maeving_trips
      SET description    = COALESCE(?, description),
          distance_miles = COALESCE(?, distance_miles),
          updated_at     = datetime('now')
      WHERE id = ?
    `).run(description ?? null, distance_miles ?? null, trip.id);

    return reply.send(db.prepare('SELECT * FROM maeving_trips WHERE id = ?').get(trip.id));
  });

  fastify.delete('/api/maeving/trips/:id', async (req, reply) => {
    const trip = db.prepare('SELECT * FROM maeving_trips WHERE id = ?').get(req.params.id);
    if (!trip) return reply.code(404).send({ error: 'not found' });

    const inUse = db.prepare('SELECT id FROM maeving_sessions WHERE trip_id = ?').get(trip.id);
    if (inUse) {
      return reply.code(409).send({ error: 'trip in use by session', session_id: inUse.id });
    }

    db.prepare('DELETE FROM maeving_trips WHERE id = ?').run(trip.id);
    return reply.code(204).send();
  });

  // ── Sessions ──────────────────────────────────────────────────────────────────

  fastify.get('/api/maeving/sessions', async (req, reply) => {
    const { device_id, status } = req.query;
    let sql = 'SELECT * FROM maeving_sessions WHERE 1=1';
    const params = [];
    if (device_id) { sql += ' AND device_id = ?'; params.push(device_id); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY started_at DESC LIMIT 50';
    return reply.send(db.prepare(sql).all(...params));
  });

  fastify.get('/api/maeving/sessions/:id', async (req, reply) => {
    const session = db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    return reply.send({
      ...session,
      readings_summary: readingsStats(session.device_id, session.started_at),
    });
  });

  fastify.post('/api/maeving/sessions', async (req, reply) => {
    const {
      device_id,
      soc_start_pct,
      soc_target_pct,
      started_at,
      trip_id,
      trip_duration_min,
      charge_mode,
      departure_time,
    } = req.body ?? {};
    if (!device_id) return reply.code(400).send({ error: 'device_id required' });

    const active = db.prepare(
      "SELECT id FROM maeving_sessions WHERE device_id = ? AND status IN ('active', 'scheduled')",
    ).get(device_id);
    if (active) return reply.code(409).send({ error: 'active session exists', session_id: active.id });

    const mode = charge_mode === 'scheduled' ? 'scheduled' : 'now';
    const status = mode === 'scheduled' ? 'scheduled' : 'active';
    const now = started_at ?? new Date().toISOString();

    const result = db.prepare(`
      INSERT INTO maeving_sessions
        (device_id, started_at, soc_start_pct, soc_target_pct, status,
         trip_id, trip_duration_min, charge_mode, departure_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      device_id,
      now,
      soc_start_pct ?? null,
      soc_target_pct ?? null,
      status,
      trip_id ?? null,
      trip_duration_min ?? null,
      mode,
      departure_time ?? null,
    );

    return reply.code(201).send(
      db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(result.lastInsertRowid),
    );
  });

  fastify.patch('/api/maeving/sessions/:id', async (req, reply) => {
    const session = db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'not found' });

    const {
      notes,
      soc_start_pct,
      soc_target_pct,
      ended_at,
      status,
      trip_id,
      trip_duration_min,
    } = req.body ?? {};

    db.prepare(`
      UPDATE maeving_sessions
      SET notes             = COALESCE(?, notes),
          soc_start_pct     = COALESCE(?, soc_start_pct),
          soc_target_pct    = COALESCE(?, soc_target_pct),
          ended_at          = COALESCE(?, ended_at),
          status            = COALESCE(?, status),
          trip_id           = COALESCE(?, trip_id),
          trip_duration_min = COALESCE(?, trip_duration_min)
      WHERE id = ?
    `).run(
      notes ?? null,
      soc_start_pct ?? null,
      soc_target_pct ?? null,
      ended_at ?? null,
      status ?? null,
      trip_id ?? null,
      trip_duration_min ?? null,
      session.id,
    );

    return reply.send(db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(session.id));
  });

  // POST /api/maeving/sessions/:id/schedule-overnight
  fastify.post('/api/maeving/sessions/:id/schedule-overnight', async (req, reply) => {
    const session = db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'not found' });

    const { departure_time } = req.body ?? {};
    const deptTime = departure_time ?? session.departure_time ?? '07:30';

    try {
      const result = await computeOvernightStart(
        session.soc_start_pct ?? 0,
        session.soc_target_pct ?? 100,
        deptTime,
      );

      db.prepare(`
        UPDATE maeving_sessions
        SET scheduled_start_at     = ?,
            estimated_cost_dollars = ?,
            price_window_avg_cents = ?,
            departure_time         = ?,
            status                 = 'scheduled'
        WHERE id = ?
      `).run(
        result.scheduledStartAt,
        result.estimatedCostDollars,
        result.priceWindowAvgCents,
        deptTime,
        session.id,
      );

      return reply.send(
        db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(session.id),
      );
    } catch (err) {
      if (err.code === 'PRICES_PENDING') {
        const fallback = getFallbackScheduledStartAt();

        db.prepare(`
          UPDATE maeving_sessions
          SET scheduled_start_at = ?,
              departure_time     = ?,
              status             = 'scheduled'
          WHERE id = ?
        `).run(fallback, deptTime, session.id);

        scheduleOvernightRetry(
          session.id,
          session.soc_start_pct ?? 0,
          session.soc_target_pct ?? 100,
          deptTime,
        );

        return reply.send({ status: 'pending_prices', retry_after: '19:05' });
      }
      throw err;
    }
  });

  // POST /api/maeving/sessions/:id/stop
  fastify.post('/api/maeving/sessions/:id/stop', async (req, reply) => {
    const session = db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'not found' });

    const device = db.prepare('SELECT * FROM maeving_devices WHERE id = ?').get(session.device_id);

    try {
      await setPlugState(device.ip, false);
    } catch (err) {
      fastify.log.warn(
        { err },
        'Maeving: failed to cut power for device %d — still closing session',
        device.id,
      );
    }

    const now = new Date().toISOString();
    const stats = readingsStats(session.device_id, session.started_at);

    const actual_cost_dollars =
      session.price_window_avg_cents != null && stats.wh_delivered != null
        ? (session.price_window_avg_cents * (stats.wh_delivered / 1000)) / 100
        : null;

    db.prepare(`
      UPDATE maeving_sessions
      SET ended_at            = ?,
          status              = 'complete',
          wh_delivered        = COALESCE(?, wh_delivered),
          peak_watts          = COALESCE(?, peak_watts),
          avg_watts           = COALESCE(?, avg_watts),
          actual_cost_dollars = COALESCE(?, actual_cost_dollars)
      WHERE id = ?
    `).run(
      now,
      stats.wh_delivered,
      stats.peak_watts,
      stats.avg_watts,
      actual_cost_dollars,
      session.id,
    );

    return reply.send(db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(session.id));
  });
}
