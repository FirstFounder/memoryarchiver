import { apiFetch } from './client.js';

export function getAudioFiles(status) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return apiFetch(`/api/audio/files${qs}`);
}

export function getAudioFile(id) {
  return apiFetch(`/api/audio/files/${id}`);
}

export function queueAudioFile(id) {
  return apiFetch(`/api/audio/files/${id}/queue`, { method: 'POST' });
}

export function searchAudio(q) {
  return apiFetch(`/api/audio/search?q=${encodeURIComponent(q)}`);
}

export function ingestAudioFile(file) {
  const form = new FormData();
  form.append('file', file);
  return apiFetch('/api/audio/ingest', { method: 'POST', body: form });
}

export function triggerBatchImport(queueAll = false) {
  return apiFetch('/api/audio/batch-import', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ queueAll }),
  });
}

export function exportUrl(id) {
  return `/api/audio/files/${id}/export`;
}

export function streamUrl(id) {
  return `/api/audio/files/${id}/stream`;
}
