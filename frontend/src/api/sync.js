import { apiFetch } from './client.js';

export const getSyncJobs = () => apiFetch('/api/sync-jobs');

export const triggerFullSync = () =>
  apiFetch('/api/sync-jobs/trigger', { method: 'POST' });

export const deleteSyncJob = (id) =>
  apiFetch(`/api/sync-jobs/${id}`, { method: 'DELETE' });
