import { fleetFetch } from './teslaAuth.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isVehicleSleepError(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    message.includes('asleep')
    || message.includes('offline')
    || message.includes('vehicle unavailable')
    || message.includes('vehicle is currently in service')
    || message.includes('could_not_wake_buses')
  );
}

export async function ensureVehicleOnline(vin, { maxAttempts = 6, delayMs = 2_000 } = {}) {
  const info = await fleetFetch(`/api/1/vehicles/${vin}`);
  let state = info?.response?.state ?? 'offline';

  if (state === 'online') {
    return state;
  }

  await fleetFetch(`/api/1/vehicles/${vin}/wake_up`, { method: 'POST' });

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(delayMs);
    const next = await fleetFetch(`/api/1/vehicles/${vin}`);
    state = next?.response?.state ?? state;
    if (state === 'online') break;
  }

  return state;
}

export async function fetchVehicleData(vin, { wake = true } = {}) {
  if (wake) {
    await ensureVehicleOnline(vin);
  }
  return fleetFetch(`/api/1/vehicles/${vin}/vehicle_data`);
}
