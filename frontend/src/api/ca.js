import { apiFetch } from './client.js';

export function getCaStatus() {
  return apiFetch('/api/ca/status');
}
