import { apiFetch } from './client.js';

export async function getDevices() {
  return apiFetch('/api/maeving/devices');
}

export async function getDeviceState(id) {
  return apiFetch(`/api/maeving/devices/${id}/state`);
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
