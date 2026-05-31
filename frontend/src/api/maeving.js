import { apiFetch } from './client.js';

export async function getDevices() {
  return apiFetch('/api/maeving/devices');
}

export async function getDeviceState(id) {
  return apiFetch(`/api/maeving/devices/${id}/state`);
}

export async function getLegs() {
  return apiFetch('/api/maeving/trips');
}

export async function createLeg(data) {
  return apiFetch('/api/maeving/trips', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function updateLeg(id, data) {
  return apiFetch(`/api/maeving/trips/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function deleteLeg(id) {
  return apiFetch(`/api/maeving/trips/${id}`, { method: 'DELETE' });
}

export async function toggleLegHidden(id, hidden) {
  return apiFetch(`/api/maeving/trips/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hidden }),
  });
}

export async function getActiveRide() {
  return apiFetch('/api/maeving/rides/active');
}

export async function getActiveRideLiveTelemetry() {
  return apiFetch('/api/maeving/rides/live-telemetry');
}

export async function getPendingRides() {
  return apiFetch('/api/maeving/rides/pending');
}

export async function startRide(data) {
  return apiFetch('/api/maeving/rides/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function finishRide(id, data = {}) {
  return apiFetch(`/api/maeving/rides/${id}/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function deleteRide(id) {
  return apiFetch(`/api/maeving/rides/${id}`, { method: 'DELETE' });
}

export async function updateRide(id, data) {
  return apiFetch(`/api/maeving/rides/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function startSession(data) {
  return apiFetch('/api/maeving/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function stopSession(id) {
  return apiFetch(`/api/maeving/sessions/${id}/stop`, {
    method: 'POST',
  });
}

export async function patchSession(id, data) {
  return apiFetch(`/api/maeving/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function scheduleOvernight(id, data) {
  return apiFetch(`/api/maeving/sessions/${id}/schedule-overnight`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function getSessions(params = {}) {
  const filtered = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null),
  );
  const q = new URLSearchParams(filtered).toString();
  return apiFetch(`/api/maeving/sessions${q ? `?${q}` : ''}`);
}

export async function getSession(id) {
  return apiFetch(`/api/maeving/sessions/${id}`);
}

export async function calibrateSession(id, actualSocPct) {
  return apiFetch(`/api/maeving/sessions/${id}/calibrate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actual_soc_pct: actualSocPct }),
  });
}

export async function getConfig() {
  return apiFetch('/api/maeving/config');
}

export async function getSessionTaper(id) {
  return apiFetch(`/api/maeving/sessions/${id}/taper`);
}

export async function skipCalibration(id) {
  return apiFetch(`/api/maeving/sessions/${id}/calibrate-skip`, {
    method: 'POST',
  });
}

export async function getRebelCost(miles) {
  const res = await fetch(`/api/maeving/rebel-cost?miles=${miles}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
