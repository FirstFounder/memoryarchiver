import { apiFetch } from './client.js';

export const getAppConfig = () => apiFetch('/api/config');
