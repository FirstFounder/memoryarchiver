import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

export function CameraCard({ camera, baseUrl = '', onLabelSaved }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);

  // Label editing state
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(camera.label);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);

  // Focus input when editing starts
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // Keep draft in sync if parent refreshes label (e.g. after poll)
  useEffect(() => {
    if (!editing) setDraft(camera.label);
  }, [camera.label, editing]);

  async function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === camera.label) { setEditing(false); return; }
    setSaving(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/hub/cameras/${encodeURIComponent(camera.name)}/label`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: trimmed }),
        }
      );
      if (res.ok) {
        onLabelSaved?.(camera.name, trimmed);
        setEditing(false);
      }
    } catch { /* swallow — label stays as-is */ }
    finally { setSaving(false); }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') { setDraft(camera.label); setEditing(false); }
  }

  // HLS lifecycle
  useEffect(() => {
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    if (!camera.live || !camera.hlsUrl || !videoRef.current) return;

    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(camera.hlsUrl);
      hls.attachMedia(videoRef.current);
      hlsRef.current = hls;
    } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      videoRef.current.src = camera.hlsUrl;
    }

    return () => { if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; } };
  }, [camera.live, camera.hlsUrl]);

  return (
    <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        {editing ? (
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <input
              ref={inputRef}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              maxLength={64}
              className="flex-1 min-w-0 bg-slate-700 border border-slate-600 text-slate-100 text-sm rounded px-2 py-0.5 focus:outline-none focus:border-indigo-500"
            />
            <button
              onClick={handleSave}
              disabled={saving}
              className="text-xs text-indigo-400 hover:text-indigo-200 disabled:opacity-40 shrink-0"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => { setDraft(camera.label); setEditing(false); }}
              className="text-xs text-slate-500 hover:text-slate-300 shrink-0"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-slate-100 font-semibold text-base truncate">
              {camera.label}
            </span>
            <button
              onClick={() => { setDraft(camera.label); setEditing(true); }}
              className="text-slate-600 hover:text-slate-400 transition-colors text-sm shrink-0"
              title="Edit label"
            >
              ✎
            </button>
          </div>
        )}

        {/* LIVE / OFFLINE pill — always visible */}
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${
          camera.live
            ? 'bg-green-900/40 text-green-400'
            : 'bg-slate-800 text-slate-500'
        }`}>
          {camera.live ? 'LIVE' : 'OFFLINE'}
        </span>
      </div>

      {/* Player */}
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="w-full rounded aspect-video bg-black"
      />

      {/* Readers count — only when live and nonzero */}
      {camera.live && camera.readersCount > 0 && (
        <p className="text-xs text-slate-500">
          {camera.readersCount} viewer{camera.readersCount !== 1 ? 's' : ''}
        </p>
      )}
    </div>
  );
}
