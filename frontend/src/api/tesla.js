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

export async function setChargeLimit(vin, percent) {
  return apiFetch(`/api/tesla/vehicle/${encodeURIComponent(vin)}/charge-limit`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ percent }),
  });
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

export async function getSessions(vin, { limit = 10, offset = 0 } = {}) {
  return apiFetch(`/api/tesla/sessions/${encodeURIComponent(vin)}?limit=${limit}&offset=${offset}`);
}

export async function getCapacity(vin) {
  return apiFetch(`/api/tesla/capacity/${encodeURIComponent(vin)}`);
}

export async function getMqttState() {
  const res = await fetch('/api/tesla/mqtt/state');
  return res.json();
}

export async function getFleetApiCalls(months = 3) {
  return apiFetch(`/api/tesla/fleet-api-calls?months=${months}`);
}
