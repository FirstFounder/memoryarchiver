import { useState, useEffect } from 'react';
import { patchDestination, triggerSync } from '../../api/hub.js';
import { ProgressSection } from './ProgressSection.jsx';
import { ScheduleDrawer } from './ScheduleDrawer.jsx';

const SCHEDULE_LABELS = {
  '30 23 * * *':  'Nightly at 11:30 PM',
  '30 23 * * 0':  'Weekly — Sunday',
  '30 23 1 * *':  'Monthly — 1st',
};

const STATUS_META = {
  idle:     { label: 'Idle',     cls: 'bg-slate-700/80 text-slate-400'           },
  running:  { label: 'Running',  cls: 'bg-sky-900/70 text-sky-300 animate-pulse' },
  skipped:  { label: 'Skipped',  cls: 'bg-amber-900/60 text-amber-300'           },
  error:    { label: 'Error',    cls: 'bg-red-900/60 text-red-300'               },
  disabled: { label: 'Disabled', cls: 'bg-slate-800 text-slate-600'              },
};

function timeAgo(isoString) {
  if (!isoString) return null;
  const diff = Math.floor((Date.now() - new Date(isoString)) / 1000);
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function timeUntil(isoString) {
  if (!isoString) return null;
  const diff = new Date(isoString) - Date.now();
  if (diff <= 0) return 'soon';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d`;
  if (h > 0)   return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDuration(secs) {
  if (!secs) return null;
  if (secs < 60)   return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function scheduleLabel(cron) {
  return SCHEDULE_LABELS[cron] ?? cron ?? '—';
}

function TreeBadge({ label, status }) {
  const ok = status === 'done';
  return (
    <span
      className={`text-xs px-1.5 py-0.5 rounded border font-medium ${
        ok
          ? 'bg-green-900/40 border-green-800 text-green-400'
          : 'bg-slate-800 border-slate-700 text-slate-500'
      }`}
    >
      {label} {ok ? '✓' : '✗'}
    </span>
  );
}

export function DestinationCard({ destination, onRefresh }) {
  const live = destination._live ?? null;

  // Effective status: live SSE wins, then REST, then disabled
  const effectiveStatus = !destination.enabled
    ? 'disabled'
    : (live?.status === 'running' || live?.status === 'done' || live?.status === 'error' || live?.status === 'skipped'
        ? live.status
        : destination.status ?? 'idle');

  const meta = STATUS_META[effectiveStatus] ?? STATUS_META.idle;
  const isRunning = effectiveStatus === 'running';

  // Disk-sleep transient indicator
  const [diskSleepVisible, setDiskSleepVisible] = useState(false);
  useEffect(() => {
    if (live?.type === 'disk_sleep' || live?.type === 'disk_sleep_failed') {
      setDiskSleepVisible(true);
      const t = setTimeout(() => setDiskSleepVisible(false), 10_000);
      return () => clearTimeout(t);
    }
  }, [live?.type, live?.updatedAt]);

  // Enable toggle
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  async function handleToggleEnabled() {
    if (togglingEnabled) return;
    setTogglingEnabled(true);
    try {
      await patchDestination(destination.id, { enabled: !destination.enabled });
      onRefresh();
    } catch { /* swallow */ } finally {
      setTogglingEnabled(false);
    }
  }

  // Trigger sync
  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState(null);
  async function handleTrigger() {
    if (triggering || isRunning) return;
    setTriggering(true);
    setTriggerError(null);
    try {
      await triggerSync(destination.id);
      onRefresh();
    } catch (err) {
      setTriggerError(err.message);
    } finally {
      setTriggering(false);
    }
  }

  // Schedule drawer
  const [drawerOpen, setDrawerOpen] = useState(false);

  const lastSync = destination.lastSync;
  const hasTreeBadges =
    lastSync &&
    (lastSync.famStatus != null || lastSync.vaultStatus != null) &&
    effectiveStatus !== 'running';

  return (
    <>
      <div className="bg-slate-800/60 rounded-xl border border-slate-700/60 p-4 flex flex-col gap-3">

        {/* Header: hostname · IP · enable toggle */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-slate-100 font-semibold text-base leading-tight truncate">
              {destination.hostname}
            </p>
            <p className="text-slate-500 text-xs mt-0.5">{destination.ip}</p>
          </div>
          <button
            onClick={handleToggleEnabled}
            disabled={togglingEnabled}
            title={destination.enabled ? 'Disable' : 'Enable'}
            className={`relative w-9 h-5 rounded-full transition-colors shrink-0 mt-0.5 ${
              destination.enabled ? 'bg-indigo-600' : 'bg-slate-700'
            } disabled:opacity-40`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                destination.enabled ? 'translate-x-4' : ''
              }`}
            />
          </button>
        </div>

        {/* Status pill */}
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${meta.cls}`}>
            {meta.label}
          </span>
          {diskSleepVisible && (
            <span className="text-xs text-slate-500 animate-pulse">💤 spinning down…</span>
          )}
        </div>

        {/* Schedule line */}
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <span>{scheduleLabel(destination.schedule)}</span>
          {destination.nextRun && (
            <span className="text-slate-600">· in {timeUntil(destination.nextRun)}</span>
          )}
          <button
            onClick={() => setDrawerOpen(true)}
            className="ml-auto text-slate-600 hover:text-slate-400 transition-colors"
            title="Edit schedule"
          >
            ✎
          </button>
        </div>

        {/* Last sync line */}
        {lastSync && (
          <div className="text-xs text-slate-500 flex items-center gap-1.5">
            <span>{timeAgo(lastSync.startedAt)}</span>
            {lastSync.duration && (
              <span className="text-slate-600">· {formatDuration(lastSync.duration)}</span>
            )}
            <span className="ml-auto">
              {lastSync.status === 'done'    && <span className="text-green-500">✓</span>}
              {lastSync.status === 'error'   && <span className="text-red-400">✗</span>}
              {lastSync.status === 'skipped' && <span className="text-amber-400">↷</span>}
            </span>
          </div>
        )}

        {/* Progress (running only) */}
        {isRunning && (
          <ProgressSection live={live} />
        )}

        {/* Per-tree badges (after completed jobs) */}
        {hasTreeBadges && (
          <div className="flex gap-2">
            {lastSync.famStatus   != null && <TreeBadge label="Fam"   status={lastSync.famStatus} />}
            {lastSync.vaultStatus != null && <TreeBadge label="Vault" status={lastSync.vaultStatus} />}
          </div>
        )}

        {/* Error message (only when status === 'error') */}
        {effectiveStatus === 'error' && (live?.error ?? lastSync?.errorMsg) && (
          <p className="text-red-400 text-xs font-mono break-all bg-red-950/40 rounded p-2">
            {live?.error ?? lastSync?.errorMsg}
          </p>
        )}

        {triggerError && (
          <p className="text-red-400 text-xs">{triggerError}</p>
        )}

        {/* Footer: Trigger now */}
        <div className="flex justify-end pt-1">
          <button
            onClick={handleTrigger}
            disabled={isRunning || triggering || !destination.enabled}
            className="text-xs px-3 py-1.5 rounded-lg border border-indigo-800 text-indigo-400 hover:bg-indigo-900/30 hover:border-indigo-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            {triggering ? 'Starting…' : 'Trigger now'}
          </button>
        </div>
      </div>

      {drawerOpen && (
        <ScheduleDrawer
          destination={destination}
          onClose={() => setDrawerOpen(false)}
          onSaved={onRefresh}
        />
      )}
    </>
  );
}
