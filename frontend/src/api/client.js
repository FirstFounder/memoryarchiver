/**
 * Thin fetch wrapper.  All API helpers import from here so the base URL and
 * error-handling logic live in one place.
 */
export async function apiFetch(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      message = body.error ?? body.message ?? message;
    } catch { /* non-JSON error body */ }
    throw new Error(message);
  }
  // 204 No Content
  if (res.status === 204) return null;
  return res.json();
}
