/**
 * Upload one or more .MOV File objects to the backend temp staging area.
 * Returns an array of file metadata objects (one per file).
 *
 * @param {File[]} files
 * @returns {Promise<Array<{tempPath,origName,duration,width,height,fps,createdTs}>>}
 */
export async function uploadFiles(files) {
  const form = new FormData();
  for (const f of files) form.append('files', f);

  const res = await fetch('/api/upload', { method: 'POST', body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Upload failed: HTTP ${res.status}`);
  }
  return res.json();
}
