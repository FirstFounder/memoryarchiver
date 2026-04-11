import { apiFetch } from './client.js';

export const getCoopStatus    = () => apiFetch('/api/coop/status');
export const coopOpen         = () => apiFetch('/api/coop/open',             { method: 'POST' });
export const coopClose        = () => apiFetch('/api/coop/close',            { method: 'POST' });
export const schedulerStart   = () => apiFetch('/api/coop/scheduler/start',  { method: 'POST' });
export const schedulerStop    = () => apiFetch('/api/coop/scheduler/stop',   { method: 'POST' });
export const getLastCoopCheck = () => apiFetch('/api/coop/last-check');
