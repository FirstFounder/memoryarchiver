import { apiFetch } from './client.js';

export const getDestinations = () =>
  apiFetch('/api/hub/destinations');

export const patchDestination = (id, body) =>
  apiFetch(`/api/hub/destinations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export const triggerSync = (id) =>
  apiFetch(`/api/hub/destinations/${id}/sync`, { method: 'POST' });

export const getSyncHistory = (params = {}) => {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))
  ).toString();
  return apiFetch(`/api/hub/sync-history${qs ? '?' + qs : ''}`);
};
