import { apiFetch } from './client.js';

export function getReceipts(params = {}) {
  const qs = new URLSearchParams();
  if (params.vendor) qs.set('vendor', params.vendor);
  if (params.includeDeleted) qs.set('includeDeleted', '1');
  const q = qs.toString();
  return apiFetch(`/api/receipts${q ? '?' + q : ''}`);
}

export function getReceipt(id) {
  return apiFetch(`/api/receipts/${id}`);
}

export function getReceiptItems(id) {
  return apiFetch(`/api/receipts/${id}/items`);
}

export function deleteReceipt(id) {
  return apiFetch(`/api/receipts/${id}`, { method: 'DELETE' });
}

export function restoreReceipt(id) {
  return apiFetch(`/api/receipts/${id}/restore`, { method: 'POST' });
}

export function getVendors() {
  return apiFetch('/api/receipts/vendors');
}

export function getItemTypes(vendor) {
  const qs = vendor ? `?vendor=${encodeURIComponent(vendor)}` : '';
  return apiFetch(`/api/receipts/item-types${qs}`);
}

export function getPendingFiles() {
  return apiFetch('/api/receipts/pending');
}

export function uploadReceipt(file, vendorKey, force = false) {
  const form = new FormData();
  form.append('file', file);
  form.append('vendorKey', vendorKey);
  const qs = force ? '?force=1' : '';
  return apiFetch(`/api/receipts/upload${qs}`, { method: 'POST', body: form });
}

export function importPath(filename, vendorKey, force = false) {
  const qs = force ? '?force=1' : '';
  return apiFetch(`/api/receipts/import-path${qs}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ filename, vendorKey }),
  });
}
