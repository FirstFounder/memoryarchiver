import db from '../db/client.js';
import { getLatestFleetSessionCount } from './fleetSessionFetch.js';

function getVehicleConfig(vin) {
  return db.prepare(`
    SELECT vin, pack_swap_date
    FROM tesla_config
    WHERE vin = ?
  `).get(vin);
}

function getSettings() {
  return db.prepare(`
    SELECT min_sessions_for_capacity, capacity_update_interval
    FROM tesla_settings
    WHERE id = 1
  `).get();
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

export function derivePackCapacity(vin) {
  const config = getVehicleConfig(vin);
  const settings = getSettings();
  if (!config || !settings) return null;

  const sessions = db.prepare(`
    SELECT charge_energy_added, start_soc, end_soc
    FROM tesla_sessions
    WHERE vin = ?
      AND source = 'fleet'
      AND suspect = 0
      AND start_soc IS NOT NULL
      AND end_soc IS NOT NULL
      AND (end_soc - start_soc) >= 10
      AND charge_energy_added > 0
      AND (
        ? IS NULL
        OR session_start > (unixepoch(?) * 1000)
      )
    ORDER BY session_start ASC, id ASC
  `).all(vin, config.pack_swap_date ?? null, config.pack_swap_date ?? null);

  if (sessions.length < settings.min_sessions_for_capacity) {
    return null;
  }

  const estimates = sessions.map((session) => (
    Number(session.charge_energy_added) / ((Number(session.end_soc) - Number(session.start_soc)) / 100)
  )).filter(Number.isFinite);

  if (estimates.length < settings.min_sessions_for_capacity) {
    return null;
  }

  return {
    capacityKwh: median(estimates),
    sessionCount: estimates.length,
  };
}

export function maybeUpdatePackCapacity(vin) {
  const settings = getSettings();
  if (!settings?.capacity_update_interval) return null;

  const sessionCount = getLatestFleetSessionCount(vin);
  if (!sessionCount || (sessionCount % settings.capacity_update_interval) !== 0) {
    return null;
  }

  const derived = derivePackCapacity(vin);
  if (!derived) return null;

  db.prepare(`
    UPDATE tesla_config
    SET pack_capacity_kwh = ?,
        updated_at = ?
    WHERE vin = ?
  `).run(derived.capacityKwh, Date.now(), vin);

  console.info(
    `[packCapacity] ${vin}: updated pack_capacity_kwh=${derived.capacityKwh.toFixed(2)} from ${derived.sessionCount} sessions`,
  );

  return derived;
}
