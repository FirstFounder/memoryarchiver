import { useState } from 'react';
import { deleteJob } from '../api/jobs.js';
import { useJobStore } from '../store/jobStore.js';
import { ProgressBar } from './ProgressBar.jsx';

const STATUS_META = {
  pending:    { label: 'Queued',    dot: 'bg-slate-500',   bar: 'bg-slate-500' },
  processing: { label: 'Encoding', dot: 'bg-amber-400 animate-pulse', bar: 'bg-amber-400' },
  done:       { label: 'Done',      dot: 'bg-green-500',   bar: 'bg-green-500' },
  error:      { label: 'Error',     dot: 'bg-red-500',     bar: 'bg-red-500' },
};

function timeAgo(unixSecs) {
  if (!unixSecs) return 'just now';
  const diff = Math.floor(Date.now() / 1000) - unixSecs;
  if (diff < 60)   return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function calcEta(job) {
  if (job.status !== 'processing' || !job.progress || job.progress <= 0.05) return null;
  const elapsed = job.updated_at - job.created_at;
  if (elapsed <= 0) return null;
  const rate = job.progress / elapsed;
  if (!rate || !isFinite(rate)) return null;
  const remaining = (1 - job.progress) / rate;
  if (remaining <= 0 || !isFinite(remaining) || remaining > 86400) return null;
  return remaining;
}

function formatEta(seconds) {
  if (seconds >= 120) return `ETA ~${Math.round(seconds / 60)}m`;
  if (seconds >= 60)  return 'ETA ~1 min';
  return 'ETA < 1 min';
}

/**
 * Single row in the job queue panel.
 * Props:
 *   job — job object from the store
 */
export function JobCard({ job }) {
  const removeJob = useJobStore(s => s.removeJob);
  const [deleting, setDeleting]         = useState(false);
  const [forceConfirm, setForceConfirm] = useState(false);
  const [forceError, setForceError]     = useState(null);

  const meta = STATUS_META[job.status] ?? STATUS_META.pending;
  const isProcessing = job.status === 'processing';
  const canDelete = !isProcessing;

  async function handleDelete() {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteJob(job.id);
      removeJob(job.id);
    } catch {
      setDeleting(false);
    }
  }

  async function handleForceDelete() {
    if (deleting) return;
    setDeleting(true);
    setForceConfirm(false);
    try {
      await deleteJob(job.id);
      removeJob(job.id);
    } catch (err) {
      setDeleting(false);
      if (err.status === 409) {
        setForceError('Job is actively encoding — wait for it to finish');
        setTimeout(() => setForceError(null), 3000);
      }
    }
  }

  const eta = calcEta(job);

  return (
    <div className="bg-slate-800/60 rounded-xl border border-slate-700 p-4 space-y-2">
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-slate-100 text-sm font-mono truncate" title={job.output_filename}>
            {job.output_filename ?? '(computing…)'}
          </p>
          <p className="text-slate-500 text-xs mt-0.5 truncate">
            {job.short_desc}
            <span className="mx-1.5 text-slate-700">·</span>
            {job.output_dest === 'fam' ? 'Fam' : 'Vault'}
            <span className="mx-1.5 text-slate-700">·</span>
            {timeAgo(job.created_at)}
          </p>
        </div>

        {/* Status badge */}
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
          <span className="text-xs text-slate-400">{meta.label}</span>
        </div>
      </div>

      {/* Progress bar (shown for encoding and done) */}
      {(job.status === 'processing' || job.status === 'done') && (
        <div>
          <ProgressBar value={job.progress ?? 0} color={meta.bar} />
          {job.status === 'processing' && (
            <p className="text-slate-500 text-xs mt-1 text-right">
              {Math.round((job.progress ?? 0) * 100)}%
              {eta != null && (
                <>
                  <span className="mx-1.5 text-slate-700">·</span>
                  {formatEta(eta)}
                </>
              )}
            </p>
          )}
        </div>
      )}

      {/* Error message */}
      {job.status === 'error' && job.error_msg && (
        <p className="text-red-400 text-xs font-mono break-all bg-red-950/40 rounded p-2">
          {job.error_msg}
        </p>
      )}

      {/* Delete button — terminal states */}
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

      {/* Force Remove — processing state */}
      {isProcessing && (
        <div className="flex justify-end items-center gap-2">
          {forceError ? (
            <span className="text-xs text-red-400">{forceError}</span>
          ) : forceConfirm ? (
            <>
              <span className="text-xs text-slate-400">Kill job?</span>
              <button
                onClick={handleForceDelete}
                disabled={deleting}
                className="text-xs text-amber-400 hover:text-amber-300 transition-colors disabled:opacity-40"
              >
                Yes
              </button>
              <button
                onClick={() => setForceConfirm(false)}
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
              >
                No
              </button>
            </>
          ) : (
            <button
              onClick={() => setForceConfirm(true)}
              disabled={deleting}
              className="text-xs text-amber-600 hover:text-amber-400 transition-colors disabled:opacity-40"
            >
              {deleting ? 'Removing…' : 'Force Remove'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
