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

export function SyncJobCard({ job }) {
  const removeSyncJob = useSyncStore(s => s.removeSyncJob);
  const [deleting, setDeleting] = useState(false);

  const meta = STATUS_META[job.status] ?? STATUS_META.pending;
  const canDelete = job.status !== 'syncing';
  const isTree = job.type === 'tree';

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
          <span className="text-xs text-slate-400">{meta.label}</span>
        </div>
      </div>

      {(job.status === 'syncing' || job.status === 'done') && (
        <div>
          <ProgressBar value={job.progress ?? 0} color={meta.bar} />
          {job.status === 'syncing' && (
            <p className="text-slate-500 text-xs mt-1 text-right">
              {Math.round((job.progress ?? 0) * 100)}%
            </p>
          )}
        </div>
      )}

      {job.status === 'error' && job.error_msg && (
        <p className="text-red-400 text-xs font-mono break-all bg-red-950/40 rounded p-2">
          {job.error_msg}
        </p>
      )}

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
