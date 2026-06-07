import { apiFetch } from './client.js';

export function getItems(profile) {
  return apiFetch(`/api/bugout/${profile}/items`);
}

export function createItem(profile, body) {
  return apiFetch(`/api/bugout/${profile}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function updateItem(profile, id, body) {
  return apiFetch(`/api/bugout/${profile}/items/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function deleteItem(profile, id) {
  return apiFetch(`/api/bugout/${profile}/items/${id}`, { method: 'DELETE' });
}

export function getActivities(profile) {
  return apiFetch(`/api/bugout/${profile}/activities`);
}

export function createActivity(profile, body) {
  return apiFetch(`/api/bugout/${profile}/activities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function updateActivity(profile, id, body) {
  return apiFetch(`/api/bugout/${profile}/activities/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function deleteActivity(profile, id) {
  return apiFetch(`/api/bugout/${profile}/activities/${id}`, { method: 'DELETE' });
}

export function getChecklist(profile) {
  return apiFetch(`/api/bugout/${profile}/checklist`);
}

export function upsertChecklist(profile, { entity_type, entity_id, is_checked, source, auto_from_activity_id }) {
  return apiFetch(`/api/bugout/${profile}/checklist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entity_type, entity_id, is_checked, source, auto_from_activity_id }),
  });
}

export function deleteChecklistEntry(profile, entity_type, entity_id) {
  return apiFetch(`/api/bugout/${profile}/checklist/${entity_type}/${entity_id}`, { method: 'DELETE' });
}

export function deleteAutoChecklistForActivity(profile, activity_id) {
  return apiFetch(`/api/bugout/${profile}/checklist/auto/${activity_id}`, { method: 'DELETE' });
}
