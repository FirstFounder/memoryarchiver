import config from '../../config.js';
import db from '../../db/client.js';
import { getAllDeviceStates, getDeviceState, invalidateActiveSessionCache } from '../../lib/maevingMqtt.js';
import { fetchCurrentHourPrice } from '../../lib/coMedPrices.js';
import { setPlugState } from '../../lib/maevingControl.js';
import {
  computeOvernightStart,
  getFallbackScheduledStartAt,
  scheduleOvernightRetry,
} from '../../lib/maevingScheduler.js';
import {
  getConfig,
  hasPendingCalibration,
  recordCalibrationEntry,
  analyzeTaper,
  recordSessionComplete,
  skipCalibration,
} from '../../lib/maevingCalibration.js';

function getComedBaseRateCents() {
  const month = new Date().getMonth() + 1; // 1-12
  return (month >= 6 && month <= 9) ? 4.27 : 2.90;
}

function readingsStats(deviceId, startedAt) {
  const rows = db.prepare(`
    SELECT apower, aenergy_total
    FROM maeving_readings
    WHERE device_id = ? AND recorded_at >= datetime(?)
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
      leg_1_trip_id,
      leg_1_duration_min,
      leg_2_trip_id,
      leg_2_duration_min,
      leg_3_trip_id,
      leg_3_duration_min,
      leg_4_trip_id,
      leg_4_duration_min,
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
         trip_id, trip_duration_min, charge_mode, departure_time,
         leg_1_trip_id, leg_1_duration_min,
         leg_2_trip_id, leg_2_duration_min,
         leg_3_trip_id, leg_3_duration_min,
         leg_4_trip_id, leg_4_duration_min)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      leg_1_trip_id ?? null,
      leg_1_duration_min ?? null,
      leg_2_trip_id ?? null,
      leg_2_duration_min ?? null,
      leg_3_trip_id ?? null,
      leg_3_duration_min ?? null,
      leg_4_trip_id ?? null,
      leg_4_duration_min ?? null,
    );

    invalidateActiveSessionCache(device_id);

    const baselineState = getDeviceState(device_id);
    if (baselineState) {
      db.prepare(`
        INSERT INTO maeving_readings (device_id, apower, current, voltage, aenergy_total)
        VALUES (?, ?, ?, ?, ?)
      `).run(device_id, baselineState.apower ?? 0, baselineState.current ?? 0,
             baselineState.voltage ?? 0, baselineState.aenergy_total ?? 0);
    }

    if (mode === 'now') {
      const device = db.prepare('SELECT * FROM maeving_devices WHERE id = ?').get(device_id);
      if (device) {
        try {
          await setPlugState(device.ip, true);
        } catch (err) {
          fastify.log.warn({ err }, 'Maeving: failed to turn on plug for device %d on session start', device_id);
        }
      }
    }

    if (soc_target_pct === 100) {
      fastify.log.info(
        { sessionId: result.lastInsertRowid },
        'Maeving: 100%% target session started — monitoring for charger auto-shutoff',
      );
    }

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

    const finalState = getDeviceState(session.device_id);
    if (finalState) {
      db.prepare(`
        INSERT INTO maeving_readings (device_id, apower, current, voltage, aenergy_total)
        VALUES (?, ?, ?, ?, ?)
      `).run(session.device_id, finalState.apower ?? 0, finalState.current ?? 0,
             finalState.voltage ?? 0, finalState.aenergy_total ?? 0);
    }

    const now = new Date().toISOString();
    const stats = readingsStats(session.device_id, session.started_at);

    let actualCostDollars = null;
    let priceAvgCents = session.price_window_avg_cents ?? null;

    if (!priceAvgCents && stats.wh_delivered) {
      try {
        const priceRows = await fetchCurrentHourPrice();
        if (priceRows.length) {
          priceAvgCents = priceRows[priceRows.length - 1].price;
        }
      } catch (err) {
        fastify.log.warn({ err }, 'Maeving: failed to fetch ComEd price at session stop');
      }
    }

    if (priceAvgCents && stats.wh_delivered) {
      const totalRateCents = priceAvgCents + getComedBaseRateCents();
      actualCostDollars = (totalRateCents * (stats.wh_delivered / 1000)) / 100;
    }

    if (device.cost_free) {
      actualCostDollars = 0;
      priceAvgCents = null;
    }

    db.prepare(`
      UPDATE maeving_sessions
      SET ended_at               = ?,
          status                 = 'complete',
          wh_delivered           = COALESCE(?, wh_delivered),
          peak_watts             = COALESCE(?, peak_watts),
          avg_watts              = COALESCE(?, avg_watts),
          actual_cost_dollars    = COALESCE(?, actual_cost_dollars),
          price_window_avg_cents = COALESCE(price_window_avg_cents, ?)
      WHERE id = ?
    `).run(
      now,
      stats.wh_delivered,
      stats.peak_watts,
      stats.avg_watts,
      actualCostDollars,
      priceAvgCents,
      session.id,
    );

    invalidateActiveSessionCache(session.device_id);

    if (session.soc_target_pct === 100) {
      recordSessionComplete(session.id);
    } else {
      const cfg = getConfig();
      if (cfg.calibration_mode === 0) {
        recordSessionComplete(session.id);
      }
    }

    return reply.send(db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(session.id));
  });

  // POST /api/maeving/sessions/:id/calibrate
  fastify.post('/api/maeving/sessions/:id/calibrate', async (req, reply) => {
    const session = db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'not found' });

    const { actual_soc_pct } = req.body ?? {};
    if (actual_soc_pct == null || actual_soc_pct < 0 || actual_soc_pct > 100) {
      return reply.code(400).send({ error: 'actual_soc_pct must be 0–100' });
    }
    if (!['complete', 'charger_complete'].includes(session.status)) {
      return reply.code(400).send({ error: 'session must be complete or charger_complete' });
    }
    if (session.calibration_complete) {
      return reply.code(400).send({ error: 'session already calibrated' });
    }

    try {
      const calibration = recordCalibrationEntry(session.id, actual_soc_pct);
      const cfg = getConfig();
      return reply.send({
        session: db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(session.id),
        calibration: { ...calibration, observation_count: cfg.observation_count },
      });
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // POST /api/maeving/sessions/:id/calibrate-skip
  fastify.post('/api/maeving/sessions/:id/calibrate-skip', async (req, reply) => {
    const session = db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    if (session.calibration_complete) return reply.code(400).send({ error: 'session already calibrated' });

    try {
      const updated = skipCalibration(session.id);
      return reply.send(updated);
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // GET /api/maeving/config
  fastify.get('/api/maeving/config', async (_req, reply) => {
    const cfg = getConfig();
    const pending = hasPendingCalibration();
    const history = JSON.parse(cfg.capacity_history_json || '[]');
    return reply.send({
      ...cfg,
      hasPendingCalibration: pending !== null,
      pendingSession: pending,
      capacityHistory: history.slice(-10),
    });
  });

  // GET /api/maeving/sessions/:id/taper
  fastify.get('/api/maeving/sessions/:id/taper', async (req, reply) => {
    const session = db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    if (session.soc_target_pct !== 100) return reply.send({ error: 'not_a_full_charge' });
    return reply.send(analyzeTaper(session.id));
  });
}
