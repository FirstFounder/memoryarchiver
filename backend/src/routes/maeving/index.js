import config from '../../config.js';
import db from '../../db/client.js';
import exportDbRoutes from './exportDb.js';
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
  findDeferredCalibration,
  computeChargeCurve,
} from '../../lib/maevingCalibration.js';
import { computeRebelCostSync } from '../../lib/eiaGasPrice.js';

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

  // Exclude rows with null aenergy_total — JS coerces null to 0 in arithmetic, which
  // would make the delta equal the Shelly's entire lifetime accumulated total.
  const energyRows = rows.filter(r => r.aenergy_total != null);
  if (energyRows.length < 2) return { wh_delivered: null, peak_watts: null, avg_watts: null, reading_count: rows.length };

  const first = energyRows[0];
  const last = energyRows[energyRows.length - 1];
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

  await fastify.register(exportDbRoutes);

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
             r.start_soc_pct, r.end_soc_pct, r.wh_per_mile, r.notes, r.rebel_cost,
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
    const rebelCost = computeRebelCostSync(trip.distance_miles);
    const result = db.prepare(`
      INSERT INTO maeving_rides (trip_id, started_at, finished_at, duration_min, start_soc_pct, rebel_cost)
      VALUES (?, ?, NULL, NULL, ?, ?)
    `).run(trip_id, startedAt, start_soc_pct ?? null, rebelCost);

    // Consume a deferred calibration from the most recent completed charge session.
    // The user's starting SOC is the observed SOC after charging — use it to update the pack EMA.
    if (start_soc_pct != null) {
      const deferred = findDeferredCalibration();
      if (deferred) {
        try {
          recordCalibrationEntry(deferred.id, start_soc_pct);
          fastify.log.info(
            { sessionId: deferred.id, start_soc_pct },
            'Maeving: deferred calibration applied at ride start',
          );
        } catch (err) {
          fastify.log.warn({ err, sessionId: deferred.id }, 'Maeving: deferred calibration failed');
        }
      }
    }

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
      rebel_cost: rebelCost,
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

    if (whPerMile != null) {
      const avgRow = db.prepare('SELECT AVG(wh_per_mile) AS avg FROM maeving_rides WHERE wh_per_mile IS NOT NULL').get();
      if (avgRow?.avg != null) {
        db.prepare('UPDATE maeving_config SET avg_wh_per_mile = ? WHERE id = 1').run(avgRow.avg);
      }
    }

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

    let newRebelCost = ride.rebel_cost;
    if (trip_id !== undefined) {
      const tripForRebel = tripForCalc ??
        db.prepare('SELECT distance_miles FROM maeving_trips WHERE id = ?').get(ride.trip_id);
      newRebelCost = computeRebelCostSync(tripForRebel.distance_miles);
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
          rebel_cost = ?,
          notes = ?, trip_id = ?,
          windbreaker    = ?,
          overheat_pack  = ?,
          overheat_motor = ?,
          overheat_level = ?,
          sporty_level   = ?
      WHERE id = ?
    `).run(newStartedAt, newFinishedAt, durationMin, newEndSoc, whPerMile,
           newRebelCost,
           notes !== undefined ? notes : ride.notes, newTripId,
           windbreaker, overheatPack, overheatMotor, overheatLevel, sportyLevel,
           ride.id);
    if (end_soc_pct !== undefined || trip_id !== undefined) {
      const latestRide = db.prepare(`
        SELECT end_soc_pct FROM maeving_rides
        WHERE finished_at IS NOT NULL AND end_soc_pct IS NOT NULL
        ORDER BY finished_at DESC LIMIT 1
      `).get();
      if (latestRide?.end_soc_pct != null) {
        db.prepare('UPDATE maeving_config SET prev_max_soc_pct = ? WHERE id = 1').run(latestRide.end_soc_pct);
      }
    }

    if (end_soc_pct !== undefined || trip_id !== undefined) {
      const avgRow = db.prepare('SELECT AVG(wh_per_mile) AS avg FROM maeving_rides WHERE wh_per_mile IS NOT NULL').get();
      if (avgRow?.avg != null) {
        db.prepare('UPDATE maeving_config SET avg_wh_per_mile = ? WHERE id = 1').run(avgRow.avg);
      }
    }

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

  fastify.get('/api/maeving/sessions/:id/ride-telemetry', async (req, reply) => {
    const session = db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    const legNums = [1, 2, 3, 4, 5, 6, 7, 8];
    const result = {};
    for (const n of legNums) {
      const rideId = session[`leg_${n}_ride_id`];
      if (!rideId) continue;
      const pings = db.prepare(`
        SELECT id, tst, lat, lon, alt, vel, cog, temp_f, wind_speed_mph, wind_dir_deg, motion
        FROM owntracks_locations
        WHERE ride_id = ?
        ORDER BY tst ASC
      `).all(rideId);
      const autoPings = pings.filter(p => p.motion === 'automotive' && p.vel != null);
      const maxVelKph = autoPings.length ? Math.max(...autoPings.map(p => p.vel)) : null;
      const avgVelKph = autoPings.length
        ? autoPings.reduce((s, p) => s + p.vel, 0) / autoPings.length
        : null;
      let elevationGainM = 0;
      let elevationLossM = 0;
      const alts = pings.filter(p => p.alt != null).map(p => p.alt);
      for (let i = 1; i < alts.length; i++) {
        const delta = alts[i] - alts[i - 1];
        if (delta > 0) elevationGainM += delta;
        else elevationLossM += Math.abs(delta);
      }
      function haversineKm(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      }
      let distanceKm = 0;
      for (let i = 1; i < pings.length; i++) {
        distanceKm += haversineKm(pings[i - 1].lat, pings[i - 1].lon, pings[i].lat, pings[i].lon);
      }
      const weatherPings = pings.filter(p => p.temp_f != null);
      const avgTempF = weatherPings.length
        ? weatherPings.reduce((s, p) => s + p.temp_f, 0) / weatherPings.length
        : null;
      const avgWindMph = weatherPings.length
        ? weatherPings.reduce((s, p) => s + (p.wind_speed_mph ?? 0), 0) / weatherPings.length
        : null;
      const durationSec = pings.length >= 2
        ? pings[pings.length - 1].tst - pings[0].tst
        : null;
      result[n] = {
        pings,
        stats: {
          ping_count: pings.length,
          max_vel_kph: maxVelKph,
          avg_vel_kph: avgVelKph,
          elevation_gain_m: elevationGainM > 0 ? elevationGainM : null,
          elevation_loss_m: elevationLossM > 0 ? elevationLossM : null,
          distance_km: distanceKm > 0 ? distanceKm : null,
          avg_temp_f: avgTempF,
          avg_wind_mph: avgWindMph,
          duration_sec: durationSec,
        }
      };
    }
    return reply.send({ legs: result });
  });

  // ── Sessions ──────────────────────────────────────────────────────────────────

  fastify.get('/api/maeving/sessions', async (req, reply) => {
    const { device_id, status, limit } = req.query;
    let sql = 'SELECT * FROM maeving_sessions WHERE 1=1';
    const params = [];
    if (device_id) { sql += ' AND device_id = ?'; params.push(device_id); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    const rowLimit = Math.min(parseInt(limit, 10) || 50, 500);
    sql += ` ORDER BY started_at DESC LIMIT ${rowLimit}`;
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
      leg_5_trip_id,
      leg_5_duration_min,
      leg_6_trip_id,
      leg_6_duration_min,
      leg_7_trip_id,
      leg_7_duration_min,
      leg_8_trip_id,
      leg_8_duration_min,
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

    // Compute rebel costs server-side from rides and manual legs
    const legRebelCostValues = {};
    let rebelCostTotal = 0;
    let hasRebelCost = false;

    const legTripIds = [leg_1_trip_id, leg_2_trip_id, leg_3_trip_id, leg_4_trip_id,
                        leg_5_trip_id, leg_6_trip_id, leg_7_trip_id, leg_8_trip_id];
    const legRideIds  = [leg_1_ride_id, leg_2_ride_id, leg_3_ride_id, leg_4_ride_id,
                         leg_5_ride_id, leg_6_ride_id, leg_7_ride_id, leg_8_ride_id];

    let sessionTotalMiles = 0;
    for (let n = 1; n <= 8; n++) {
      const rideId = legRideIds[n - 1];
      const tripId = legTripIds[n - 1];
      if (rideId) {
        const ride = db.prepare('SELECT rebel_cost FROM maeving_rides WHERE id = ?').get(rideId);
        if (ride?.rebel_cost != null) {
          legRebelCostValues[n] = ride.rebel_cost;
          rebelCostTotal += ride.rebel_cost;
          hasRebelCost = true;
        }
      }
      if (tripId) {
        const trip = db.prepare('SELECT distance_miles FROM maeving_trips WHERE id = ?').get(tripId);
        if (trip?.distance_miles != null) {
          sessionTotalMiles += trip.distance_miles;
        }
        if (!rideId) {
          const cost = computeRebelCostSync(trip?.distance_miles);
          if (cost != null) {
            legRebelCostValues[n] = cost;
            rebelCostTotal += cost;
            hasRebelCost = true;
          }
        }
      }
    }

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
         leg_5_started_at, leg_6_started_at, leg_7_started_at, leg_8_started_at,
         leg_1_ride_id, leg_2_ride_id, leg_3_ride_id, leg_4_ride_id,
         leg_5_ride_id, leg_6_ride_id, leg_7_ride_id, leg_8_ride_id,
         total_miles)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      legRebelCostValues[1] ?? null,
      legRebelCostValues[2] ?? null,
      legRebelCostValues[3] ?? null,
      legRebelCostValues[4] ?? null,
      legRebelCostValues[5] ?? null,
      legRebelCostValues[6] ?? null,
      legRebelCostValues[7] ?? null,
      legRebelCostValues[8] ?? null,
      hasRebelCost ? rebelCostTotal : null,
      0,
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
      leg_1_ride_id ?? null,
      leg_2_ride_id ?? null,
      leg_3_ride_id ?? null,
      leg_4_ride_id ?? null,
      leg_5_ride_id ?? null,
      leg_6_ride_id ?? null,
      leg_7_ride_id ?? null,
      leg_8_ride_id ?? null,
      sessionTotalMiles > 0 ? sessionTotalMiles : null,
    );

    if (avgWhPerMile != null) {
      db.prepare('UPDATE maeving_config SET avg_wh_per_mile = ? WHERE id = 1').run(avgWhPerMile);
    }

    // Consume a deferred calibration from the previous charge session, if one exists.
    // Back-to-back charges without an intervening ride use the new session's starting SOC
    // as the observed post-charge SOC for the previous session.
    if (soc_start_pct != null) {
      const deferred = findDeferredCalibration();
      if (deferred) {
        try {
          recordCalibrationEntry(deferred.id, soc_start_pct);
          fastify.log.info(
            { sessionId: deferred.id, soc_start_pct },
            'Maeving: deferred calibration applied at charge session start',
          );
        } catch (err) {
          fastify.log.warn({ err, sessionId: deferred.id }, 'Maeving: deferred calibration failed at session start');
        }
      }
    }

    invalidateActiveSessionCache(device_id);

    // Write baseline reading only for Charge Now — overnight baseline is written at activation.
    // Only write if aenergy_total is known; a null value would coerce to 0 in delta arithmetic,
    // making wh_delivered equal the Shelly's entire lifetime accumulated total.
    if (mode === 'now') {
      const baselineState = getDeviceState(device_id);
      if (baselineState && baselineState.aenergy_total != null) {
        db.prepare(`
          INSERT INTO maeving_readings (device_id, apower, current, voltage, aenergy_total)
          VALUES (?, ?, ?, ?, ?)
        `).run(device_id, baselineState.apower ?? 0, baselineState.current ?? 0,
               baselineState.voltage ?? 0, baselineState.aenergy_total);
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
    if (finalState && finalState.aenergy_total != null) {
      db.prepare(`
        INSERT INTO maeving_readings (device_id, apower, current, voltage, aenergy_total)
        VALUES (?, ?, ?, ?, ?)
      `).run(session.device_id, finalState.apower ?? 0, finalState.current ?? 0,
             finalState.voltage ?? 0, finalState.aenergy_total);
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

    const cfg = getConfig();
    let estimatedSocAtStop = null;
    if (stats.wh_delivered != null && cfg.effective_capacity_wh > 0 && session.soc_start_pct != null) {
      estimatedSocAtStop = Math.min(
        100,
        session.soc_start_pct + (stats.wh_delivered / cfg.effective_capacity_wh) * 100,
      );
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
          lf_equivalent_fixed_dollars = ?,
          estimated_soc_at_stop  = COALESCE(?, estimated_soc_at_stop)
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
      estimatedSocAtStop,
      session.id,
    );

    const savingsDelta = device.cost_free
      ? (lfEquivalentCost ?? 0)
      : Math.max(0, (fixedRateCostDollars ?? 0) - (actualCostDollars ?? 0));
    db.prepare(`
      UPDATE maeving_config SET running_savings_dollars = MAX(0, running_savings_dollars + ?) WHERE 1=1
    `).run(savingsDelta);

    invalidateActiveSessionCache(session.device_id);

    if (session.soc_target_pct != null) {
      db.prepare('UPDATE maeving_config SET prev_max_soc_pct = ? WHERE id = 1').run(session.soc_target_pct);
    }

    // Mark calibration complete immediately so the UI returns to the Plug In card.
    // The actual SOC observation is deferred — it is captured at the next ride start.
    db.prepare(`
      UPDATE maeving_sessions SET calibration_complete = 1 WHERE id = ?
    `).run(session.id);
    recordSessionComplete(session.id);

    try {
      computeChargeCurve(session.id, db);
    } catch (err) {
      fastify.log.warn({ err }, 'computeChargeCurve failed — non-fatal');
    }

    // Consume rides that were prestaged for this session
    for (let n = 1; n <= 8; n++) {
      const rideId = session[`leg_${n}_ride_id`];
      if (rideId != null) {
        db.prepare('DELETE FROM maeving_rides WHERE id = ?').run(rideId);
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
    if (session.calibration_complete && session.actual_soc_pct != null) {
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
    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN d.cost_free = 0 AND s.wh_delivered IS NOT NULL
                          THEN s.wh_delivered ELSE 0 END), 0)       AS total_wh_added,
        COALESCE(SUM(CASE WHEN d.cost_free = 0 AND s.wh_delivered IS NOT NULL
                          THEN s.actual_cost_dollars ELSE 0 END), 0) AS total_money_spent,
        SUM(s.rebel_cost_total)                                       AS total_rebel_cost
      FROM maeving_sessions s
      JOIN maeving_devices d ON d.id = s.device_id
      WHERE s.status IN ('complete', 'charger_complete')
    `).get();
    const milesTotals = db.prepare(`
      SELECT COALESCE(SUM(total_miles), 0) AS total_miles
      FROM maeving_sessions
      WHERE status IN ('complete', 'charger_complete')
        AND total_miles IS NOT NULL
    `).get();
    const taperOnsetByDevice = db.prepare(`
      SELECT c.device_id, d.label AS device_label,
             ROUND(AVG(c.taper_onset_soc_pct), 1) AS avg_taper_onset_soc,
             COUNT(*) AS curve_count
      FROM maeving_charge_curves c
      JOIN maeving_devices d ON d.id = c.device_id
      WHERE c.taper_onset_soc_pct IS NOT NULL
      GROUP BY c.device_id
    `).all();

    const latestCurveRow = db.prepare(`
      SELECT c.*, d.label AS device_label, d.site_key
      FROM maeving_charge_curves c
      JOIN maeving_devices d ON d.id = c.device_id
      WHERE c.power_timeline_json IS NOT NULL
      ORDER BY c.recorded_at DESC
      LIMIT 1
    `).get();

    return reply.send({
      ...cfg,
      hasPendingCalibration: pending !== null,
      pendingSession: pending,
      capacityHistory: history.slice(-10),
      total_wh_added: totals.total_wh_added,
      total_money_spent: totals.total_money_spent,
      total_rebel_cost: totals.total_rebel_cost,
      total_miles: milesTotals.total_miles,
      taperOnsetByDevice,
      latestChargeCurve: latestCurveRow ? {
        ...latestCurveRow,
        power_timeline_json: latestCurveRow.power_timeline_json
          ? JSON.parse(latestCurveRow.power_timeline_json)
          : null,
      } : null,
    });
  });

  // DELETE /api/maeving/calibration/:index
  fastify.delete('/api/maeving/calibration/:index', async (req, reply) => {
    const idx = parseInt(req.params.index, 10);
    if (!Number.isInteger(idx) || idx < 0) return reply.code(400).send({ error: 'invalid index' });

    const cfg = db.prepare(
      'SELECT capacity_history_json FROM maeving_config WHERE id = 1',
    ).get();
    const entries = JSON.parse(cfg?.capacity_history_json || '[]');

    if (idx >= entries.length) return reply.code(400).send({ error: 'index out of bounds' });

    const removed = entries[idx];
    const remaining = entries.filter((_, i) => i !== idx);

    let newCapacity, newCount, newJson;
    if (remaining.length === 0) {
      newCapacity = 5760;
      newCount = 0;
      newJson = '[]';
    } else {
      let ema = remaining[0].observed_wh;
      for (let i = 1; i < remaining.length; i++) {
        ema = 0.15 * remaining[i].observed_wh + 0.85 * ema;
      }
      newCapacity = Math.round(ema);
      newCount = remaining.length;
      newJson = JSON.stringify(remaining);
    }

    db.prepare(`
      UPDATE maeving_config
      SET capacity_history_json = ?, effective_capacity_wh = ?, observation_count = ?
      WHERE id = 1
    `).run(newJson, newCapacity, newCount);

    return reply.send({ ok: true, effective_capacity_wh: newCapacity, observation_count: newCount });
  });

  // DELETE /api/maeving/sessions/:id
  fastify.delete('/api/maeving/sessions/:id', async (req, reply) => {
    const session = db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    if (session.status === 'active' || session.status === 'scheduled') {
      return reply.code(409).send({ error: 'cannot delete an active or scheduled session' });
    }

    // Clear maeving_config.prev_session_id if it points here — foreign_keys=ON would
    // otherwise block the DELETE with a constraint violation.
    db.prepare(
      'UPDATE maeving_config SET prev_session_id = NULL WHERE prev_session_id = ?'
    ).run(session.id);

    db.prepare('DELETE FROM maeving_sessions WHERE id = ?').run(session.id);

    // Recompute running_savings_dollars from all remaining completed sessions
    const savingsRow = db.prepare(`
      SELECT COALESCE(SUM(
        CASE
          WHEN d.cost_free = 1 THEN COALESCE(s.lf_equivalent_cost_dollars, 0)
          ELSE MAX(0, COALESCE(s.fixed_rate_cost_dollars, 0) - COALESCE(s.actual_cost_dollars, 0))
        END
      ), 0) AS total_savings
      FROM maeving_sessions s
      JOIN maeving_devices d ON d.id = s.device_id
      WHERE s.status IN ('complete', 'charger_complete')
    `).get();
    db.prepare('UPDATE maeving_config SET running_savings_dollars = MAX(0, ?) WHERE id = 1').run(
      savingsRow?.total_savings ?? 0,
    );

    // Recompute avg_wh_per_mile from remaining sessions
    const whRows = db.prepare(`
      SELECT leg_1_wh_per_mile, leg_2_wh_per_mile, leg_3_wh_per_mile, leg_4_wh_per_mile,
             leg_5_wh_per_mile, leg_6_wh_per_mile, leg_7_wh_per_mile, leg_8_wh_per_mile
      FROM maeving_sessions
    `).all();
    const allWh = [];
    for (const row of whRows) {
      for (const col of ['leg_1_wh_per_mile','leg_2_wh_per_mile','leg_3_wh_per_mile','leg_4_wh_per_mile',
                          'leg_5_wh_per_mile','leg_6_wh_per_mile','leg_7_wh_per_mile','leg_8_wh_per_mile']) {
        if (row[col] != null) allWh.push(row[col]);
      }
    }
    if (allWh.length > 0) {
      const avg = allWh.reduce((s, v) => s + v, 0) / allWh.length;
      db.prepare('UPDATE maeving_config SET avg_wh_per_mile = ? WHERE id = 1').run(avg);
    }

    return reply.code(204).send();
  });

  // GET /api/maeving/sessions/:id/curve
  fastify.get('/api/maeving/sessions/:id/curve', async (req, reply) => {
    const session = db.prepare('SELECT id FROM maeving_sessions WHERE id = ?').get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    const row = db.prepare('SELECT * FROM maeving_charge_curves WHERE session_id = ?').get(session.id);
    if (!row) return reply.send(null);
    return reply.send({
      ...row,
      power_timeline_json: row.power_timeline_json ? JSON.parse(row.power_timeline_json) : null,
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
