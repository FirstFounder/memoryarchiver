import { apiFetch } from './client.js';

export const getJobs = () => apiFetch('/api/jobs');

export const getJob = (id) => apiFetch(`/api/jobs/${id}`);

/**
 * @param {{
 *   files: Array<{path,duration?,width?,height?,fps?,createdTs?}>,
 *   shortDesc: string,
 *   longDesc: string,
 *   outputDest: 'fam'|'vault'
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
