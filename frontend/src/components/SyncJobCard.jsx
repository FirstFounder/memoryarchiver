import { useState } from 'react';
import { deleteSyncJob } from '../api/sync.js';
import { useSyncStore } from '../store/syncStore.js';
import { ProgressBar } from './ProgressBar.jsx';

const STATUS_META = {
  pending: { label: 'Queued',   dot: 'bg-slate-500',              bar: 'bg-slate-500' },
  syncing: { label: 'Syncing',  dot: 'bg-sky-400 animate-pulse',  bar: 'bg-sky-400'   },
  done:    { label: 'Synced',   dot: 'bg-green-500',              bar: 'bg-green-500' },
  error:   { label: 'Error',    dot: 'bg-red-500',                bar: 'bg-red-500'   },
};

function timeAgo(unixSecs) {
  if (!unixSecs) return 'just now';
  const diff = Math.floor(Date.now() / 1000) - unixSecs;
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/**
 * A sliding shimmer bar shown while rsync is scanning the file list.
 * Progress stays at 0% during this phase because rsync emits nothing
 * until it has walked the entire source and destination trees.
 */
function ScanningBar() {
  return (
    <div className="w-full bg-slate-700 rounded-full h-1.5 overflow-hidden relative">
      <div
        className="absolute inset-y-0 w-1/3 bg-sky-400/70 rounded-full animate-pulse"
        style={{ animation: 'scan-slide 1.8s ease-in-out infinite' }}
      />
      <style>{`
        @keyframes scan-slide {
          0%   { left: -33%; }
          100% { left: 100%; }
        }
      `}</style>
    </div>
  );
}

export function SyncJobCard({ job }) {
  const removeSyncJob = useSyncStore(s => s.removeSyncJob);
  const [deleting, setDeleting] = useState(false);

  const meta     = STATUS_META[job.status] ?? STATUS_META.pending;
  const canDelete = job.status !== 'syncing';
  const isTree   = job.type === 'tree';

  // rsync produces no output while it scans the file list.
  // Show a scanning animation until the first byte-level progress arrives.
  const isScanning = job.status === 'syncing' && (job.progress ?? 0) < 0.01;

  async function handleDelete() {
    if (!canDelete || deleting) return;
    setDeleting(true);
    try {
      await deleteSyncJob(job.id);
      removeSyncJob(job.id);
    } catch {
      setDeleting(false);
    }
  }

  return (
    <div className="bg-slate-800/60 rounded-xl border border-slate-700/60 p-3 space-y-2">
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {isTree && (
              <span className="text-xs bg-sky-900/60 text-sky-300 border border-sky-800 rounded px-1.5 py-0.5 font-medium shrink-0">
                Full
              </span>
            )}
            <p className="text-slate-200 text-sm font-mono truncate" title={job.label}>
              {job.label}
            </p>
          </div>
          <p className="text-slate-500 text-xs mt-0.5">
            {timeAgo(job.created_at)}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
          <span className="text-xs text-slate-400">
            {isScanning ? 'Scanning…' : meta.label}
          </span>
        </div>
      </div>

      {/* Progress area */}
      {(job.status === 'syncing' || job.status === 'done') && (
        <div>
          {isScanning ? (
            <>
              <ScanningBar />
              <p className="text-slate-600 text-xs mt-1 text-right">
                Building file list…
              </p>
            </>
          ) : (
            <>
              <ProgressBar value={job.progress ?? 0} color={meta.bar} />
              {job.status === 'syncing' && (
                <p className="text-slate-500 text-xs mt-1 text-right">
                  {Math.round((job.progress ?? 0) * 100)}%
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* Error */}
      {job.status === 'error' && job.error_msg && (
        <p className="text-red-400 text-xs font-mono break-all bg-red-950/40 rounded p-2">
          {job.error_msg}
        </p>
      )}

      {/* Remove */}
      {canDelete && (
        <div className="flex justify-end">
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="text-xs text-slate-600 hover:text-red-400 transition-colors disabled:opacity-40"
          >
            {deleting ? 'Removing…' : 'Remove'}
          </button>
        </div>
      )}
    </div>
  );
}
