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

  const socValue = session.actual_soc_pct ?? session.soc_target_pct;

  db.prepare(`
    UPDATE maeving_config
    SET prev_max_soc_pct = ?,
        prev_session_id  = ?
    WHERE id = 1
  `).run(socValue, sessionId);
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
