import { apiFetch } from './client.js';

export const importAll = () =>
  apiFetch('/api/receipts/import-all', { method: 'POST' });

export const getReceipts = (params = {}) => {
  const qs = new URLSearchParams();
  if (params.page)      qs.set('page',      params.page);
  if (params.limit)     qs.set('limit',     params.limit);
  if (params.store)     qs.set('store',     params.store);
  if (params.status)    qs.set('status',    params.status);
  if (params.date_from) qs.set('date_from', params.date_from);
  if (params.date_to)   qs.set('date_to',   params.date_to);
  const q = qs.toString();
  return apiFetch(`/api/receipts${q ? '?' + q : ''}`);
};

export const getFlagged = () => apiFetch('/api/receipts/flagged');

export const getReceipt = (id) => apiFetch(`/api/receipts/${id}`);

export const deleteReceipt = (id) =>
  apiFetch(`/api/receipts/${id}`, { method: 'DELETE' });

export const reImport = (id) =>
  apiFetch(`/api/receipts/${id}/re-import`, { method: 'POST' });
