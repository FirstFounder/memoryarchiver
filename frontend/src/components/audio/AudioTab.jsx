import { useState, useEffect, useRef, useCallback } from 'react';
import { useAudioStore } from '../../store/audioStore.js';
import {
  getAudioFiles, queueAudioFile, searchAudio,
  ingestAudioFile, triggerBatchImport, exportUrl, streamUrl,
} from '../../api/audio.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDuration(sec) {
  if (sec == null) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

const STATUS_BADGE = {
  pending:    'bg-slate-700 text-slate-300',
  queued:     'bg-blue-900 text-blue-300',
  processing: 'bg-amber-900 text-amber-300',
  done:       'bg-green-900 text-green-300',
  error:      'bg-red-900 text-red-300',
};

function StatusBadge({ status, startedAt }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (status !== 'processing') { setElapsed(0); return; }
    const t0 = startedAt ? new Date(startedAt).getTime() : Date.now();
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [status, startedAt]);

  const label = status === 'processing' && elapsed > 0
    ? `processing ${fmtDuration(elapsed)}`
    : status;

  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[status] ?? 'bg-slate-700 text-slate-300'}`}>
      {label}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function AudioTab() {
  const { files, loaded, setFiles, upsertFile } = useAudioStore();
  const [searchQ,     setSearchQ]     = useState('');
  const [searchResults, setSearchResults] = useState(null);  // null = not searching
  const [uploading,   setUploading]   = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [playingId,   setPlayingId]   = useState(null);
  const fileInputRef  = useRef(null);

  // Initial load
  useEffect(() => {
    if (loaded) return;
    getAudioFiles()
      .then(setFiles)
      .catch(err => console.error('[AudioTab] load error:', err));
  }, [loaded, setFiles]);

  // Search
  const runSearch = useCallback(async (q) => {
    if (!q.trim()) { setSearchResults(null); return; }
    try {
      const results = await searchAudio(q.trim());
      setSearchResults(results);
    } catch (err) {
      console.error('[AudioTab] search error:', err);
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => runSearch(searchQ), 300);
    return () => clearTimeout(id);
  }, [searchQ, runSearch]);

  const displayFiles = searchResults !== null ? searchResults : files;

  // Upload handler
  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setUploading(true);
    setUploadError(null);
    try {
      const record = await ingestAudioFile(file);
      upsertFile(record);
      // Auto-queue immediately after ingest
      const queued = await queueAudioFile(record.id);
      upsertFile(queued);
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function handleQueue(id) {
    try {
      const record = await queueAudioFile(id);
      upsertFile(record);
    } catch (err) {
      console.error('[AudioTab] queue error:', err);
    }
  }

  async function handleBatchImport() {
    try {
      await triggerBatchImport(false);
    } catch (err) {
      console.error('[AudioTab] batch import error:', err);
    }
  }

  return (
    <div className="flex flex-col gap-4">

      {/* ── Toolbar ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">

        {/* Upload */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="px-3 py-1.5 text-sm rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white transition-colors"
        >
          {uploading ? 'Uploading…' : 'Upload Voice Memo (.m4a)'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".m4a,audio/x-m4a,audio/mp4"
          className="hidden"
          onChange={handleUpload}
        />

        {/* Search */}
        <div className="flex-1 min-w-48">
          <input
            type="search"
            value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
            placeholder="Search transcripts…"
            className="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
        </div>

        {/* Batch import (admin) */}
        <button
          onClick={handleBatchImport}
          className="px-3 py-1.5 text-xs rounded-lg border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-colors"
        >
          Batch Import
        </button>
      </div>

      {uploadError && (
        <p className="text-red-400 text-sm">{uploadError}</p>
      )}

      {/* ── Table ────────────────────────────────────────────────────────────── */}
      {!loaded && !searchResults ? (
        <p className="text-slate-500 text-sm">Loading…</p>
      ) : displayFiles.length === 0 ? (
        <p className="text-slate-500 text-sm">
          {searchResults !== null ? 'No results.' : 'No audio files imported yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="text-slate-500 border-b border-slate-800">
                <th className="px-3 py-2 font-medium">File</th>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Duration</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayFiles.map(f => (
                <AudioRow
                  key={f.id}
                  file={f}
                  isPlaying={playingId === f.id}
                  onQueue={() => handleQueue(f.id)}
                  onPlay={() => setPlayingId(playingId === f.id ? null : f.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Single table row ──────────────────────────────────────────────────────────
function AudioRow({ file, isPlaying, onQueue, onPlay }) {
  const displayName = file.title
    ? `${file.original_name}\n${file.title}`
    : file.original_name;

  return (
    <>
      <tr className="border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors">
        <td className="px-3 py-2 text-slate-200 max-w-xs">
          <div className="truncate" title={file.original_name}>{file.original_name}</div>
          {file.title && (
            <div className="text-xs text-slate-500 truncate">{file.title}</div>
          )}
        </td>
        <td className="px-3 py-2 text-slate-400 whitespace-nowrap">
          {fmtDate(file.created_at_source)}
        </td>
        <td className="px-3 py-2 text-slate-400 whitespace-nowrap">
          {fmtDuration(file.duration_sec)}
        </td>
        <td className="px-3 py-2 whitespace-nowrap">
          <StatusBadge status={file.transcript_status} />
        </td>
        <td className="px-3 py-2">
          <div className="flex items-center gap-2">
            {file.transcript_status === 'done' && (
              <>
                <a
                  href={exportUrl(file.id)}
                  download
                  className="text-xs text-indigo-400 hover:text-indigo-300 border border-indigo-800 hover:border-indigo-600 px-2 py-0.5 rounded transition-colors"
                >
                  ↓ txt
                </a>
                <button
                  onClick={onPlay}
                  className="text-xs text-slate-400 hover:text-slate-200 border border-slate-700 hover:border-slate-500 px-2 py-0.5 rounded transition-colors"
                >
                  {isPlaying ? '■ stop' : '▶ play'}
                </button>
              </>
            )}
            {['pending', 'error'].includes(file.transcript_status) && (
              <button
                onClick={onQueue}
                className="text-xs text-blue-400 hover:text-blue-300 border border-blue-900 hover:border-blue-700 px-2 py-0.5 rounded transition-colors"
              >
                {file.transcript_status === 'error' ? 'Retry' : 'Queue'}
              </button>
            )}
            {file.transcript_status === 'error' && file.transcript_error && (
              <span
                className="text-xs text-red-400 cursor-help"
                title={file.transcript_error}
              >
                ⚠
              </span>
            )}
          </div>
        </td>
      </tr>
      {isPlaying && file.transcript_status === 'done' && (
        <tr className="border-b border-slate-800/60 bg-slate-900/60">
          <td colSpan={5} className="px-3 py-2">
            <audio
              controls
              autoPlay
              src={streamUrl(file.id)}
              className="w-full h-8"
              style={{ colorScheme: 'dark' }}
            />
          </td>
        </tr>
      )}
    </>
  );
}
