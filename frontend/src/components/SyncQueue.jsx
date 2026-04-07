import { useState } from 'react';
import { triggerFullSync } from '../api/sync.js';
import { useSyncJobs } from '../hooks/useSyncJobs.js';
import { SyncJobCard } from './SyncJobCard.jsx';

export function SyncQueue() {
  const { syncJobs, loading, error, refresh } = useSyncJobs();

  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState(null);

  const activeSyncs = syncJobs.filter(j => j.status === 'syncing').length;
  const pendingSyncs = syncJobs.filter(j => j.status === 'pending').length;

  async function handleSyncAll() {
    setTriggering(true);
    setTriggerError(null);
    try {
      await triggerFullSync();
      // Refresh to pick up both new Fam and Vault pending cards from the server
      refresh();
    } catch (err) {
      // 409 = already queued — not really an error worth alarming about
      if (!err.message.includes('already')) {
        setTriggerError(err.message);
      }
      refresh();
    } finally {
      setTriggering(false);
    }
  }

  return (
    <div className="flex flex-col">
      {/* Section header */}
      <div className="flex items-center justify-between mb-3 pt-4 border-t border-slate-800">
        <div className="flex items-center gap-3">
          <h2 className="text-slate-200 font-semibold text-sm">Sync Queue</h2>
          <div className="flex gap-2 text-xs text-slate-500">
            {activeSyncs > 0 && (
              <span className="text-sky-400">{activeSyncs} syncing</span>
            )}
            {pendingSyncs > 0 && (
              <span>{pendingSyncs} queued</span>
            )}
          </div>
        </div>

        <button
          onClick={handleSyncAll}
          disabled={triggering}
          title="Queue a full rsync of /volume1/RFA → noahRFA (5 Mbps limit)"
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-sky-800 text-sky-400 hover:bg-sky-900/30 hover:border-sky-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <span>↕</span>
          {triggering ? 'Queuing…' : 'Sync All'}
        </button>
      </div>

      {triggerError && (
        <p className="text-red-400 text-xs mb-2">{triggerError}</p>
      )}

      {/* Job list */}
      <div className="space-y-2">
        {loading && (
          <p className="text-slate-500 text-sm text-center py-4">Loading…</p>
        )}
        {error && (
          <p className="text-red-400 text-sm text-center py-4">{error}</p>
        )}
        {!loading && syncJobs.length === 0 && (
          <p className="text-slate-600 text-xs text-center py-4">
            Sync jobs appear here automatically after encoding completes.
          </p>
        )}
        {syncJobs.map(job => (
          <SyncJobCard key={job.id} job={job} />
        ))}
      </div>
    </div>
  );
}
