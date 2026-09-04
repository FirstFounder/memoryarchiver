import { apiFetch } from './client.js';

export const getJobs = () => apiFetch('/api/jobs');

export const getJob = (id) => apiFetch(`/api/jobs/${id}`);

/**
 * @param {{
 *   files: Array<{path,duration?,width?,height?,fps?,createdTs?}>,
 *   shortDesc: string,
 *   longDesc: string,
 *   outputDest: 'fam'|'vault',
 *   schedule?: 'night'|'now'
 * }} payload
 */
export const submitJob = (payload) =>
  apiFetch('/api/jobs', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });

export const deleteJob = (id) =>
  apiFetch(`/api/jobs/${id}`, { method: 'DELETE' });

/**
 * Move a job between the nightly queue and the run-now queue.
 * @param {number} id
 * @param {'now'|'night'} mode
 */
export const setJobSchedule = (id, mode) =>
  apiFetch(`/api/jobs/${id}/schedule`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ mode }),
  });
