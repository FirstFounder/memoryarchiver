import db from '../db/client.js';
import { fetchVehicleData } from './teslaFleet.js';

const DEFAULT_LOSS_FACTOR = 0.88;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getPlanDurationHours(plan) {
  if (!plan?.window_start || !plan?.window_end) return null;

  const [startHour = 0, startMinute = 0] = String(plan.window_start).split(':').map(Number);
  const [endHour = 0, endMinute = 0] = String(plan.window_end).split(':').map(Number);
  if (
    !Number.isFinite(startHour) || !Number.isFinite(startMinute)
    || !Number.isFinite(endHour) || !Number.isFinite(endMinute)
  ) {
    return null;
  }

  const startMinutes = (startHour * 60) + startMinute;
  const endMinutes = (endHour * 60) + endMinute;
  let durationMinutes = endMinutes - startMinutes;
  if (durationMinutes <= 0) {
    durationMinutes += 24 * 60;
  }

  return durationMinutes > 0 ? durationMinutes / 60 : null;
}

function deriveWallKwh(chargeEnergyAdded, chargerPower, plan) {
  const durationHours = getPlanDurationHours(plan);
  if (durationHours && chargerPower > 0) {
    return chargerPower * durationHours;
  }
  if (chargeEnergyAdded > 0) {
    return chargeEnergyAdded / DEFAULT_LOSS_FACTOR;
  }
  return null;
}

function getSuspectReason({ chargingState, chargeEnergyAdded, endSoc }) {
  if (chargingState && !['Complete', 'Disconnected'].includes(chargingState)) {
    return 'charging_not_complete';
  }
  if (chargeEnergyAdded !== null && chargeEnergyAdded < 0.5) {
    return 'energy_added_implausible';
  }
  if (endSoc === null || endSoc === 0) {
    return 'end_soc_missing';
  }
  return null;
}

function averagePrice(prices) {
  if (!Array.isArray(prices) || !prices.length) return null;
  return prices.reduce((sum, entry) => sum + Number(entry.price ?? 0), 0) / prices.length;
}

function toSessionTimestamp(baseMillis, timeText, rollsNextDay = false) {
  if (!baseMillis || !timeText) return null;

  const base = new Date(baseMillis);
  const [hour = 0, minute = 0] = String(timeText).split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  const next = new Date(base);
  next.setHours(hour, minute, 0, 0);
  if (rollsNextDay) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

function deriveSessionWindow(plan) {
  if (!plan?.computed_at || !plan?.window_start || !plan?.window_end) {
    return { sessionStart: null, sessionEnd: null };
  }

  const [startHour = 0, startMinute = 0] = String(plan.window_start).split(':').map(Number);
  const [endHour = 0, endMinute = 0] = String(plan.window_end).split(':').map(Number);
  if (
    !Number.isFinite(startHour) || !Number.isFinite(startMinute)
    || !Number.isFinite(endHour) || !Number.isFinite(endMinute)
  ) {
    return { sessionStart: null, sessionEnd: null };
  }

  const rollsNextDay = (endHour * 60) + endMinute <= (startHour * 60) + startMinute;

  return {
    sessionStart: toSessionTimestamp(plan.computed_at, plan.window_start, false),
    sessionEnd: toSessionTimestamp(plan.computed_at, plan.window_end, rollsNextDay),
  };
}

export async function fetchSessionSnapshot(vin, plan = null) {
  const payload = await fetchVehicleData(vin, { wake: true });
  const chargeState = payload?.response?.charge_state ?? {};
  const vehicleState = payload?.response?.vehicle_state ?? {};

  const endSoc = toFiniteNumber(chargeState.battery_level);
  const chargeEnergyAdded = toFiniteNumber(chargeState.charge_energy_added);
  const chargerVoltage = toFiniteNumber(chargeState.charger_voltage);
  const chargerActualCurrent = toFiniteNumber(chargeState.charger_actual_current);
  const chargerPower = toFiniteNumber(chargeState.charger_power);
  const chargerPhases = toFiniteNumber(chargeState.charger_phases);
  const chargeLimitSoc = toFiniteNumber(chargeState.charge_limit_soc);
  const chargingState = chargeState.charging_state ?? null;
  const batteryHeaterOn = chargeState.battery_heater_on ? 1 : 0;

  // Fleet only gives us an end-of-session charger snapshot here, so we capture it
  // for later inspection but avoid treating it as a full-session time series.
  const kwhUsed = deriveWallKwh(chargeEnergyAdded, chargerPower, plan);
  const efficiencyPct = chargeEnergyAdded && kwhUsed
    ? clamp((chargeEnergyAdded / kwhUsed) * 100, 0, 100)
    : null;
  const suspectReason = getSuspectReason({ chargingState, chargeEnergyAdded, endSoc });

  return {
    end_soc: endSoc === null ? null : Math.round(endSoc),
    charge_energy_added: chargeEnergyAdded,
    kwh_used: kwhUsed,
    efficiency_pct: efficiencyPct,
    charger_voltage: chargerVoltage,
    charger_actual_current: chargerActualCurrent,
    charger_power: chargerPower,
    charger_phases: chargerPhases === null ? null : Math.round(chargerPhases),
    battery_heater_on: batteryHeaterOn,
    charge_limit_soc: chargeLimitSoc === null ? null : Math.round(chargeLimitSoc),
    charging_state: chargingState,
    suspect: suspectReason ? 1 : 0,
    suspect_reason: suspectReason,
    vehicle_odometer: toFiniteNumber(vehicleState.odometer),
  };
}

export function buildSessionRecord(vin, snapshot, plan, actualPrices) {
  const { sessionStart, sessionEnd } = deriveSessionWindow(plan);
  const predictedCost = plan && snapshot.kwh_used !== null && plan.price_window_avg_cents !== null
    ? (Number(plan.price_window_avg_cents) * Number(snapshot.kwh_used)) / 100
    : null;
  const actualAvgPrice = averagePrice(actualPrices);
  const actualCost = actualAvgPrice !== null && snapshot.kwh_used !== null
    ? (actualAvgPrice * Number(snapshot.kwh_used)) / 100
    : null;

  return {
    vin,
    plan_id: plan?.id ?? null,
    source: 'fleet',
    session_start: sessionStart,
    session_end: sessionEnd,
    start_soc: plan?.soc_at_set_time ?? null,
    end_soc: snapshot.end_soc ?? null,
    kwh_added: snapshot.charge_energy_added ?? null,
    charge_energy_added: snapshot.charge_energy_added ?? null,
    kwh_used: snapshot.kwh_used ?? null,
    efficiency_pct: snapshot.efficiency_pct ?? null,
    predicted_cost_dollars: predictedCost,
    actual_cost_dollars: actualCost,
    actual_prices_json: Array.isArray(actualPrices) ? JSON.stringify(actualPrices) : null,
    overnight_low_f: plan?.overnight_low_f ?? null,
    charger_voltage: snapshot.charger_voltage ?? null,
    charger_actual_current: snapshot.charger_actual_current ?? null,
    charger_power: snapshot.charger_power ?? null,
    charger_phases: snapshot.charger_phases ?? null,
    battery_heater_on: snapshot.battery_heater_on ?? 0,
    suspect: snapshot.suspect ?? 0,
    suspect_reason: snapshot.suspect_reason ?? null,
    created_at: Date.now(),
  };
}

export function getLatestFleetSessionCount(vin) {
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM tesla_sessions
    WHERE vin = ?
      AND source = 'fleet'
      AND suspect = 0
  `).get(vin)?.count ?? 0;
}
