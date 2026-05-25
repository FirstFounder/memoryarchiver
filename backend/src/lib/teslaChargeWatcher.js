import db from '../db/client.js';
import { getCarState } from './teslaMqtt.js';
import { fetchSessionSnapshot } from './fleetSessionFetch.js';
import { fetchActualPrices, fetchCurrentHourPrice } from './coMedPrices.js';

function getComedBaseRateCents() {
  const month = new Date().getMonth() + 1;
  return (month >= 6 && month <= 9) ? 4.27 : 2.90;
}

const COMED_FIXED_SUPPLY_CENTS = 9.66;

let pollingInterval = null;
let watcherLogger = null;
let vinConfigMap = [];

const prevChargingState = {};
const activeSessionId = {};
const activeSessionStart = {};

function insertReadingRow(vin, state) {
  db.prepare(`
    INSERT INTO tesla_readings (vin, voltage, current_a, power_kw)
    VALUES (?, ?, ?, ?)
  `).run(
    vin,
    state.charger_voltage ?? null,
    state.charge_current_request ?? null,
    state.charger_power ?? null,
  );
}

async function handleChargeEnd(vin, sessionId, sessionStartMs) {
  const sessionEnd = Date.now();
  const sessionStartIso = new Date(sessionStartMs).toISOString();

  const stats = db.prepare(`
    SELECT
      AVG(voltage)    AS avg_voltage,
      MAX(voltage)    AS max_voltage,
      AVG(current_a)  AS avg_current,
      MAX(current_a)  AS max_current
    FROM tesla_readings
    WHERE vin = ? AND recorded_at >= datetime(?)
  `).get(vin, sessionStartIso);

  let snapshot = null;
  let snapshotFailed = false;
  try {
    snapshot = await fetchSessionSnapshot(vin);
  } catch (err) {
    watcherLogger?.warn({ err, vin }, 'Tesla charge watcher: Fleet API snapshot failed for %s', vin);
    snapshotFailed = true;
  }

  const TOLERANCE_MS = 30 * 60 * 1000;
  let supplyEntries = [];
  let supplyAvgCents = null;
  try {
    const allPrices = await fetchActualPrices();
    supplyEntries = allPrices.filter(
      e => e.millisUTC >= sessionStartMs - TOLERANCE_MS && e.millisUTC <= sessionEnd + TOLERANCE_MS,
    );
    if (supplyEntries.length) {
      supplyAvgCents = supplyEntries.reduce((s, e) => s + e.price, 0) / supplyEntries.length;
    }
  } catch (err) {
    watcherLogger?.warn({ err }, 'Tesla charge watcher: failed to fetch actual ComEd prices');
  }

  if (supplyAvgCents == null) {
    try {
      const cur = await fetchCurrentHourPrice();
      if (cur.length) supplyAvgCents = cur[cur.length - 1].price;
    } catch { /* ignore */ }
  }

  const kwhUsed = snapshot?.kwh_used ?? null;
  const baseRateCents = getComedBaseRateCents();
  let hourlyCostDollars = null;
  let fixedRateCostDollars = null;
  let hourlySavingsDollars = null;

  if (kwhUsed != null && supplyAvgCents != null) {
    hourlyCostDollars = ((supplyAvgCents + baseRateCents) * kwhUsed) / 100;
    const fixedTotalCents = COMED_FIXED_SUPPLY_CENTS + baseRateCents;
    fixedRateCostDollars = (fixedTotalCents * kwhUsed) / 100;
    hourlySavingsDollars = fixedRateCostDollars - hourlyCostDollars;
  }

  const suspect = snapshotFailed ? 1 : (snapshot?.suspect ?? 0);
  const suspectReason = snapshotFailed ? 'fleet_snapshot_failed' : (snapshot?.suspect_reason ?? null);

  db.prepare(`
    UPDATE tesla_sessions SET
      session_end             = ?,
      end_soc                 = COALESCE(?, end_soc),
      charge_energy_added     = COALESCE(?, charge_energy_added),
      kwh_used                = COALESCE(?, kwh_used),
      efficiency_pct          = COALESCE(?, efficiency_pct),
      charger_voltage         = COALESCE(?, charger_voltage),
      charger_actual_current  = COALESCE(?, charger_actual_current),
      avg_charger_voltage     = ?,
      max_charger_voltage     = ?,
      avg_charger_current     = ?,
      max_charger_current     = ?,
      hourly_cost_dollars     = ?,
      fixed_rate_cost_dollars = ?,
      hourly_savings_dollars  = ?,
      actual_prices_json      = COALESCE(?, actual_prices_json),
      suspect                 = ?,
      suspect_reason          = COALESCE(suspect_reason, ?)
    WHERE id = ?
  `).run(
    sessionEnd,
    snapshot?.end_soc ?? null,
    snapshot?.charge_energy_added ?? null,
    snapshot?.kwh_used ?? null,
    snapshot?.efficiency_pct ?? null,
    snapshot?.charger_voltage ?? null,
    snapshot?.charger_actual_current ?? null,
    stats?.avg_voltage ?? null,
    stats?.max_voltage ?? null,
    stats?.avg_current ?? null,
    stats?.max_current ?? null,
    hourlyCostDollars,
    fixedRateCostDollars,
    hourlySavingsDollars,
    supplyEntries.length ? JSON.stringify(supplyEntries) : null,
    suspect,
    suspectReason,
    sessionId,
  );

  db.prepare(`DELETE FROM tesla_readings WHERE vin = ?`).run(vin);

  watcherLogger?.info(
    { vin, sessionId: Number(sessionId) },
    'Tesla charge watcher: session %d closed for %s',
    Number(sessionId), vin,
  );
}

async function pollChargeState() {
  for (const { vin, teslamate_car_id: carId } of vinConfigMap) {
    const state = getCarState(carId);
    if (!state) continue;

    const currentChargingState = state.charging_state ?? null;
    const wasCharging = prevChargingState[vin] === 'Charging';
    const isCharging = currentChargingState === 'Charging';

    if (!wasCharging && isCharging) {
      if (activeSessionId[vin] != null) {
        prevChargingState[vin] = currentChargingState;
        continue;
      }

      const sessionStartMs = Date.now();
      const startSoc = state.battery_level ?? null;

      const result = db.prepare(`
        INSERT INTO tesla_sessions (vin, source, session_start, start_soc, mqtt_detected)
        VALUES (?, 'mqtt', ?, ?, 1)
      `).run(vin, sessionStartMs, startSoc);

      activeSessionId[vin] = result.lastInsertRowid;
      activeSessionStart[vin] = sessionStartMs;
      insertReadingRow(vin, state);

      watcherLogger?.info(
        { vin, sessionId: Number(result.lastInsertRowid), startSoc },
        'Tesla charge watcher: charge started for %s (id=%d)',
        vin, Number(result.lastInsertRowid),
      );
    } else if (wasCharging && !isCharging) {
      const sessionId = activeSessionId[vin];
      const sessionStartMs = activeSessionStart[vin];
      if (sessionId != null) {
        await handleChargeEnd(vin, sessionId, sessionStartMs);
      }
      delete activeSessionId[vin];
      delete activeSessionStart[vin];
    } else if (isCharging && activeSessionId[vin] != null) {
      insertReadingRow(vin, state);
    }

    prevChargingState[vin] = currentChargingState;
  }
}

export function startTeslaChargeWatcher(logger) {
  watcherLogger = logger;

  vinConfigMap = db.prepare(`
    SELECT vin, teslamate_car_id FROM tesla_config WHERE teslamate_car_id IS NOT NULL
  `).all();

  pollingInterval = setInterval(() => {
    pollChargeState().catch(err => {
      watcherLogger?.error({ err }, 'Tesla charge watcher: poll error');
    });
  }, 30_000);

  logger.info('Tesla charge watcher started (30 s poll)');
}

export function stopTeslaChargeWatcher() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  watcherLogger?.info('Tesla charge watcher stopped');
}
