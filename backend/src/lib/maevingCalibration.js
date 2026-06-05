import db from '../db/client.js';

const MAEVING_TOTAL_WH_DEFAULT = 2880;
const TAPER_THRESHOLD_PCT = 0.80;
const CHARGE_COMPLETE_WATTS = 20;
const CHARGE_COMPLETE_CONSECUTIVE = 3;

export function getConfig() {
  return db.prepare('SELECT * FROM maeving_config WHERE id = 1').get();
}

export function getEffectiveCapacity() {
  return getConfig().effective_capacity_wh;
}

export function getPrevMaxSoc() {
  return getConfig().prev_max_soc_pct ?? null;
}

export function recordCalibrationEntry(sessionId, actualSocPct) {
  const session = db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(sessionId);
  if (!session) throw new Error('session not found');
  if (session.wh_delivered == null) throw new Error('session has no wh_delivered — cannot calibrate');

  const socDelta = actualSocPct - (session.soc_start_pct ?? 0);
  if (socDelta <= 0) throw new Error('SOC delta must be positive');

  const observedEffectiveWh = session.wh_delivered / (socDelta / 100);

  const config = getConfig();
  const alpha = config.observation_count < 5 ? 0.3 : 0.15;
  const prevCapacity = config.effective_capacity_wh;
  const newCapacity = Math.round(alpha * observedEffectiveWh + (1 - alpha) * prevCapacity);

  const history = JSON.parse(config.capacity_history_json || '[]');
  history.push({
    session_id: sessionId,
    observed_wh: observedEffectiveWh,
    soc_delta: socDelta,
    prev_capacity: prevCapacity,
    new_capacity: newCapacity,
    recorded_at: new Date().toISOString(),
  });

  db.prepare(`
    UPDATE maeving_config
    SET effective_capacity_wh  = ?,
        prev_max_soc_pct       = ?,
        prev_session_id        = ?,
        observation_count      = observation_count + 1,
        capacity_history_json  = ?
    WHERE id = 1
  `).run(newCapacity, actualSocPct, sessionId, JSON.stringify(history));

  db.prepare(`
    UPDATE maeving_sessions
    SET actual_soc_pct       = ?,
        calibration_complete = 1
    WHERE id = ?
  `).run(actualSocPct, sessionId);

  return {
    prevCapacity,
    newCapacity,
    observedWh: observedEffectiveWh,
    delta: newCapacity - prevCapacity,
  };
}

export function recordSessionComplete(sessionId) {
  const session = db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(sessionId);
  if (!session) return;

  const socValue =
    session.actual_soc_pct ??
    (session.estimated_soc_at_stop != null ? Math.round(session.estimated_soc_at_stop) : null) ??
    session.soc_target_pct;

  db.prepare(`
    UPDATE maeving_config
    SET prev_max_soc_pct = ?,
        prev_session_id  = ?
    WHERE id = 1
  `).run(socValue, sessionId);
}

export function findDeferredCalibration() {
  return db.prepare(`
    SELECT * FROM maeving_sessions
    WHERE (status = 'complete' OR status = 'charger_complete')
      AND calibration_complete = 1
      AND actual_soc_pct IS NULL
      AND wh_delivered > 0
      AND ended_at >= datetime('now', '-7 days')
    ORDER BY ended_at DESC
    LIMIT 1
  `).get() ?? null;
}

export function computeTripStats(socStart, legs, devices) {
  const validLegs = legs.filter(l => l.trip_id != null);
  if (!validLegs.length) return null;

  const aggregateDistanceMiles = validLegs.reduce((sum, leg) => {
    const trip = devices.find(t => t.id === leg.trip_id);
    return sum + (trip?.distance_miles ?? 0);
  }, 0);

  if (aggregateDistanceMiles === 0) return null;

  const config = getConfig();
  if (config.prev_max_soc_pct == null) return null;

  const energyConsumedWh = ((config.prev_max_soc_pct - socStart) / 100) * config.effective_capacity_wh;
  const whPerMile = energyConsumedWh / aggregateDistanceMiles;

  return {
    aggregate_distance_miles: aggregateDistanceMiles,
    energy_consumed_wh: energyConsumedWh,
    wh_per_mile: whPerMile,
    prev_max_soc_pct: config.prev_max_soc_pct,
  };
}

export function hasPendingCalibration() {
  const config = db.prepare('SELECT calibration_mode FROM maeving_config WHERE id = 1').get();
  if (!config || config.calibration_mode !== 1) return null;

  return db.prepare(`
    SELECT * FROM maeving_sessions
    WHERE (status = 'complete' OR status = 'charger_complete')
      AND calibration_complete = 0
      AND (wh_delivered IS NULL OR wh_delivered > 0)
    ORDER BY ended_at DESC
    LIMIT 1
  `).get() ?? null;
}

export function isCalibrationBlocked() {
  return hasPendingCalibration() !== null;
}

export function skipCalibration(sessionId) {
  const session = db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(sessionId);
  if (!session) throw new Error('session not found');
  if (session.calibration_complete) throw new Error('session already calibrated');

  db.prepare(`
    UPDATE maeving_sessions
    SET calibration_complete = 1
    WHERE id = ?
  `).run(sessionId);

  console.log('Maeving: calibration skipped for session %d — no energy data', sessionId);

  return db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(sessionId);
}

export function computeChargeCurve(sessionId, db) {
  const session = db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(sessionId);
  if (!session || session.wh_delivered == null) return null;

  const readings = db.prepare(`
    SELECT recorded_at, apower, aenergy_total
    FROM maeving_readings
    WHERE device_id = ?
      AND recorded_at >= datetime(?)
      AND (? IS NULL OR recorded_at <= datetime(?))
    ORDER BY recorded_at ASC
  `).all(session.device_id, session.started_at, session.ended_at ?? null, session.ended_at ?? null);

  if (readings.length < 10) return null;

  const firstTs = new Date(readings[0].recorded_at).getTime();
  const raw = readings.map(r => ({
    minutes: (new Date(r.recorded_at).getTime() - firstTs) / 60_000,
    watts: r.apower ?? 0,
    aenergy_total: r.aenergy_total,
  }));

  // Median-3 filter: eliminates isolated zero-watt readings caused by MQTT delivery gaps
  // where the Shelly momentarily reports 0 W between otherwise full-power readings.
  const median3 = raw.length < 3 ? raw : raw.map((r, i) => {
    if (i === 0 || i === raw.length - 1) return r;
    const vals = [raw[i - 1].watts, r.watts, raw[i + 1].watts].sort((a, b) => a - b);
    return { ...r, watts: vals[1] };
  });
  // Forward-fill: once the session has reached full charging power, treat any zero-watt
  // reading as an MQTT gap (the Shelly went silent, not the charger). Hold the last known
  // wattage forward. Zeros before the first full-power reading (ramp-up) are preserved.
  // The last reading is always preserved (it is the genuine session-end zero).
  const peakForFill = Math.max(...median3.map(r => r.watts));
  const fullPowerThreshold = peakForFill * 0.8;
  let lastNonZero = 0;
  let reachedFullPower = false;
  const enriched = median3.map((r, i) => {
    if (r.watts >= fullPowerThreshold) reachedFullPower = true;
    if (r.watts > 0) lastNonZero = r.watts;
    // Fill zeros mid-session (after full power reached), but not the final reading
    if (reachedFullPower && r.watts === 0 && i < median3.length - 1) {
      return { ...r, watts: lastNonZero };
    }
    return r;
  });

  const peakWatts = Math.max(...enriched.map(r => r.watts));
  if (peakWatts < 800) return null;

  const threshold = peakWatts * 0.92;
  let taperOnsetIdx = null;

  for (let i = 4; i < enriched.length; i++) {
    if (enriched[i].minutes < 5) continue;
    if (enriched.slice(i - 4, i + 1).every(r => r.watts < threshold)) {
      taperOnsetIdx = i - 4;
      break;
    }
  }

  let taperOnsetWhDelivered = null;
  let taperOnsetSocPct = null;
  let taperOnsetWatts = null;
  let taperOnsetMinutes = null;

  if (taperOnsetIdx !== null) {
    const onset = enriched[taperOnsetIdx];
    const baselineEnergy = enriched[0].aenergy_total ?? 0;
    taperOnsetWhDelivered = Math.max(0, (onset.aenergy_total ?? 0) - baselineEnergy);
    taperOnsetWatts = onset.watts;
    taperOnsetMinutes = onset.minutes;

    const cfg = db.prepare('SELECT effective_capacity_wh FROM maeving_config WHERE id = 1').get();
    const effectiveCapacityWh = cfg?.effective_capacity_wh ?? 2880;
    if (session.soc_start_pct != null && effectiveCapacityWh > 0) {
      taperOnsetSocPct = session.soc_start_pct + (taperOnsetWhDelivered / effectiveCapacityWh) * 100;
    }
  }

  let timelinePoints = enriched;
  if (enriched.length > 60) {
    const step = (enriched.length - 1) / 59;
    timelinePoints = Array.from({ length: 60 }, (_, i) => enriched[Math.round(i * step)]);
  }
  const powerTimelineJson = JSON.stringify(
    timelinePoints.map(r => ({ t: Math.round(r.minutes * 10) / 10, w: Math.round(r.watts) })),
  );

  db.prepare('DELETE FROM maeving_charge_curves WHERE session_id = ?').run(sessionId);
  const result = db.prepare(`
    INSERT INTO maeving_charge_curves (
      session_id, device_id,
      taper_onset_wh_delivered, taper_onset_soc_pct, taper_onset_watts, taper_onset_minutes,
      peak_watts_session, readings_count, power_timeline_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId, session.device_id,
    taperOnsetWhDelivered, taperOnsetSocPct, taperOnsetWatts, taperOnsetMinutes,
    peakWatts, readings.length, powerTimelineJson,
  );

  return db.prepare('SELECT * FROM maeving_charge_curves WHERE id = ?').get(result.lastInsertRowid);
}

export function analyzeTaper(sessionId) {
  const readings = db.prepare(`
    SELECT * FROM maeving_taper_readings
    WHERE session_id = ?
    ORDER BY recorded_at ASC
  `).all(sessionId);

  if (readings.length < 5) return null;

  const session = db.prepare('SELECT * FROM maeving_sessions WHERE id = ?').get(sessionId);
  if (!session) return null;

  const allReadings = db.prepare(`
    SELECT apower FROM maeving_readings
    WHERE device_id = ? AND recorded_at >= datetime(?)
    ORDER BY recorded_at ASC
  `).all(session.device_id, session.started_at);

  const peakWatts = allReadings.length
    ? Math.max(...allReadings.map(r => r.apower ?? 0))
    : 0;

  const taperThreshold = peakWatts * TAPER_THRESHOLD_PCT;
  const taperStartIdx = readings.findIndex(r => r.apower < taperThreshold);

  if (taperStartIdx === -1) return { taper_detected: false };

  const taperReadings = readings.slice(taperStartIdx);
  const firstTaper = taperReadings[0];
  const lastTaper = taperReadings[taperReadings.length - 1];

  const taperDurationMin =
    (new Date(lastTaper.recorded_at) - new Date(firstTaper.recorded_at)) / 60_000;
  const taperWhDeliveredRaw = lastTaper.aenergy_total - firstTaper.aenergy_total;

  return {
    taper_detected: true,
    taper_start_at: firstTaper.recorded_at,
    peak_watts: peakWatts,
    taper_start_soc: firstTaper.estimated_soc,
    taper_duration_min: taperDurationMin,
    taper_wh_delivered: taperWhDeliveredRaw >= 0 ? taperWhDeliveredRaw : 0,
    soc_curve: taperReadings.map(r => ({
      estimated_soc: r.estimated_soc,
      apower: r.apower,
      recorded_at: r.recorded_at,
    })),
  };
}
