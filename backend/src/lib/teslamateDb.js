/**
 * TeslaMate integration — NOT YET FUNCTIONAL
 *
 * TeslaMate will be installed on iolo (192.168.106.7) and stores all vehicle
 * telemetry in a PostgreSQL database. Once running, this module will query it
 * directly for historical charge sessions, enabling:
 *   - Pack capacity derivation from full historical session data
 *   - Backfill from TeslaFI CSV export (imported into TeslaMate)
 *   - Intra-day session capture (Phase 3)
 *   - Time-series voltage/current data (Phase 3)
 *
 * Relevant TeslaMate schema:
 *   charging_processes (id, car_id, start_date, end_date, charge_energy_added,
 *                       start_ideal_range_km, end_ideal_range_km, duration_min,
 *                       outside_temp_avg, position_id)
 *   charges (id, charging_process_id, date, battery_level, ideal_battery_range_km,
 *            charger_power, charger_voltage, charger_phases, charger_actual_current,
 *            charge_energy_added, outside_temp)
 *   cars (id, vin, name, model, trim_badging)
 *
 * Connection: configure TESLAMATE_DB_URL in .env when TeslaMate is running.
 * Format: postgres://user:password@192.168.106.7:5432/teslamate
 *
 * Session shape returned by queryChargingSessions() will match the normalized
 * shape used by fleetSessionFetch.js so that packCapacity.js is source-agnostic.
 */

const TESLAMATE_DB_URL = process.env.TESLAMATE_DB_URL;

export async function queryChargingSessions(_vin, _opts = {}) {
  throw new Error(
    'TeslaMate integration not yet configured. '
    + 'Set TESLAMATE_DB_URL in .env once TeslaMate is running on iolo.',
  );
}

export function isTeslamateConfigured() {
  return Boolean(TESLAMATE_DB_URL);
}
