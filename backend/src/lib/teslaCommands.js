import { fleetFetch } from './teslaAuth.js';

export async function addChargeSchedule(vin, { startHour, startMinute, endHour, endMinute }) {
  return fleetFetch(`/api/1/vehicles/${vin}/command/add_charge_schedule`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      enable: true,
      start_time: (startHour * 60) + startMinute,
      end_time: (endHour * 60) + endMinute,
    }),
  });
}

export async function setChargingAmps(vin, amps) {
  return fleetFetch(`/api/1/vehicles/${vin}/command/set_charging_amps`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      charging_amps: amps,
    }),
  });
}

export async function setChargeLimit(vin, pct) {
  return fleetFetch(`/api/1/vehicles/${vin}/command/set_charge_limit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      percent: Math.round(pct),
    }),
  });
}
