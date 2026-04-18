import db from '../db/client.js';
import { fetchActualPrices } from './coMedPrices.js';
import { buildSessionRecord, fetchSessionSnapshot } from './fleetSessionFetch.js';
import { maybeUpdatePackCapacity } from './packCapacity.js';

const CHICAGO_TIMEZONE = 'America/Chicago';
const PLAN_LOOKBACK_MS = 20 * 60 * 60 * 1000;

function getActiveVehicles() {
  return db.prepare(`
    SELECT vin, display_name, nickname
    FROM tesla_config
    WHERE mode = 'active'
    ORDER BY created_at, id
  `).all();
}

function getVehicle(vin) {
  return db.prepare(`
    SELECT vin, display_name, nickname, mode
    FROM tesla_config
    WHERE vin = ?
  `).get(vin);
}

function getLatestPlanRow(vin) {
  return db.prepare(`
    SELECT *
    FROM tesla_plans
    WHERE vin = ?
      AND status IN ('active', 'applied')
      AND computed_at >= ?
    ORDER BY computed_at DESC, id DESC
    LIMIT 1
  `).get(vin, Date.now() - PLAN_LOOKBACK_MS);
}

function getChicagoParts(millisUTC) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date(millisUTC));

  const record = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return {
    dateKey: `${record.year}-${record.month}-${record.day}`,
    hour: Number(record.hour),
  };
}

function getDateKeyInChicago(millisUTC = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CHICAGO_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(millisUTC));
}

function filterPricesForPreviousDay(prices) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const previousDayKey = getDateKeyInChicago(yesterday.getTime());
  return prices.filter(entry => getChicagoParts(entry.millisUTC).dateKey === previousDayKey);
}

function filterPricesForPlanWindow(prices, plan) {
  if (!plan?.window_start || !plan?.window_end) {
    return filterPricesForPreviousDay(prices);
  }

  const [startHour = 0] = String(plan.window_start).split(':').map(Number);
  const [endHour = 0] = String(plan.window_end).split(':').map(Number);
  const planDateKey = getDateKeyInChicago(plan.computed_at ?? Date.now());
  const nextDay = new Date(plan.computed_at ?? Date.now());
  nextDay.setDate(nextDay.getDate() + 1);
  const nextDayKey = getDateKeyInChicago(nextDay.getTime());

  return prices.filter((entry) => {
    const local = getChicagoParts(entry.millisUTC);
    if (startHour < endHour) {
      return local.dateKey === planDateKey && local.hour >= startHour && local.hour < endHour;
    }

    return (
      (local.dateKey === planDateKey && local.hour >= startHour)
      || (local.dateKey === nextDayKey && local.hour < endHour)
    );
  });
}

function insertSession(record) {
  const keys = Object.keys(record);
  const placeholders = keys.map(() => '?').join(', ');
  const result = db.prepare(`
    INSERT INTO tesla_sessions (${keys.join(', ')})
    VALUES (${placeholders})
  `).run(...keys.map(key => record[key]));

  return db.prepare(`
    SELECT *
    FROM tesla_sessions
    WHERE id = ?
  `).get(Number(result.lastInsertRowid));
}

function updateCachedOdometer(vin, odometer) {
  db.prepare(`
    UPDATE tesla_config
    SET cached_odometer = COALESCE(?, cached_odometer),
        updated_at = ?
    WHERE vin = ?
  `).run(odometer, Date.now(), vin);
}

function labelForVehicle(vehicle) {
  return vehicle?.display_name ?? vehicle?.nickname ?? vehicle?.vin ?? 'vehicle';
}

async function runForVehicle(vehicle) {
  const plan = getLatestPlanRow(vehicle.vin);
  const snapshot = await fetchSessionSnapshot(vehicle.vin, plan);

  let actualPrices = null;
  try {
    const fetched = await fetchActualPrices();
    actualPrices = filterPricesForPlanWindow(fetched, plan);
  } catch (error) {
    console.error(`[morningPoller] ${labelForVehicle(vehicle)}: unable to load actual prices`, error);
  }

  const record = buildSessionRecord(vehicle.vin, snapshot, plan, actualPrices);
  const session = insertSession(record);

  if (snapshot.vehicle_odometer !== null) {
    updateCachedOdometer(vehicle.vin, Math.round(snapshot.vehicle_odometer));
  }

  const capacity = maybeUpdatePackCapacity(vehicle.vin);
  const actualCost = session.actual_cost_dollars === null ? null : Number(session.actual_cost_dollars);
  const kwhUsed = session.kwh_used === null ? null : Number(session.kwh_used);

  if (session.suspect) {
    console.info(`[morningPoller] ${labelForVehicle(vehicle)}: session logged (suspect: ${session.suspect_reason})`);
  } else {
    console.info(
      `[morningPoller] ${labelForVehicle(vehicle)}: session logged, kwh_used=${kwhUsed?.toFixed(2) ?? 'n/a'}, actual_cost=${actualCost === null ? 'n/a' : `$${actualCost.toFixed(2)}`}`,
    );
  }

  return {
    ok: true,
    session,
    capacity,
    planId: plan?.id ?? null,
  };
}

export async function runMorningPollForVin(vin) {
  const vehicle = getVehicle(vin);
  if (!vehicle) {
    throw new Error(`Unknown VIN: ${vin}`);
  }

  return runForVehicle(vehicle);
}

export async function runMorningPoll() {
  const vehicles = getActiveVehicles();
  const results = [];

  for (const vehicle of vehicles) {
    try {
      results.push(await runForVehicle(vehicle));
    } catch (error) {
      console.error(`[morningPoller] ${labelForVehicle(vehicle)}: fleet poll failed`, error);
      results.push({
        ok: false,
        vin: vehicle.vin,
        error: error.message,
      });
    }
  }

  return results;
}
