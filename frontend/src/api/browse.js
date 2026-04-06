import { apiFetch } from './client.js';

/**
 * List directory contents under the NAS scratch root.
 * @param {string} subpath  — relative path within the scratch root ('' for top level)
 */
export const browseDir = (subpath = '') =>
  apiFetch(`/api/browse?subpath=${encodeURIComponent(subpath)}`);
