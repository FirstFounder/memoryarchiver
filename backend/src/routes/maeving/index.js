import config from '../../config.js';
import db from '../../db/client.js';
import { getAllDeviceStates, getDeviceState, invalidateActiveSessionCache, notifyRideStarted, notifyRideFinished, getActiveRideId } from '../../lib/maevingMqtt.js';
import { fetchCurrentHourPrice } from '../../lib/coMedPrices.js';
import { setPlugState } from '../../lib/maevingControl.js';
import {
  computeOvernightStart,
  getFallbackScheduledStartAt,
} from '../../lib/maevingScheduler.js';
import {
  getConfig,
  getEffectiveCapacity,
  hasPendingCalibration,
  recordCalibrationEntry,
  analyzeTaper,
  recordSessionComplete,
  skipCalibration,
} from '../../lib/maevingCalibration.js';
import { computeRebelCost } from '../../lib/eiaGasPrice.js';

function getComedBaseRateCents() {
  const month = new Date().getMonth() + 1; // 1-12
  return (month >= 6 && month <= 9) ? 4.27 : 2.90;
}

const COMED_FIXED_SUPPLY_CENTS = 9.66; // $0.0966/kWh, same year-round

function getComedFixedTotalCents() {
  const month = new Date().getMonth() + 1;
  return COMED_FIXED_SUPPLY_CENTS + ((month >= 6 && month <= 9) ? 4.27 : 2.90);
  // Summer (Jun-Sep): 9.66 + 4.27 = 13.93 cents/kWh ($0.1393)
  // Winter (Oct-May): 9.66 + 2.90 = 12.56 cents/kWh ($0.1256)
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

  // ── Trips (Legs) ──────────────────────────────────────────────────────────────

  fastify.get('/api/maeving/trips', async (_req, reply) => {
    return reply.send(
      db.prepare(`
        SELECT * FROM maeving_trips
        ORDER BY hidden ASC, CASE WHEN hidden = 1 THEN id END DESC, description ASC
      `).all(),
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

    const { description, distance_miles, hidden } = req.body ?? {};
    db.prepare(`
      UPDATE maeving_trips
      SET description    = COALESCE(?, description),
          distance_miles = COALESCE(?, distance_miles),
          hidden         = COALESCE(?, hidden),
          updated_at     = datetime('now')
      WHERE id = ?
    `).run(description ?? null, distance_miles ?? null, hidden ?? null, trip.id);

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

  // ── Rides ─────────────────────────────────────────────────────────────────────

  fastify.get('/api/maeving/rides/active', async (_req, reply) => {
    const ride = db.prepare(`
      SELECT r.id, r.trip_id, r.started_at, r.finished_at, r.duration_min,
             r.start_soc_pct, r.end_soc_pct, r.wh_per_mile,
             t.description AS trip_name, t.distance_miles AS trip_miles
      FROM maeving_rides r
      JOIN maeving_trips t ON t.id = r.trip_id AND t.hidden = 0
      WHERE r.finished_at IS NULL
      LIMIT 1
    `).get();
    return reply.send(ride ?? null);
  });

  fastify.get('/api/maeving/rides/pending', async (_req, reply) => {
    const rides = db.prepare(`
      SELECT r.id, r.trip_id, r.started_at, r.finished_at, r.duration_min,
             r.start_soc_pct, r.end_soc_pct, r.wh_per_mile, r.notes,
             r.windbreaker, r.overheat_pack, r.overheat_motor, r.overheat_level, r.sporty_level,
             t.description AS trip_name, t.distance_miles AS trip_miles
      FROM maeving_rides r
      JOIN maeving_trips t ON t.id = r.trip_id AND t.hidden = 0
      WHERE r.finished_at IS NOT NULL
      ORDER BY r.started_at ASC
    `).all();
    return reply.send(rides);
  });

  fastify.post('/api/maeving/rides/start', async (req, reply) => {
    const { trip_id, start_soc_pct } = req.body ?? {};
    if (!trip_id) return reply.code(400).send({ error: 'trip_id required' });

    const trip = db.prepare('SELECT * FROM maeving_trips WHERE id = ?').get(trip_id);
    if (!trip) return reply.code(404).send({ error: 'trip not found' });
    if (trip.hidden) return reply.code(400).send({ error: 'trip is hidden' });

    const existing = db.prepare(
      'SELECT id FROM maeving_rides WHERE finished_at IS NULL LIMIT 1',
    ).get();
    if (existing) return reply.code(409).send({ error: 'A ride is already in progress' });

    const startedAt = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO maeving_rides (trip_id, started_at, finished_at, duration_min, start_soc_pct)
      VALUES (?, ?, NULL, NULL, ?)
    `).run(trip_id, startedAt, start_soc_pct ?? null);

    notifyRideStarted(result.lastInsertRowid, startedAt);

    return reply.code(201).send({
      id: result.lastInsertRowid,
      trip_id: trip.id,
      trip_name: trip.description,
      trip_miles: trip.distance_miles,
      started_at: startedAt,
      finished_at: null,
      duration_min: null,
      start_soc_pct: start_soc_pct ?? null,
      end_soc_pct: null,
      wh_per_mile: null,
    });
  });

  fastify.post('/api/maeving/rides/:id/finish', async (req, reply) => {
    const ride = db.prepare('SELECT * FROM maeving_rides WHERE id = ?').get(req.params.id);
    if (!ride) return reply.code(400).send({ error: 'ride not found' });
    if (ride.finished_at != null) return reply.code(400).send({ error: 'ride already finished' });

    const { end_soc_pct, windbreaker, overheat_pack, overheat_motor, overheat_level, sporty_level } = req.body ?? {};

    if (end_soc_pct == null || !Number.isInteger(end_soc_pct) || end_soc_pct < 0 || end_soc_pct > 100) {
      return reply.code(400).send({ error: 'end_soc_pct is required and must be an integer 0–100' });
    }

    const finishedAt = new Date().toISOString();
    const durationMin = Math.round(
      ((new Date(finishedAt) - new Date(ride.started_at)) / 60000) * 10,
    ) / 10;

    const trip = db.prepare('SELECT * FROM maeving_trips WHERE id = ?').get(ride.trip_id);

    let whPerMile = null;
    if (
      ride.start_soc_pct != null &&
      end_soc_pct != null &&
      trip?.distance_miles > 0
    ) {
      const effectiveCapacityWh = getEffectiveCapacity();
      if (effectiveCapacityWh > 0) {
        const whUsed = ((ride.start_soc_pct - end_soc_pct) / 100) * effectiveCapacityWh;
        whPerMile = whUsed / trip.distance_miles;
      }
    }

    db.prepare(`
      UPDATE maeving_rides
      SET finished_at = ?, duration_min = ?, end_soc_pct = ?, wh_per_mile = ?,
          windbreaker = ?, overheat_pack = ?, overheat_motor = ?, overheat_level = ?, sporty_level = ?
      WHERE id = ?
    `).run(finishedAt, durationMin, end_soc_pct, whPerMile,
           windbreaker ?? null, overheat_pack ?? null, overheat_motor ?? null, overheat_level ?? null, sporty_level ?? null,
           ride.id);

    notifyRideFinished();

    db.prepare('UPDATE maeving_config SET prev_max_soc_pct = ? WHERE id = 1').run(end_soc_pct);

    return reply.send({
      id: ride.id,
      trip_id: ride.trip_id,
      trip_name: trip?.description ?? null,
      trip_miles: trip?.distance_miles ?? null,
      started_at: ride.started_at,
      finished_at: finishedAt,
      duration_min: durationMin,
      start_soc_pct: ride.start_soc_pct ?? null,
      end_soc_pct,
      wh_per_mile: whPerMile,
      windbreaker: windbreaker ?? null,
      overheat_pack: overheat_pack ?? null,
      overheat_motor: overheat_motor ?? null,
      overheat_level: overheat_level ?? null,
      sporty_level: sporty_level ?? null,
    });
  });

  fastify.delete('/api/maeving/rides/:id', async (req, reply) => {
    const ride = db.prepare('SELECT id FROM maeving_rides WHERE id = ?').get(req.params.id);
    if (!ride) return reply.code(404).send({ error: 'ride not found' });
    db.prepare('DELETE FROM maeving_rides WHERE id = ?').run(req.params.id);
    return reply.send({ deleted: true });
  });

  fastify.patch('/api/maeving/rides/:id', async (req, reply) => {
    const ride = db.prepare('SELECT * FROM maeving_rides WHERE id = ?').get(req.params.id);
    if (!ride) return reply.code(404).send({ error: 'ride not found' });
    if (ride.finished_at == null) return reply.code(400).send({ error: 'cannot edit an in-progress ride' });
    const { end_soc_pct, started_at, finished_at, notes, trip_id } = req.body ?? {};
    const body = req.body ?? {};
    const windbreaker    = 'windbreaker'    in body ? (body.windbreaker    ?? null) : ride.windbreaker;
    const overheatPack   = 'overheat_pack'  in body ? (body.overheat_pack  ?? null) : ride.overheat_pack;
    const overheatMotor  = 'overheat_motor' in body ? (body.overheat_motor ?? null) : ride.overheat_motor;
    const overheatLevel  = 'overheat_level' in body ? (body.overheat_level ?? null) : ride.overheat_level;
    const sportyLevel    = 'sporty_level'   in body ? (body.sporty_level   ?? null) : ride.sporty_level;

    let tripForCalc = null;
    if (trip_id !== undefined) {
      const newTrip = db.prepare('SELECT * FROM maeving_trips WHERE id = ?').get(trip_id);
      if (!newTrip) return reply.code(400).send({ error: 'trip not found' });
      if (newTrip.hidden) return reply.code(400).send({ error: 'trip is hidden' });
      tripForCalc = newTrip;
    }

    const newStartedAt = started_at ?? ride.started_at;
    const newFinishedAt = finished_at ?? ride.finished_at;
    const durationMin = Math.round(
      ((new Date(newFinishedAt) - new Date(newStartedAt)) / 60000) * 10,
    ) / 10;
    const newEndSoc = end_soc_pct !== undefined ? end_soc_pct : ride.end_soc_pct;
    const newTripId = trip_id !== undefined ? trip_id : ride.trip_id;

    let whPerMile = ride.wh_per_mile;
    if (trip_id !== undefined || end_soc_pct !== undefined) {
      const trip = tripForCalc ?? db.prepare('SELECT * FROM maeving_trips WHERE id = ?').get(ride.trip_id);
      if (ride.start_soc_pct != null && newEndSoc != null && trip?.distance_miles > 0) {
        const effectiveCapacityWh = getEffectiveCapacity();
        if (effectiveCapacityWh > 0) {
          const whUsed = ((ride.start_soc_pct - newEndSoc) / 100) * effectiveCapacityWh;
          whPerMile = whUsed / trip.distance_miles;
        }
      } else {
        whPerMile = null;
      }
    }

    if (started_at || finished_at) {
      const overlap = db.prepare(`
        SELECT id FROM maeving_rides
        WHERE id != ?
          AND finished_at IS NOT NULL
          AND started_at < ?
          AND finished_at > ?
      `).get(ride.id, newFinishedAt, newStartedAt);
      if (overlap) {
        return reply.code(409).send({ error: 'Time range overlaps another pending ride' });
      }
    }
    db.prepare(`
      UPDATE maeving_rides
      SET started_at = ?, finished_at = ?, duration_min = ?, end_soc_pct = ?, wh_per_mile = ?,
          notes = ?, trip_id = ?,
          windbreaker    = ?,
          overheat_pack  = ?,
          overheat_motor = ?,
          overheat_level = ?,
          sporty_level   = ?
      WHERE id = ?
    `).run(newStartedAt, newFinishedAt, durationMin, newEndSoc, whPerMile,
           notes !== undefined ? notes : ride.notes, newTripId,
           windbreaker, overheatPack, overheatMotor, overheatLevel, sportyLevel,
           ride.id);
    const updated = db.prepare(`
      SELECT r.*, t.description AS trip_name, t.distance_miles AS trip_miles
      FROM maeving_rides r
      JOIN maeving_trips t ON t.id = r.trip_id
      WHERE r.id = ?
    `).get(ride.id);
    return reply.send(updated);
  });

  // ── Ride telemetry ────────────────────────────────────────────────────────────

  fastify.get('/api/maeving/rides/live-telemetry', async (_req, reply) => {
    const rideId = getActiveRideId();
    if (!rideId) return reply.send(null);
    const ping = db.prepare(`
      SELECT * FROM owntracks_locations
      WHERE ride_id = ?
      ORDER BY tst DESC
      LIMIT 1
    `).get(rideId);
    if (!ping) return reply.send(null);
    const ride = db.prepare(
      'SELECT id, started_at, start_soc_pct, trip_id FROM maeving_rides WHERE id = ?'
    ).get(rideId);
    const config = db.prepare('SELECT avg_wh_per_mile FROM maeving_config WHERE id = 1').get();
    const pingCount = db.prepare(
      'SELECT COUNT(*) AS n FROM owntracks_locations WHERE ride_id = ?'
    ).get(rideId)?.n ?? 0;
    return reply.send({
      ping,
      ride_id: rideId,
      ping_count: pingCount,
      start_soc_pct: ride?.start_soc_pct ?? null,
      avg_wh_per_mile: config?.avg_wh_per_mile ?? null,
    });
  });

  fastify.get('/api/maeving/rides/:id/telemetry', async (req, reply) => {
    const ride = db.prepare('SELECT id FROM maeving_rides WHERE id = ?').get(req.params.id);
    if (!ride) return reply.code(404).send({ error: 'ride not found' });
    const pings = db.prepare(`
      SELECT * FROM owntracks_locations
      WHERE ride_id = ?
      ORDER BY tst ASC
    `).all(ride.id);
    return reply.send(pings);
  });

  // ── Rebel cost ────────────────────────────────────────────────────────────────

  fastify.get('/api/maeving/rebel-cost', async (req, reply) => {
    const miles = parseFloat(req.query.miles);
    if (!req.query.miles || !isFinite(miles) || miles <= 0) {
      return reply.code(400).send({ error: 'miles must be a positive number' });
    }
    const { cost, stale } = await computeRebelCost(miles);
    return reply.send({ cost, stale, miles, mpg: 61.6 });
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
      leg_1_rebel_cost,
      leg_2_rebel_cost,
      leg_3_rebel_cost,
      leg_4_rebel_cost,
      leg_5_trip_id,
      leg_5_duration_min,
      leg_5_rebel_cost,
      leg_6_trip_id,
      leg_6_duration_min,
      leg_6_rebel_cost,
      leg_7_trip_id,
      leg_7_duration_min,
      leg_7_rebel_cost,
      leg_8_trip_id,
      leg_8_duration_min,
      leg_8_rebel_cost,
      rebel_cost_total,
      rebel_cost_stale,
      leg_1_ride_id,
      leg_2_ride_id,
      leg_3_ride_id,
      leg_4_ride_id,
      leg_5_ride_id,
      leg_6_ride_id,
      leg_7_ride_id,
      leg_8_ride_id,
    } = req.body ?? {};
    if (!device_id) return reply.code(400).send({ error: 'device_id required' });

    const active = db.prepare(
      "SELECT id FROM maeving_sessions WHERE device_id = ? AND status IN ('active', 'scheduled')",
    ).get(device_id);
    if (active) return reply.code(409).send({ error: 'active session exists', session_id: active.id });

    const mode = charge_mode === 'scheduled' ? 'scheduled' : 'now';
    const status = mode === 'scheduled' ? 'scheduled' : 'active';
    const now = started_at ?? new Date().toISOString();

    // Fetch SOC/wh_per_mile from ride rows for any leg that came from a prestaged ride
    const rideIds = [leg_1_ride_id, leg_2_ride_id, leg_3_ride_id, leg_4_ride_id, leg_5_ride_id, leg_6_ride_id, leg_7_ride_id, leg_8_ride_id];
    const rideDataByLeg = rideIds.map((rideId) => {
      if (!rideId) return null;
      return db.prepare('SELECT start_soc_pct, end_soc_pct, wh_per_mile, started_at FROM maeving_rides WHERE id = ?').get(rideId) ?? null;
    });

    // Collect new wh_per_mile values from these rides
    const newWhPerMileValues = rideDataByLeg
      .filter((r) => r?.wh_per_mile != null)
      .map((r) => r.wh_per_mile);

    // Recompute global avg_wh_per_mile from all historical sessions + new rides
    const historicalRows = db.prepare(`
      SELECT leg_1_wh_per_mile, leg_2_wh_per_mile, leg_3_wh_per_mile, leg_4_wh_per_mile,
             leg_5_wh_per_mile, leg_6_wh_per_mile, leg_7_wh_per_mile, leg_8_wh_per_mile
      FROM maeving_sessions
    `).all();
    const allWhValues = [...newWhPerMileValues];
    for (const row of historicalRows) {
      for (const col of ['leg_1_wh_per_mile', 'leg_2_wh_per_mile', 'leg_3_wh_per_mile', 'leg_4_wh_per_mile', 'leg_5_wh_per_mile', 'leg_6_wh_per_mile', 'leg_7_wh_per_mile', 'leg_8_wh_per_mile']) {
        if (row[col] != null) allWhValues.push(row[col]);
      }
    }
    const avgWhPerMile = allWhValues.length > 0
      ? allWhValues.reduce((s, v) => s + v, 0) / allWhValues.length
      : null;

    const result = db.prepare(`
      INSERT INTO maeving_sessions
        (device_id, started_at, soc_start_pct, soc_target_pct, status,
         trip_id, trip_duration_min, charge_mode, departure_time,
         leg_1_trip_id, leg_1_duration_min,
         leg_2_trip_id, leg_2_duration_min,
         leg_3_trip_id, leg_3_duration_min,
         leg_4_trip_id, leg_4_duration_min,
         leg_5_trip_id, leg_5_duration_min,
         leg_6_trip_id, leg_6_duration_min,
         leg_7_trip_id, leg_7_duration_min,
         leg_8_trip_id, leg_8_duration_min,
         leg_1_rebel_cost, leg_2_rebel_cost, leg_3_rebel_cost, leg_4_rebel_cost,
         leg_5_rebel_cost, leg_6_rebel_cost, leg_7_rebel_cost, leg_8_rebel_cost,
         rebel_cost_total, rebel_cost_stale,
         leg_1_wh_per_mile, leg_2_wh_per_mile, leg_3_wh_per_mile, leg_4_wh_per_mile,
         leg_5_wh_per_mile, leg_6_wh_per_mile, leg_7_wh_per_mile, leg_8_wh_per_mile,
         leg_1_start_soc_pct, leg_1_end_soc_pct,
         leg_2_start_soc_pct, leg_2_end_soc_pct,
         leg_3_start_soc_pct, leg_3_end_soc_pct,
         leg_4_start_soc_pct, leg_4_end_soc_pct,
         leg_5_start_soc_pct, leg_5_end_soc_pct,
         leg_6_start_soc_pct, leg_6_end_soc_pct,
         leg_7_start_soc_pct, leg_7_end_soc_pct,
         leg_8_start_soc_pct, leg_8_end_soc_pct,
         leg_1_started_at, leg_2_started_at, leg_3_started_at, leg_4_started_at,
         leg_5_started_at, leg_6_started_at, leg_7_started_at, leg_8_started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      leg_5_trip_id ?? null,
      leg_5_duration_min ?? null,
      leg_6_trip_id ?? null,
      leg_6_duration_min ?? null,
      leg_7_trip_id ?? null,
      leg_7_duration_min ?? null,
      leg_8_trip_id ?? null,
      leg_8_duration_min ?? null,
      leg_1_rebel_cost ?? null,
      leg_2_rebel_cost ?? null,
      leg_3_rebel_cost ?? null,
      leg_4_rebel_cost ?? null,
      leg_5_rebel_cost ?? null,
      leg_6_rebel_cost ?? null,
      leg_7_rebel_cost ?? null,
      leg_8_rebel_cost ?? null,
      rebel_cost_total ?? null,
      rebel_cost_stale ?? 0,
      rideDataByLeg[0]?.wh_per_mile ?? null,
      rideDataByLeg[1]?.wh_per_mile ?? null,
      rideDataByLeg[2]?.wh_per_mile ?? null,
      rideDataByLeg[3]?.wh_per_mile ?? null,
      rideDataByLeg[4]?.wh_per_mile ?? null,
      rideDataByLeg[5]?.wh_per_mile ?? null,
      rideDataByLeg[6]?.wh_per_mile ?? null,
      rideDataByLeg[7]?.wh_per_mile ?? null,
      rideDataByLeg[0]?.start_soc_pct ?? null,
      rideDataByLeg[0]?.end_soc_pct ?? null,
      rideDataByLeg[1]?.start_soc_pct ?? null,
      rideDataByLeg[1]?.end_soc_pct ?? null,
      rideDataByLeg[2]?.start_soc_pct ?? null,
      rideDataByLeg[2]?.end_soc_pct ?? null,
      rideDataByLeg[3]?.start_soc_pct ?? null,
      rideDataByLeg[3]?.end_soc_pct ?? null,
      rideDataByLeg[4]?.start_soc_pct ?? null,
      rideDataByLeg[4]?.end_soc_pct ?? null,
      rideDataByLeg[5]?.start_soc_pct ?? null,
      rideDataByLeg[5]?.end_soc_pct ?? null,
      rideDataByLeg[6]?.start_soc_pct ?? null,
      rideDataByLeg[6]?.end_soc_pct ?? null,
      rideDataByLeg[7]?.start_soc_pct ?? null,
      rideDataByLeg[7]?.end_soc_pct ?? null,
      rideDataByLeg[0]?.started_at ?? null,
      rideDataByLeg[1]?.started_at ?? null,
      rideDataByLeg[2]?.started_at ?? null,
      rideDataByLeg[3]?.started_at ?? null,
      rideDataByLeg[4]?.started_at ?? null,
      rideDataByLeg[5]?.started_at ?? null,
      rideDataByLeg[6]?.started_at ?? null,
      rideDataByLeg[7]?.started_at ?? null,
    );

    if (avgWhPerMile != null) {
      db.prepare('UPDATE maeving_config SET avg_wh_per_mile = ? WHERE id = 1').run(avgWhPerMile);
    }

    invalidateActiveSessionCache(device_id);

    // Write baseline reading only for Charge Now — overnight baseline is written at activation
    if (mode === 'now') {
      const baselineState = getDeviceState(device_id);
      if (baselineState) {
        db.prepare(`
          INSERT INTO maeving_readings (device_id, apower, current, voltage, aenergy_total)
          VALUES (?, ?, ?, ?, ?)
        `).run(device_id, baselineState.apower ?? 0, baselineState.current ?? 0,
               baselineState.voltage ?? 0, baselineState.aenergy_total ?? 0);
      }
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

        return reply.send(
          db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(session.id),
        );
      }
      throw err;
    }
  });

  // POST /api/maeving/sessions/:id/stop
  fastify.post('/api/maeving/sessions/:id/stop', async (req, reply) => {
    const session = db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'not found' });

    const device = db.prepare('SELECT * FROM maeving_devices WHERE id = ?').get(session.device_id);

    if (session.status === 'scheduled') {
      try { await setPlugState(device.ip, false); } catch { /* ignore */ }
      db.prepare(`
        UPDATE maeving_sessions
        SET status = 'complete', ended_at = ?, wh_delivered = 0, calibration_complete = 1
        WHERE id = ?
      `).run(new Date().toISOString(), session.id);
      invalidateActiveSessionCache(session.device_id);
      return reply.send(db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(session.id));
    }

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

    let fixedRateCostDollars = null;
    let hourlySavingsDollars = null;

    if (stats.wh_delivered && !device.cost_free) {
      fixedRateCostDollars = (getComedFixedTotalCents() * (stats.wh_delivered / 1000)) / 100;
      if (actualCostDollars != null) {
        hourlySavingsDollars = fixedRateCostDollars - actualCostDollars;
      }
    }

    let lfEquivalentCost = null;
    let lfEquivalentFixed = null;

    if (device.cost_free) {
      if (stats.wh_delivered != null && priceAvgCents != null) {
        lfEquivalentCost = ((priceAvgCents + getComedBaseRateCents()) * (stats.wh_delivered / 1000)) / 100;
        lfEquivalentFixed = (getComedFixedTotalCents() * (stats.wh_delivered / 1000)) / 100;
      }
      actualCostDollars = 0;
      priceAvgCents = null;
      fixedRateCostDollars = 0;
      hourlySavingsDollars = 0;
    }

    db.prepare(`
      UPDATE maeving_sessions
      SET ended_at               = ?,
          status                 = 'complete',
          wh_delivered           = COALESCE(?, wh_delivered),
          peak_watts             = COALESCE(?, peak_watts),
          avg_watts              = COALESCE(?, avg_watts),
          actual_cost_dollars    = COALESCE(?, actual_cost_dollars),
          price_window_avg_cents = COALESCE(price_window_avg_cents, ?),
          fixed_rate_cost_dollars = COALESCE(?, fixed_rate_cost_dollars),
          hourly_savings_dollars  = COALESCE(?, hourly_savings_dollars),
          lf_equivalent_cost_dollars = ?,
          lf_equivalent_fixed_dollars = ?
      WHERE id = ?
    `).run(
      now,
      stats.wh_delivered,
      stats.peak_watts,
      stats.avg_watts,
      actualCostDollars,
      priceAvgCents,
      fixedRateCostDollars,
      hourlySavingsDollars,
      lfEquivalentCost,
      lfEquivalentFixed,
      session.id,
    );

    const savingsDelta = device.cost_free
      ? (lfEquivalentCost ?? 0)
      : Math.max(0, (fixedRateCostDollars ?? 0) - (actualCostDollars ?? 0));
    db.prepare(`
      UPDATE maeving_config SET running_savings_dollars = MAX(0, running_savings_dollars + ?) WHERE 1=1
    `).run(savingsDelta);

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
