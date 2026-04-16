import { apiFetch } from './client.js';

export async function getVehicles() {
  return apiFetch('/api/tesla/vehicles');
}

export async function getVehicleStatus(vin) {
  return apiFetch(`/api/tesla/vehicle/${encodeURIComponent(vin)}/status`);
}

export async function pollVehicle(vin) {
  return apiFetch(`/api/tesla/vehicle/${encodeURIComponent(vin)}/poll`);
}

export async function submitManualEntry(vin, { socPct, chargeLimitPct, hpwcAmps }) {
  return apiFetch(`/api/tesla/vehicle/${encodeURIComponent(vin)}/manual-entry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      soc_pct: socPct,
      charge_limit_pct: chargeLimitPct,
      hpwc_amps: hpwcAmps,
    }),
  });
}

export async function getManualEntry(vin) {
  return apiFetch(`/api/tesla/vehicle/${encodeURIComponent(vin)}/manual-entry`);
}

export async function patchVehicleConfig(vin, patch) {
  return apiFetch(`/api/tesla/vehicle/${encodeURIComponent(vin)}/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function saveCredentials({ clientId, clientSecret, refreshToken }) {
  return apiFetch('/api/tesla/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret, refreshToken }),
  });
}

export async function getCredentialStatus() {
  return apiFetch('/api/tesla/credentials/status');
}
