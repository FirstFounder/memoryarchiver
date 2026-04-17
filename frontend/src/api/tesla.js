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

export async function getLatestPlan(vin) {
  return apiFetch(`/api/tesla/plan/${encodeURIComponent(vin)}`);
}

export async function getPlans(vin) {
  return apiFetch(`/api/tesla/plans/${encodeURIComponent(vin)}`);
}

export async function recomputePlan(vin) {
  return apiFetch(`/api/tesla/plan/${encodeURIComponent(vin)}/recompute`, {
    method: 'POST',
  });
}

export async function skipPlan(vin) {
  return apiFetch(`/api/tesla/plan/${encodeURIComponent(vin)}/skip`, {
    method: 'POST',
  });
}

export async function getSettings() {
  return apiFetch('/api/tesla/settings');
}

export async function patchSettings(patch) {
  return apiFetch('/api/tesla/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}
