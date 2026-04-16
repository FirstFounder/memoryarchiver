import config from '../config.js';
import db from '../db/client.js';

function getAuthRow() {
  return db.prepare(`
    SELECT id, client_id, client_secret, access_token, refresh_token, access_token_expires_at
    FROM tesla_auth
    WHERE id = 1
  `).get();
}

function resolveCredentialRow() {
  const row = getAuthRow() ?? { id: 1 };
  return {
    ...row,
    client_id: row.client_id ?? config.teslaClientId ?? '',
    client_secret: row.client_secret ?? config.teslaClientSecret ?? '',
  };
}

function parseJsonOrNull(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function hasCredentials() {
  const row = getAuthRow();
  return Boolean(row?.refresh_token);
}

export async function saveCredentials({ clientId, clientSecret, refreshToken }) {
  db.prepare(`
    UPDATE tesla_auth
    SET client_id = ?,
        client_secret = ?,
        refresh_token = ?,
        access_token = NULL,
        access_token_expires_at = NULL,
        updated_at = ?
    WHERE id = 1
  `).run(
    clientId?.trim() || null,
    clientSecret?.trim() || null,
    refreshToken?.trim() || null,
    Date.now(),
  );
}

export async function getValidAccessToken() {
  const row = resolveCredentialRow();

  if (!row.refresh_token) {
    throw new Error('Tesla credentials not configured');
  }
  if (!row.client_id || !row.client_secret) {
    throw new Error('Tesla client credentials not configured');
  }
  if (
    row.access_token
    && row.access_token_expires_at
    && row.access_token_expires_at > Date.now() + (30 * 60 * 1000)
  ) {
    return row.access_token;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: row.client_id,
    client_secret: row.client_secret,
    refresh_token: row.refresh_token,
  });

  const response = await fetch(`${config.teslaAuthBase}/oauth2/v3/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const rawText = await response.text();
  const payload = parseJsonOrNull(rawText);

  if (!response.ok) {
    const errorBody = payload ? JSON.stringify(payload) : rawText;
    throw new Error(`Tesla token refresh failed: ${response.status} ${errorBody}`);
  }

  const accessToken = payload?.access_token;
  const refreshToken = payload?.refresh_token ?? row.refresh_token;
  const expiresIn = Number(payload?.expires_in ?? 0);

  if (!accessToken || !expiresIn) {
    throw new Error('Tesla token refresh failed: invalid response payload');
  }

  db.prepare(`
    UPDATE tesla_auth
    SET client_id = ?,
        client_secret = ?,
        access_token = ?,
        refresh_token = ?,
        access_token_expires_at = ?,
        updated_at = ?
    WHERE id = 1
  `).run(
    row.client_id,
    row.client_secret,
    accessToken,
    refreshToken,
    Date.now() + (expiresIn * 1000),
    Date.now(),
  );

  return accessToken;
}

export async function fleetFetch(path, options = {}) {
  const token = await getValidAccessToken();
  const headers = new Headers(options.headers ?? {});
  headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(`${config.teslaFleetApiBase}${path}`, {
    ...options,
    headers,
  });

  const rawText = await response.text();
  const payload = parseJsonOrNull(rawText);

  if (!response.ok) {
    const errorBody = payload ? JSON.stringify(payload) : rawText;
    throw new Error(`Tesla Fleet API request failed: ${response.status} ${errorBody}`);
  }

  return payload ?? rawText;
}
